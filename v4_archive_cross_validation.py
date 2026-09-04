#!/usr/bin/env python3
# V4 CLEAN CORE — ARCHIVE CROSS-EXCHANGE VALIDATION V2
# TEST / READ-ONLY ONLY — NO ORDERS

from __future__ import annotations
import csv, hashlib, io, json, math, os, statistics, sys, time
import urllib.error, urllib.parse, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

VERSION = "V4_ARCHIVE_CROSS_VALIDATION_2"
MINUTE_MS = 60_000
INTERVAL_MS = 5 * MINUTE_MS
DAY_MS = 24 * 60 * MINUTE_MS
BINGX_BASES = ("https://open-api.bingx.com", "https://open-api.bingx.pro")
BINGX_KLINE_PATH = "/openApi/swap/v3/quote/klines"
BINANCE_ARCHIVE_BASE = "https://data.binance.vision/data/futures/um/daily/klines"
SYMBOLS = [s.strip().upper() for s in os.getenv("VAL_SYMBOLS", "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,ZEC-USDT").split(",") if s.strip()]
DAYS = int(os.getenv("VAL_DAYS", "30"))
BINGX_CHUNK_HOURS = int(os.getenv("VAL_BINGX_CHUNK_HOURS", "24"))
BINGX_LIMIT = int(os.getenv("VAL_BINGX_LIMIT", "500"))
BINGX_DELAY_SEC = float(os.getenv("VAL_BINGX_DELAY_SEC", "0.22"))
ARCHIVE_WORKERS = int(os.getenv("VAL_ARCHIVE_WORKERS", "8"))
MIN_SOURCE_COVERAGE = float(os.getenv("VAL_MIN_SOURCE_COVERAGE", "0.985"))
MIN_OVERLAP_COVERAGE = float(os.getenv("VAL_MIN_OVERLAP_COVERAGE", "0.985"))
TH = {
    "ret5": float(os.getenv("VAL_RET_CORR_5M_MIN", "0.98")),
    "ret15": float(os.getenv("VAL_RET_CORR_15M_MIN", "0.98")),
    "ret60": float(os.getenv("VAL_RET_CORR_60M_MIN", "0.97")),
    "dir5": float(os.getenv("VAL_DIR_MATCH_5M_MIN", "75")),
    "medDiff": float(os.getenv("VAL_MEDIAN_RETURN_DIFF_BPS_MAX", "5")),
    "range": float(os.getenv("VAL_RANGE_CORR_MIN", "0.90")),
    "vol": float(os.getenv("VAL_NORM_VOL_CORR_MIN", "0.50")),
    "spike": float(os.getenv("VAL_VOL_SPIKE_JACCARD_MIN", "0.30")),
}
ART = Path("artifacts")
JSON_PATH = ART / "v4_archive_cross_validation_summary.json"
CSV_PATH = ART / "v4_archive_cross_validation.csv"
UA = "V4-Archive-Cross-Validation/2.0"
CACHE = {}


def r(v, d=6):
    return None if v is None or not math.isfinite(v) else round(v, d)

def iso(ts):
    return datetime.fromtimestamp(ts/1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")

def binance_symbol(s):
    return s.replace("-", "")

def ts_ms(v):
    try: n = int(float(v))
    except Exception: return None
    return n // 1000 if n > 100_000_000_000_000 else n

def get_bytes(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()

def get_json(url):
    return json.loads(get_bytes(url).decode("utf-8"))

def archive_url(symbol, day):
    s = binance_symbol(symbol); d = day.strftime("%Y-%m-%d")
    return f"{BINANCE_ARCHIVE_BASE}/{s}/5m/{s}-5m-{d}.zip"

def fetch_archive(symbol, day):
    url = archive_url(symbol, day); csum_url = url + ".CHECKSUM"
    if url in CACHE:
        return CACHE[url]
    payload = get_bytes(url)
    csum_text = get_bytes(csum_url).decode("utf-8", errors="replace").strip()
    expected = csum_text.split()[0].lower()
    actual = hashlib.sha256(payload).hexdigest().lower()
    if len(expected) != 64 or actual != expected:
        raise RuntimeError(f"SHA256 verification failed for {symbol} {day.date()}")
    value = (payload, {"day": day.strftime("%Y-%m-%d"), "sha256": actual, "checksumVerified": True, "bytes": len(payload)})
    CACHE[url] = value
    return value

def latest_archive_day():
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    probe = SYMBOLS[0] if SYMBOLS else "BTC-USDT"
    for back in range(1, 8):
        day = today - timedelta(days=back)
        try:
            fetch_archive(probe, day)
            print(f"[ARCHIVE-DISCOVERY] {day.date()} available + checksum verified")
            return day
        except Exception as e:
            print(f"[ARCHIVE-DISCOVERY] {day.date()} unavailable: {e}")
    raise RuntimeError("No complete Binance archive day found in previous 7 UTC days")

def parse_archive(payload):
    out = []
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not names: raise RuntimeError("ZIP contains no CSV")
        with zf.open(names[0]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
            for row in csv.reader(text):
                if len(row) < 8: continue
                try:
                    t = ts_ms(row[0]); o,h,l,c,v,qv = map(float, (row[1],row[2],row[3],row[4],row[5],row[7]))
                except Exception: continue
                if t is None or c <= 0 or not all(math.isfinite(x) for x in (o,h,l,c,v,qv)): continue
                out.append({"openTime":t,"open":o,"high":h,"low":l,"close":c,"volume":v,"quoteVolume":qv})
    return out

def dedupe(rows):
    d = {x["openTime"]:x for x in rows if isinstance(x.get("openTime"), int)}
    return [d[k] for k in sorted(d)]

def fetch_binance_range(symbol, days, start, end):
    rows, metas = [], []
    with ThreadPoolExecutor(max_workers=max(1, ARCHIVE_WORKERS)) as pool:
        futs = {pool.submit(fetch_archive, symbol, day): day for day in days}
        for fut in as_completed(futs):
            day = futs[fut]
            try: payload, meta = fut.result()
            except Exception as e: raise RuntimeError(f"Archive download failed {symbol} {day.date()}: {e}") from e
            rows.extend(parse_archive(payload)); metas.append(meta)
    rows = [x for x in dedupe(rows) if start <= x["openTime"] <= end]
    metas.sort(key=lambda x:x["day"])
    return rows, metas

def norm_bingx(row):
    try:
        if isinstance(row, list):
            t=ts_ms(row[0]); o,h,l,c=map(float,row[1:5]); v=float(row[5]) if len(row)>5 else 0.0; qv=float(row[7]) if len(row)>7 and row[7] not in (None,"") else c*v
        else:
            t=ts_ms(row.get("openTime", row.get("time", row.get("ts")))); o=float(row["open"]); h=float(row["high"]); l=float(row["low"]); c=float(row["close"]); v=float(row.get("volume",0) or 0); q=row.get("quoteVolume",row.get("quoteAssetVolume")); qv=float(q) if q not in (None,"") else c*v
    except Exception: return None
    if t is None or c<=0 or not all(math.isfinite(x) for x in (o,h,l,c,v,qv)): return None
    return {"openTime":t,"open":o,"high":h,"low":l,"close":c,"volume":v,"quoteVolume":qv}

def bingx_get(params):
    query = urllib.parse.urlencode({k:str(v) for k,v in params.items()})
    last = None
    for base in BINGX_BASES:
        try: data = get_json(f"{base}{BINGX_KLINE_PATH}?{query}")
        except Exception as e: last=e; continue
        if isinstance(data, dict):
            if data.get("code") is not None and int(data.get("code")) != 0: raise RuntimeError(f"BingX {data.get('code')}: {data.get('msg', data.get('message','request failed'))}")
            return data.get("data", data)
        return data
    raise last or RuntimeError("BingX request failed")

def fetch_bingx_range(symbol, start, end):
    rows=[]; chunk_ms=BINGX_CHUNK_HOURS*60*MINUTE_MS; cursor=start
    while cursor<=end:
        chunk_end=min(end,cursor+chunk_ms-INTERVAL_MS)
        # endTime padding fixes the observed one-bar-per-chunk boundary loss.
        data=bingx_get({"symbol":symbol,"interval":"5m","startTime":cursor,"endTime":chunk_end+INTERVAL_MS,"limit":BINGX_LIMIT})
        if isinstance(data,list):
            for raw in data:
                x=norm_bingx(raw)
                if x: rows.append(x)
        print(f"[BINGX] {symbol} {iso(cursor)} -> {iso(chunk_end)} raw={len(data) if isinstance(data,list) else 0}")
        cursor=chunk_end+INTERVAL_MS; time.sleep(BINGX_DELAY_SEC)
    return [x for x in dedupe(rows) if start<=x["openTime"]<=end]

def expected_bars(start,end): return (end-start)//INTERVAL_MS+1

def coverage(rows,start,end):
    rows=[x for x in dedupe(rows) if start<=x["openTime"]<=end]; exp=expected_bars(start,end); cov=len(rows)/exp if exp else 0; max_gap=0; gaps=0
    for i in range(1,len(rows)):
        g=rows[i]["openTime"]-rows[i-1]["openTime"]; max_gap=max(max_gap,g); gaps += int(g>INTERVAL_MS)
    return {"rows":rows,"count":len(rows),"expected":exp,"coveragePct":r(cov*100,4),"gapCount":gaps,"maxGapMinutes":r(max_gap/MINUTE_MS,2),"complete":cov>=MIN_SOURCE_COVERAGE and (len(rows)<2 or max_gap<=2*INTERVAL_MS)}

def mean(x): return statistics.fmean(x) if x else None

def median(x): return statistics.median(x) if x else None

def pearson(xs,ys):
    if len(xs)!=len(ys) or len(xs)<3: return None
    mx,my=statistics.fmean(xs),statistics.fmean(ys); num=dx2=dy2=0.0
    for x,y in zip(xs,ys):
        dx=x-mx; dy=y-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy
    den=math.sqrt(dx2*dy2); return num/den if den>0 else None

def logret(a,b): return math.log(b/a) if a>0 and b>0 else None

def range_pct(row):
    mid=(row["high"]+row["low"])/2; return (row["high"]-row["low"])/mid if mid>0 else None

def pctile(vals,q):
    if not vals: return None
    s=sorted(vals); return s[min(len(s)-1,max(0,int((len(s)-1)*q)))]

def aligned(a,b):
    aa={x["openTime"]:x for x in a}; bb={x["openTime"]:x for x in b}; times=sorted(set(aa)&set(bb)); return [(t,aa[t],bb[t]) for t in times]

def step_returns(pairs,step):
    a=[]; b=[]
    for i in range(step,len(pairs)):
        if pairs[i][0]-pairs[i-step][0] != step*INTERVAL_MS: continue
        ra=logret(pairs[i-step][1]["close"],pairs[i][1]["close"]); rb=logret(pairs[i-step][2]["close"],pairs[i][2]["close"])
        if ra is not None and rb is not None: a.append(ra); b.append(rb)
    return a,b

def norm_vol(values,lookback=288):
    out=[]
    for i,v in enumerate(values):
        if i<lookback: out.append(None); continue
        hist=[x for x in values[i-lookback:i] if x>0 and math.isfinite(x)]
        if not hist or v<=0: out.append(None); continue
        base=statistics.median(hist); out.append(math.log(v/base) if base>0 else None)
    return out

def compare(a,b,start,end):
    pairs=aligned(a,b); exp=expected_bars(start,end); overlap=len(pairs)/exp if exp else 0
    r5a=[];r5b=[]; diffs=[]; dirs=[]; bases=[]; ranges_a=[];ranges_b=[]
    qva=[float(p[1].get("quoteVolume",0) or 0) for p in pairs]; qvb=[float(p[2].get("quoteVolume",0) or 0) for p in pairs]
    for i,(_,x,y) in enumerate(pairs):
        if x["close"]>0 and y["close"]>0: bases.append(abs(x["close"]-y["close"])/((x["close"]+y["close"])/2)*10000)
        xa,xb=range_pct(x),range_pct(y)
        if xa is not None and xb is not None: ranges_a.append(xa); ranges_b.append(xb)
        if i==0 or pairs[i][0]-pairs[i-1][0]!=INTERVAL_MS: continue
        ra=logret(pairs[i-1][1]["close"],x["close"]); rb=logret(pairs[i-1][2]["close"],y["close"])
        if ra is None or rb is None: continue
        r5a.append(ra); r5b.append(rb); diffs.append(abs(ra-rb)*10000); dirs.append(1.0 if (ra>0)-(ra<0)==(rb>0)-(rb<0) else 0.0)
    r15a,r15b=step_returns(pairs,3); r60a,r60b=step_returns(pairs,12)
    nva,nvb=norm_vol(qva),norm_vol(qvb); va=[];vb=[]; sa=set();sb=set(); spike=math.log(1.5)
    for i,(t,_,_) in enumerate(pairs):
        if nva[i] is not None and nvb[i] is not None: va.append(nva[i]); vb.append(nvb[i])
        if nva[i] is not None and nva[i]>=spike: sa.add(t)
        if nvb[i] is not None and nvb[i]>=spike: sb.add(t)
    union=sa|sb; inter=sa&sb; j=len(inter)/len(union) if union else None
    m={
      "overlapRows":len(pairs),"expectedRows":exp,"overlapCoveragePct":r(overlap*100,4),
      "returnCorrelation5m":r(pearson(r5a,r5b)),"returnCorrelation15m":r(pearson(r15a,r15b)),"returnCorrelation60m":r(pearson(r60a,r60b)),
      "directionMatchPct5m":r((mean(dirs) or 0)*100,4),"medianAbsReturnDiffBps":r(median(diffs),4),"p95AbsReturnDiffBps":r(pctile(diffs,.95),4),
      "medianCloseBasisBps":r(median(bases),4),"p95CloseBasisBps":r(pctile(bases,.95),4),"rangeCorrelation":r(pearson(ranges_a,ranges_b)),
      "normalizedVolumeCorrelation":r(pearson(va,vb)),"bingxVolumeSpikeCount":len(sa),"binanceVolumeSpikeCount":len(sb),"volumeSpikeIntersection":len(inter),"volumeSpikeJaccard":r(j)
    }
    price=(m["overlapCoveragePct"] or 0)>=MIN_OVERLAP_COVERAGE*100 and (m["returnCorrelation5m"] or -1)>=TH["ret5"] and (m["returnCorrelation15m"] or -1)>=TH["ret15"] and (m["returnCorrelation60m"] or -1)>=TH["ret60"] and (m["directionMatchPct5m"] or 0)>=TH["dir5"] and (m["medianAbsReturnDiffBps"] if m["medianAbsReturnDiffBps"] is not None else math.inf)<=TH["medDiff"] and (m["rangeCorrelation"] or -1)>=TH["range"]
    volume=(m["normalizedVolumeCorrelation"] or -1)>=TH["vol"] and (m["volumeSpikeJaccard"] is None or m["volumeSpikeJaccard"]>=TH["spike"])
    return {**m,"pricePass":price,"volumePass":volume,"fullProxyPass":price and volume}

def write_csv(rows):
    headers=["symbol","bingxCoveragePct","binanceCoveragePct","overlapCoveragePct","returnCorrelation5m","returnCorrelation15m","returnCorrelation60m","directionMatchPct5m","medianAbsReturnDiffBps","p95AbsReturnDiffBps","medianCloseBasisBps","p95CloseBasisBps","rangeCorrelation","normalizedVolumeCorrelation","bingxVolumeSpikeCount","binanceVolumeSpikeCount","volumeSpikeIntersection","volumeSpikeJaccard","pricePass","volumePass","fullProxyPass","archiveFilesVerified","error"]
    with CSV_PATH.open("w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=headers,extrasaction="ignore"); w.writeheader(); w.writerows(rows)

def main():
    print("="*60); print("V4 ARCHIVE CROSS-EXCHANGE VALIDATION V2"); print("BingX reference vs Binance USD-M official archive"); print("READ ONLY — NO PAPER / NO LIVE / NO ORDERS"); print("="*60)
    ART.mkdir(parents=True,exist_ok=True)
    latest=latest_archive_day(); end_dt=latest.replace(hour=23,minute=55,second=0,microsecond=0); start_dt=(latest-timedelta(days=DAYS-1)).replace(hour=0,minute=0,second=0,microsecond=0)
    start=int(start_dt.timestamp()*1000); end=int(end_dt.timestamp()*1000); days=[start_dt+timedelta(days=i) for i in range(DAYS)]
    print(f"Window: {start_dt.isoformat()} -> {end_dt.isoformat()} expected={expected_bars(start,end)}")
    results=[]
    for symbol in SYMBOLS:
        print(f"\n========== {symbol} =========="); row={"symbol":symbol}
        try:
            br,meta=fetch_binance_range(symbol,days,start,end); bs=coverage(br,start,end)
            row.update({"binanceCoveragePct":bs["coveragePct"],"binanceRows":bs["count"],"binanceExpected":bs["expected"],"binanceGapCount":bs["gapCount"],"binanceMaxGapMinutes":bs["maxGapMinutes"],"archiveFilesVerified":len(meta)})
            if len(meta)!=DAYS or not bs["complete"]: raise RuntimeError(f"Binance archive integrity failed: files={len(meta)}/{DAYS}, coverage={bs['coveragePct']}%, rows={bs['count']}/{bs['expected']}, maxGap={bs['maxGapMinutes']}m")
            print(f"[ARCHIVE] {symbol} files={len(meta)}/{DAYS} SHA256=PASS coverage={bs['coveragePct']}%")
            xr=fetch_bingx_range(symbol,start,end); xs=coverage(xr,start,end)
            row.update({"bingxCoveragePct":xs["coveragePct"],"bingxRows":xs["count"],"bingxExpected":xs["expected"],"bingxGapCount":xs["gapCount"],"bingxMaxGapMinutes":xs["maxGapMinutes"]})
            if not xs["complete"]: raise RuntimeError(f"BingX integrity failed: coverage={xs['coveragePct']}%, rows={xs['count']}/{xs['expected']}, maxGap={xs['maxGapMinutes']}m")
            row.update(compare(xs["rows"],bs["rows"],start,end))
            print(f"[COMPARE] pricePass={row['pricePass']} volumePass={row['volumePass']} fullProxyPass={row['fullProxyPass']}")
            print(f"[METRICS] 5mCorr={row['returnCorrelation5m']} 15mCorr={row['returnCorrelation15m']} 60mCorr={row['returnCorrelation60m']} dir={row['directionMatchPct5m']}% medDiff={row['medianAbsReturnDiffBps']}bps rangeCorr={row['rangeCorrelation']} normVolCorr={row['normalizedVolumeCorrelation']} spikeJ={row['volumeSpikeJaccard']}")
        except Exception as e:
            row.update({"error":str(e),"pricePass":False,"volumePass":False,"fullProxyPass":False}); print(f"[FAILED] {symbol}: {e}")
        results.append(row)
    compared=[x for x in results if not x.get("error")]; pp=sum(bool(x.get("pricePass")) for x in compared); vp=sum(bool(x.get("volumePass")) for x in compared); fp=sum(bool(x.get("fullProxyPass")) for x in compared)
    if len(compared)==len(SYMBOLS) and fp==len(SYMBOLS): verdict="BINANCE_ARCHIVE_PROXY_PASS_BUILD_FROZEN_100D_DATASET"
    elif len(compared)==len(SYMBOLS) and pp==len(SYMBOLS): verdict="PRICE_STRUCTURE_PROXY_PASS_VOLUME_PROXY_NOT_PROVEN"
    elif not compared: verdict="VALIDATION_NOT_EXECUTED_NO_COMPARABLE_SYMBOLS"
    elif pp>=math.ceil(len(compared)*.8): verdict="PARTIAL_PRICE_PROXY_NEEDS_SYMBOL_LEVEL_REVIEW"
    else: verdict="REJECT_BINANCE_ARCHIVE_AS_FULL_V4_PROXY"
    summary={"version":VERSION,"generatedAt":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),"mode":"ARCHIVE_CROSS_EXCHANGE_VALIDATION_ONLY","safety":{"strategyModulesImported":False,"scannerEnabled":False,"paperOrdersEnabled":False,"realOrdersEnabled":False,"orderEndpointsUsed":False},"sources":{"reference":"BingX perpetual public 5m klines","candidate":"Binance USD-M Futures official public daily kline archive","candidateArchiveBase":BINANCE_ARCHIVE_BASE,"archiveSha256ChecksumsRequired":True},"window":{"latestArchiveDay":latest.strftime("%Y-%m-%d"),"start":start_dt.isoformat().replace("+00:00","Z"),"end":end_dt.isoformat().replace("+00:00","Z"),"days":DAYS,"interval":"5m","expectedBarsPerSymbol":expected_bars(start,end)},"thresholds":TH,"aggregate":{"symbolsRequested":len(SYMBOLS),"symbolsCompared":len(compared),"pricePassCount":pp,"volumePassCount":vp,"fullProxyPassCount":fp,"verdict":verdict},"limitations":["Pass validates recent 5m OHLC structure and normalized volume behavior only.","Binance absolute volume is not treated as BingX absolute volume.","BingX-specific CVD/OI/funding/liquidations/news are not recreated.","Pass only permits building a frozen 100d replay dataset; PAPER and LIVE remain disabled."],"results":results}
    JSON_PATH.write_text(json.dumps(summary,indent=2,ensure_ascii=False),encoding="utf-8"); write_csv(results)
    print("\n"+"="*60); print("V4 ARCHIVE VALIDATION COMPLETE"); print(json.dumps(summary["aggregate"],indent=2)); print("="*60)
    if not compared: return 2
    return 0 if len(compared)==len(SYMBOLS) and fp==len(SYMBOLS) else 3

if __name__=="__main__": sys.exit(main())
