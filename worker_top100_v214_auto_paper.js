const CFG = {
  minScore: 7,
  leverage: 5,
  paperBalance: 200,
  maxMarginPct: 0.10,
  universeSize: 100,
  shardSize: 8,
  minTP2MovePct: 2.0,
  maxStopPct: 4.0,
  tp1ClosePct: 25,
  tp2ClosePct: 25,
  runnerPct: 50,
  liveMarginUSDT: 20,
  maxOpenPositions: 5,
  maxLiveMarginPct: 0.50,
  approvalTtlMs: 2 * 60 * 1000,
  maxEntryDriftPct: 0.75,
  privateReadGapMs: 900,
  testOrderGapMs: 4500,
  liveOrderGapMs: 700,
  maxAutoRateLimitWaitMs: 12000,
  paperCooldownMs: 30 * 60 * 1000,
  paperMaxTrades: 200,
  paperTrackPerTick: 4,
  paperKlineLimit: 120,
};

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function sum(arr) { return arr.reduce((a,b)=>a+b,0); }

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(rows, period = 14) {
  if (rows.length <= period) return null;
  const trs = [];
  for (let i = rows.length - period; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    trs.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - prev),
      Math.abs(rows[i].low - prev)
    ));
  }
  return avg(trs);
}

function adx(rows, period = 14) {
  if (rows.length < period * 2 + 2) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < rows.length; i++) {
    const upMove = rows[i].high - rows[i - 1].high;
    const downMove = rows[i - 1].low - rows[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    ));
  }

  // Only the last `period` DX values are used by the score, so calculate
  // those windows directly instead of every historical rolling window.
  const startEnd = Math.max(period, tr.length - period + 1);
  const dx = [];
  for (let end = startEnd; end <= tr.length; end++) {
    let trN = 0, plusN = 0, minusN = 0;
    for (let j = end - period; j < end; j++) {
      trN += tr[j];
      plusN += plusDM[j];
      minusN += minusDM[j];
    }
    if (!trN) continue;
    const plusDI = 100 * plusN / trN;
    const minusDI = 100 * minusN / trN;
    const denom = plusDI + minusDI;
    if (denom > 0) dx.push(100 * Math.abs(plusDI - minusDI) / denom);
  }
  if (dx.length < period) return null;
  return avg(dx);
}

function normalizeKlines(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.data ?? []);
  return raw.map(r => {
    if (Array.isArray(r)) {
      return {
        time:+r[0], open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5],
        closeTime:+(r[6] ?? 0), quoteVolume:+(r[7] ?? 0), trades:+(r[8] ?? 0),
        takerBuyBase:+(r[9] ?? 0), takerBuyQuote:+(r[10] ?? 0),
      };
    }
    return {
      time:+(r.time ?? r.openTime ?? r.ts ?? 0), open:+r.open, high:+r.high, low:+r.low, close:+r.close,
      volume:+(r.volume ?? r.vol ?? 0), closeTime:+(r.closeTime ?? 0),
      quoteVolume:+(r.quoteVolume ?? r.q ?? 0), trades:+(r.trades ?? r.n ?? 0),
      takerBuyBase:+(r.takerBuyBase ?? 0), takerBuyQuote:+(r.takerBuyQuote ?? 0),
    };
  }).filter(x => Number.isFinite(x.close) && x.close > 0).sort((a,b)=>a.time-b.time);
}

async function bingxJson(url) {
  const res = await fetch(url, { headers:{accept:"application/json"} });
  if (!res.ok) throw new Error(`BingX HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code != null && Number(json.code) !== 0) throw new Error(`BingX: ${json.msg || json.code}`);
  return json;
}

async function getKlines(symbol, interval, limit) {
  const u = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("limit", String(limit));
  const rows = normalizeKlines(await bingxJson(u));
  if (rows.length < 60) throw new Error(`${symbol} ${interval}: yetersiz mum verisi (${rows.length})`);
  return rows;
}

async function getTopSymbols(limit = CFG.universeSize) {
  const u = new URL("https://open-api.bingx.com/openApi/swap/v2/quote/ticker");
  const json = await bingxJson(u);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .filter(x => typeof x?.symbol === "string" && x.symbol.endsWith("-USDT"))
    .map(x => ({symbol:x.symbol, quoteVolume:Number(x.quoteVolume||0), lastPrice:Number(x.lastPrice||0)}))
    .filter(x => Number.isFinite(x.quoteVolume) && x.quoteVolume>0 && Number.isFinite(x.lastPrice) && x.lastPrice>0)
    .sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,limit);
}

function trend(rows) {
  const closes = rows.map(x=>x.close), e20=ema(closes,20), e50=ema(closes,50), last=closes.at(-1);
  if (e20 == null || e50 == null) return "NEUTRAL";
  if (last > e20 && e20 > e50) return "LONG";
  if (last < e20 && e20 < e50) return "SHORT";
  return "NEUTRAL";
}

function ema200Alignment(rows, direction) {
  const closes=rows.map(x=>x.close), e200=ema(closes,200);
  if (e200 == null) return {aligned:false, ema200:null};
  const last=closes.at(-1);
  return {aligned:(direction==="LONG"&&last>e200)||(direction==="SHORT"&&last<e200), ema200:e200};
}

function volumePressure(rows, lookback=6) {
  const recent=rows.slice(-lookback);
  let weightedFlow=0, totalVol=0;
  for (const r of recent) {
    const v=Number(r.volume||0);
    const range=Number(r.high)-Number(r.low);
    if (!(v>0) || !(range>0)) continue;
    // Chaikin-style close-location value: -1 near candle low, +1 near candle high.
    const mfm=((r.close-r.low)-(r.high-r.close))/range;
    weightedFlow+=Math.max(-1,Math.min(1,mfm))*v;
    totalVol+=v;
  }
  if (!(totalVol>0)) return {buyShare:null,sellShare:null};
  const bias=Math.max(-1,Math.min(1,weightedFlow/totalVol));
  const buyShare=(bias+1)/2;
  return {buyShare,sellShare:1-buyShare};
}

function chooseDirection(dir4h,dir1h,dir15) {
  if (dir4h!=="NEUTRAL") return dir4h;
  if (dir1h!=="NEUTRAL" && dir1h===dir15) return dir1h;
  return "NEUTRAL";
}

function analyze(symbol,h4,h1,m15,btcDir,quoteVolume=null) {
  const m15c=m15.map(x=>x.close);
  const dir4h=trend(h4), dir1h=trend(h1), dir15=trend(m15);
  const direction=chooseDirection(dir4h,dir1h,dir15);
  const last=m15.at(-1), rr=rsi(m15c,14), a=atr(m15,14);
  const atrPct=a?(a/last.close)*100:99, adx4h=adx(h4,14), ema200=ema200Alignment(h4,direction);

  const recentVol=avg(m15.slice(-4).map(x=>x.volume));
  const baseVol=avg(m15.slice(-24,-4).map(x=>x.volume));
  const volRatio=baseVol>0?recentVol/baseVol:0;

  const prior=m15.slice(-21,-1), prevHigh=Math.max(...prior.map(x=>x.high)), prevLow=Math.min(...prior.map(x=>x.low));
  const breakoutLong=last.close>prevHigh, breakoutShort=last.close<prevLow;
  const nearLong=!breakoutLong&&a&&last.close<=prevHigh&&(prevHigh-last.close)<=0.2*a;
  const nearShort=!breakoutShort&&a&&last.close>=prevLow&&(last.close-prevLow)<=0.2*a;
  const pressure=volumePressure(m15,6);

  let score=0; const reasons=[];
  if (direction!=="NEUTRAL"&&dir4h===direction){score+=1.5;reasons.push("4s ana trend uyumlu");}
  if (direction!=="NEUTRAL"&&ema200.aligned){score+=0.5;reasons.push("4s EMA200 uyumlu");}
  if (direction!=="NEUTRAL"&&adx4h!=null){
    if(adx4h>=25){score+=0.5;reasons.push(`4s ADX güçlü ${adx4h.toFixed(1)}`);}
    else if(adx4h>=20){score+=0.25;reasons.push(`4s ADX orta ${adx4h.toFixed(1)}`);}
  }
  if(direction!=="NEUTRAL"&&dir1h===direction){score+=1;reasons.push("1s trend teyidi");}
  if(direction!=="NEUTRAL"&&dir15===direction){score+=0.5;reasons.push("15dk momentum aynı yönde");}
  if(direction!=="NEUTRAL"&&btcDir===direction){score+=0.5;reasons.push("BTC genel yönü destekliyor");}

  if(volRatio>=3){score+=2;reasons.push(`anormal hacim ${volRatio.toFixed(2)}x`);}
  else if(volRatio>=2){score+=1.5;reasons.push(`çok güçlü hacim ${volRatio.toFixed(2)}x`);}
  else if(volRatio>=1.5){score+=1;reasons.push(`güçlü hacim ${volRatio.toFixed(2)}x`);}
  else if(volRatio>=1.2){score+=0.5;reasons.push(`artan hacim ${volRatio.toFixed(2)}x`);}

  if(direction==="LONG"&&breakoutLong){score+=2;reasons.push("20 mumluk tepe kırılımı");}
  else if(direction==="LONG"&&nearLong){score+=1;reasons.push("tepe kırılımına 0.2 ATR içinde");}
  if(direction==="SHORT"&&breakoutShort){score+=2;reasons.push("20 mumluk dip kırılımı");}
  else if(direction==="SHORT"&&nearShort){score+=1;reasons.push("dip kırılımına 0.2 ATR içinde");}

  if(direction==="LONG"&&pressure.buyShare!=null){
    if(pressure.buyShare>=0.63){score+=1;reasons.push(`alış baskısı tahmini %${(pressure.buyShare*100).toFixed(0)}`);}
    else if(pressure.buyShare>=0.58){score+=0.5;reasons.push(`alış baskısı tahmini %${(pressure.buyShare*100).toFixed(0)}`);}
  }
  if(direction==="SHORT"&&pressure.sellShare!=null){
    if(pressure.sellShare>=0.63){score+=1;reasons.push(`satış baskısı tahmini %${(pressure.sellShare*100).toFixed(0)}`);}
    else if(pressure.sellShare>=0.58){score+=0.5;reasons.push(`satış baskısı tahmini %${(pressure.sellShare*100).toFixed(0)}`);}
  }

  if(direction==="LONG"&&rr!=null&&rr>=50&&rr<=72){score+=0.5;reasons.push(`RSI ${rr.toFixed(1)}`);}
  if(direction==="SHORT"&&rr!=null&&rr>=28&&rr<=50){score+=0.5;reasons.push(`RSI ${rr.toFixed(1)}`);}
  if(atrPct>=0.35&&atrPct<=2.5){score+=0.5;reasons.push(`ATR ${atrPct.toFixed(2)}%`);}

  score=Math.min(10,Math.round(score*4)/4);

  // Dinamik risk/hedef: giriş 15dk, stop ve hedefler 15dk yapı + 1s ATR ile belirlenir.
  const a1=atr(h1,14);
  const h1Ema20=ema(h1.map(x=>x.close),20);
  const swing=m15.slice(-13,-1);
  const swingHigh=swing.length?Math.max(...swing.map(x=>x.high)):last.high;
  const swingLow=swing.length?Math.min(...swing.map(x=>x.low)):last.low;

  let stop=null,tp1=null,tp2=null,riskDist=null,stopPct=null,tp1MovePct=null,tp2MovePct=null;
  let targetR=null,rangeOk=false,riskOk=false,runnerTrailATR=null;
  if(direction!=="NEUTRAL"&&a&&a1){
    const buffer=0.25*a;
    const structuralStop=direction==="LONG"?(swingLow-buffer):(swingHigh+buffer);
    const structuralRisk=direction==="LONG"?(last.close-structuralStop):(structuralStop-last.close);
    const atrRisk=Math.max(1.5*a,0.65*a1);
    riskDist=Math.max(atrRisk,structuralRisk>0?structuralRisk:0);

    const strongTrend=dir4h===direction&&dir1h===direction&&adx4h!=null&&adx4h>=25;
    const breakoutWithVolume=(direction==="LONG"&&breakoutLong||direction==="SHORT"&&breakoutShort)&&volRatio>=1.5;
    const veryStrong=strongTrend&&breakoutWithVolume;
    targetR=veryStrong?5:(strongTrend?4:3);
    runnerTrailATR=veryStrong?2.0:(strongTrend?1.7:1.5);

    stopPct=(riskDist/last.close)*100;
    tp1MovePct=(2*riskDist/last.close)*100;
    tp2MovePct=(targetR*riskDist/last.close)*100;
    riskOk=stopPct<=CFG.maxStopPct;
    rangeOk=tp2MovePct>=CFG.minTP2MovePct;

    if(direction==="LONG"){
      stop=last.close-riskDist;
      tp1=last.close+2*riskDist;
      tp2=last.close+targetR*riskDist;
    }else{
      stop=last.close+riskDist;
      tp1=last.close-2*riskDist;
      tp2=last.close-targetR*riskDist;
    }

    if(strongTrend) reasons.push(`trend güçlü: TP2 ${targetR}R`);
    if(!rangeOk) reasons.push(`hedef aralığı dar: TP2 hareketi %${tp2MovePct.toFixed(2)}`);
    if(!riskOk) reasons.push(`stop aralığı geniş: %${stopPct.toFixed(2)}`);
  }

  const qualifies=score>=CFG.minScore&&direction!=="NEUTRAL"&&rangeOk&&riskOk;
  const grossTp1Pct=tp1MovePct==null?null:tp1MovePct*CFG.leverage;
  const grossTp2Pct=tp2MovePct==null?null:tp2MovePct*CFG.leverage;
  const runnerPlan=`TP1'de %${CFG.tp1ClosePct} kapat → SL girişe; TP2'de %${CFG.tp2ClosePct} kapat → kalan %${CFG.runnerPct} 1s EMA20 / ${runnerTrailATR??1.5} ATR trailing`;

  return {
    symbol,direction,score,qualifies,
    price:+last.close.toFixed(8),rsi:rr==null?null:+rr.toFixed(1),volumeRatio:+volRatio.toFixed(2),
    atrPct:+atrPct.toFixed(2),adx4h:adx4h==null?null:+adx4h.toFixed(1),ema200Aligned:ema200.aligned,
    buyPressurePct:pressure.buyShare==null?null:+(pressure.buyShare*100).toFixed(1),
    sellPressurePct:pressure.sellShare==null?null:+(pressure.sellShare*100).toFixed(1),
    trend4h:dir4h,trend1h:dir1h,trend15m:dir15,quoteVolume24h:quoteVolume==null?null:Math.round(quoteVolume),
    entry:+last.close.toFixed(8),stop:stop==null?null:+stop.toFixed(8),tp1:tp1==null?null:+tp1.toFixed(8),tp2:tp2==null?null:+tp2.toFixed(8),
    stopPct:stopPct==null?null:+stopPct.toFixed(2),tp1MovePct:tp1MovePct==null?null:+tp1MovePct.toFixed(2),tp2MovePct:tp2MovePct==null?null:+tp2MovePct.toFixed(2),
    targetR,rangeOk,riskOk,runnerTrailATR,h1Ema20:h1Ema20==null?null:+h1Ema20.toFixed(8),
    atr1hPct:a1==null?null:+((a1/last.close)*100).toFixed(2),
    tp1ClosePct:CFG.tp1ClosePct,tp2ClosePct:CFG.tp2ClosePct,runnerPct:CFG.runnerPct,runnerPlan,
    grossTp1Pct:grossTp1Pct==null?null:+grossTp1Pct.toFixed(1),grossTp2Pct:grossTp2Pct==null?null:+grossTp2Pct.toFixed(1),
    leverage:CFG.leverage,paperMarginUSDT:+(CFG.paperBalance*CFG.maxMarginPct).toFixed(2),reasons
  };
}

function shardIndexFor(shardCount,date=new Date()){
  if(!shardCount)return 0;
  return Math.floor(date.getTime()/60000)%shardCount;
}

async function scan(){
  const [top,btc4h,btc1h,btc15]=await Promise.all([
    getTopSymbols(CFG.universeSize),
    getKlines("BTC-USDT","4h",220),
    getKlines("BTC-USDT","1h",120),
    getKlines("BTC-USDT","15m",120),
  ]);

  const btc4=trend(btc4h),btc1=trend(btc1h),btc15dir=trend(btc15);
  const btcDir=btc4!=="NEUTRAL"?btc4:(btc1===btc15dir?btc1:"NEUTRAL");

  const shardCount=Math.ceil(top.length/CFG.shardSize), shardIndex=shardIndexFor(shardCount);
  const selected=top.slice(shardIndex*CFG.shardSize,(shardIndex+1)*CFG.shardSize),results=[];

  for(let i=0;i<selected.length;i+=2){
    const batch=selected.slice(i,i+2);
    const batchResults=await Promise.all(batch.map(async item=>{
      try{
        let h4,h1,m15;
        if(item.symbol==="BTC-USDT"){h4=btc4h;h1=btc1h;m15=btc15;}
        else{
          [h4,h1,m15]=await Promise.all([
            getKlines(item.symbol,"4h",220),
            getKlines(item.symbol,"1h",120),
            getKlines(item.symbol,"15m",120),
          ]);
        }
        return analyze(item.symbol,h4,h1,m15,btcDir,item.quoteVolume);
      }catch(e){return {symbol:item.symbol,error:String(e.message||e)};}
    }));
    results.push(...batchResults);
  }

  return {
    mode:"PAPER_SCAN",version:"TOP100_V2_14",scannedAt:new Date().toISOString(),btcDirection:btcDir,minScore:CFG.minScore,
    universe:`BingX top ${top.length} USDT perpetual by 24h quote volume`,shard:shardIndex+1,shardCount,
    scannedSymbols:selected.map(x=>x.symbol),paperBalanceUSDT:CFG.paperBalance,
    signals:results.filter(x=>x.qualifies).sort((a,b)=>b.score-a.score),
    all:results.sort((a,b)=>(b.score||0)-(a.score||0)),
  };
}

async function hmacHex(secret,message){
  const key=await crypto.subtle.importKey(
    "raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]
  );
  const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function safeEqual(a,b){
  if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;
  let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0;
}

function b64urlEncode(text){
  const bytes=new TextEncoder().encode(text); let bin="";
  for(const b of bytes)bin+=String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function b64urlDecode(text){
  const b64=text.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-text.length%4)%4);
  const bin=atob(b64),bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function makeApprovalToken(env,signal,scannedAt){
  if(!env?.TRADE_APPROVAL_SECRET)return null;
  const now=Date.now();
  const payload={
    v:1,symbol:signal.symbol,direction:signal.direction,entry:signal.entry,score:signal.score,
    issuedAt:now,scanAt:Date.parse(scannedAt)||now,exp:now+CFG.approvalTtlMs
  };
  const body=b64urlEncode(JSON.stringify(payload));
  return `${body}.${await hmacHex(env.TRADE_APPROVAL_SECRET,body)}`;
}

async function verifyApprovalToken(env,token){
  if(!env?.TRADE_APPROVAL_SECRET)throw new Error("TRADE_APPROVAL_SECRET eksik");
  const [body,sig,...rest]=String(token||"").split(".");
  if(!body||!sig||rest.length)throw new Error("Geçersiz onay anahtarı");
  const expected=await hmacHex(env.TRADE_APPROVAL_SECRET,body);
  if(!safeEqual(sig,expected))throw new Error("Onay imzası geçersiz");
  const payload=JSON.parse(b64urlDecode(body));
  if(payload?.v!==1||!payload?.symbol||!["LONG","SHORT"].includes(payload?.direction))throw new Error("Onay verisi geçersiz");
  if(!Number.isFinite(payload.exp)||Date.now()>payload.exp)throw new Error("Bu işlem butonunun süresi dolmuş");
  return payload;
}

function isNetworkError(e){
  return e instanceof TypeError || (e instanceof DOMException && (e.name==="AbortError"||e.name==="TimeoutError"));
}

function bingxCooldownMs(message){
  const m=String(message||"").match(/unblocked after\s+(\d{10,13})/i);
  if(!m)return null;
  let ts=Number(m[1]);
  if(!Number.isFinite(ts))return null;
  if(ts<1e12)ts*=1000;
  return Math.max(0,ts-Date.now());
}

async function signedBingx(env,method,path,params={},retryCount=0){
  if(!env?.BINGX_API_KEY||!env?.BINGX_SECRET_KEY)throw new Error("BingX API anahtarları eksik");

  const bases=["https://open-api.bingx.com","https://open-api.bingx.pro"];
  let lastNetworkError=null;

  for(let i=0;i<bases.length;i++){
    try{
      // Her denemede timestamp ve imza yeniden üretilir.
      const all={...params,recvWindow:5000,timestamp:Date.now()};
      const qs=Object.keys(all).sort().map(k=>`${k}=${all[k]}`).join("&");
      const signed=`${qs}&signature=${await hmacHex(env.BINGX_SECRET_KEY,qs)}`;
      const url=method==="GET"?`${bases[i]}${path}?${signed}`:`${bases[i]}${path}`;

      const res=await fetch(url,{
        method,
        headers:{
          "X-BX-APIKEY":env.BINGX_API_KEY,
          "X-SOURCE-KEY":"BX-AI-SKILL",
          ...(method!=="GET"?{"content-type":"application/x-www-form-urlencoded"}:{})
        },
        body:method!=="GET"?signed:undefined,
        signal:AbortSignal.timeout(10000),
      });

      const raw=await res.text();
      let json;
      try{json=JSON.parse(raw);}
      catch{throw new Error(`BingX ${path}: geçersiz yanıt · HTTP ${res.status}`);}

      const code=Number(json?.code);
      const msg=String(json?.msg||"hata");

      // BingX 100410: endpoint geçici frekans kilidi.
      if(code===100410){
        const waitMs=bingxCooldownMs(msg);
        if(retryCount<1 && waitMs!=null && waitMs<=CFG.maxAutoRateLimitWaitMs){
          const sleepMs=Math.max(800,waitMs+350);
          console.warn("BINGX_100410_AUTO_RETRY",JSON.stringify({path,waitMs:sleepMs}));
          await sleep(sleepMs);
          return signedBingx(env,method,path,params,retryCount+1);
        }
        const extra=waitMs!=null
          ? ` · yaklaşık ${Math.ceil(waitMs/1000)} sn sonra açılacak`
          : "";
        throw new Error(`BingX ${path}: 100410 frekans kilidi${extra}`);
      }

      if(!res.ok)throw new Error(`BingX ${path}: HTTP ${res.status} · ${msg}`);
      if(code!==0)throw new Error(`BingX ${path}: ${code} · ${msg}`);
      return json?.data;

    }catch(e){
      if(isNetworkError(e)){
        lastNetworkError=e;
        if(i<bases.length-1)continue;
      }
      throw e;
    }
  }

  throw lastNetworkError||new Error(`BingX ${path}: bağlantı hatası`);
}
async function getContractInfo(symbol){
  const u=new URL("https://open-api.bingx.com/openApi/swap/v2/quote/contracts");
  u.searchParams.set("symbol",symbol);
  const json=await bingxJson(u),raw=json?.data;
  const rows=Array.isArray(raw)?raw:(raw?[raw]:[]);
  const c=rows.find(x=>x?.symbol===symbol)||rows[0];
  if(!c)throw new Error(`${symbol}: kontrat bilgisi bulunamadı`);
  if(String(c.apiStateOpen).toLowerCase()==="false"||Number(c.status)===0)throw new Error(`${symbol}: API ile pozisyon açma kapalı`);
  return c;
}

function floorPrecision(n,p){
  const f=10**Math.max(0,Number(p)||0); return Math.floor((Number(n)+1e-12)*f)/f;
}
function roundPrecision(n,p){return +Number(n).toFixed(Math.max(0,Number(p)||0));}
function ceilPrecision(n,p){
  const f=10**Math.max(0,Number(p)||0);
  return Math.ceil((Number(n)-1e-12)*f)/f;
}

async function analyzeSingle(symbol){
  const [btc4h,btc1h,btc15,h4,h1,m15]=await Promise.all([
    getKlines("BTC-USDT","4h",220),getKlines("BTC-USDT","1h",120),getKlines("BTC-USDT","15m",120),
    getKlines(symbol,"4h",220),getKlines(symbol,"1h",120),getKlines(symbol,"15m",120),
  ]);
  const b4=trend(btc4h),b1=trend(btc1h),b15=trend(btc15);
  const btcDir=b4!=="NEUTRAL"?b4:(b1===b15?b1:"NEUTRAL");
  return analyze(symbol,h4,h1,m15,btcDir,null);
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function ntfyRetryDelayMs(res,attempt){
  const retryAfter=res?.headers?.get?.("retry-after");
  if(retryAfter){
    const seconds=Number(retryAfter);
    if(Number.isFinite(seconds)&&seconds>=0)return Math.min(30000,Math.max(5500,seconds*1000));
    const when=Date.parse(retryAfter);
    if(Number.isFinite(when))return Math.min(30000,Math.max(5500,when-Date.now()));
  }
  // ntfy public server refills its request bucket roughly once every 5s.
  // 6s, 12s, 24s keeps us away from a tight 429 retry loop.
  return Math.min(30000,6000*(2**attempt));
}

async function ntfyFetchWithRetry(url,options,label="notification"){
  const maxAttempts=4;
  let lastStatus=0,lastBody="";
  for(let attempt=0;attempt<maxAttempts;attempt++){
    let res;
    try{
      res=await fetch(url,options);
    }catch(e){
      if(attempt===maxAttempts-1)throw e;
      const waitMs=Math.min(30000,6000*(2**attempt));
      console.warn("NTFY_RETRY",JSON.stringify({label,reason:"network",attempt:attempt+1,waitMs}));
      await sleep(waitMs);
      continue;
    }

    if(res.ok)return res;
    lastStatus=res.status;
    try{lastBody=(await res.text()).slice(0,240);}catch(_){lastBody="";}

    const retryable=res.status===429||res.status>=500;
    if(!retryable||attempt===maxAttempts-1)break;

    const waitMs=ntfyRetryDelayMs(res,attempt);
    console.warn("NTFY_RETRY",JSON.stringify({
      label,status:res.status,attempt:attempt+1,waitMs,
      body:lastBody||undefined
    }));
    await sleep(waitMs);
  }
  throw new Error(`ntfy gönderim hatası: HTTP ${lastStatus}${lastBody?` · ${lastBody}`:""}`);
}

async function notifyText(env,title,message,priority="high"){
  if(!env?.NTFY_TOPIC)throw new Error("NTFY_TOPIC eksik");
  await ntfyFetchWithRetry(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`,{
    method:"POST",
    headers:{"content-type":"text/plain; charset=utf-8",title,priority,tags:"chart_with_upwards_trend"},
    body:message
  },"test");
  return true;
}


async function telegramLatestChat(env){
  const botToken=String(env?.TELEGRAM_BOT_TOKEN||"").trim();
  if(!botToken)throw new Error("TELEGRAM_BOT_TOKEN eksik");
  const res=await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
  if(!res.ok)throw new Error(`Telegram getUpdates HTTP ${res.status}`);
  const json=await res.json();
  const updates=Array.isArray(json?.result)?json.result:[];
  for(let i=updates.length-1;i>=0;i--){
    const chat=updates[i]?.message?.chat||updates[i]?.edited_message?.chat||updates[i]?.callback_query?.message?.chat;
    if(chat?.id!=null)return String(chat.id);
  }
  throw new Error("Telegram chat bulunamadı; bota /start gönder");
}

async function telegramSend(env,title,message,actionUrl=null,actionLabel=null){
  const botToken=String(env?.TELEGRAM_BOT_TOKEN||"").trim();
  if(!botToken)return false;

  let chatId=String(env?.TELEGRAM_CHAT_ID||"").trim();
  if(!chatId)chatId=await telegramLatestChat(env);

  const body={
    chat_id:chatId,
    text:`📈 ${title}\n\n${message}`,
    disable_web_page_preview:true
  };
  if(actionUrl&&actionLabel){
    body.reply_markup={inline_keyboard:[[{text:actionLabel,url:actionUrl}]]};
  }

  const res=await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  if(!res.ok){
    let detail="";
    try{detail=(await res.text()).slice(0,240);}catch(_){}
    throw new Error(`Telegram HTTP ${res.status}${detail?` · ${detail}`:""}`);
  }
  return true;
}

async function ntfyFallback(env,title,message){
  const topic=String(env?.NTFY_TOPIC||"").trim();
  if(!topic)return false;
  const payload={topic,title,message,priority:4,tags:["chart_with_upwards_trend"]};
  await ntfyFetchWithRetry("https://ntfy.sh",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(payload)
  },title);
  return true;
}

async function sendPrimary(env,title,message,actionUrl=null,actionLabel=null){
  try{
    if(await telegramSend(env,title,message,actionUrl,actionLabel)){
      console.log("TELEGRAM_SENT",title);
      return "telegram";
    }
  }catch(e){
    console.error("TELEGRAM_ERROR",String(e?.message||e));
  }

  if(await ntfyFallback(env,title,message))return "ntfy";
  throw new Error("Bildirim kanalı kullanılamıyor");
}

function signalLandingPage(payload,token,execMode){
  const safeSymbol=String(payload.symbol||"").replace(/[<>&"']/g,"");
  const safeDir=String(payload.direction||"").replace(/[<>&"']/g,"");
  const safeMode=execMode==="LIVE"?"AÇ":"TEST";
  const issued=new Date(Number(payload.issuedAt)||Date.now()).toLocaleString("tr-TR");
  const expires=new Date(Number(payload.exp)||Date.now()).toLocaleString("tr-TR");
  const tokenJson=JSON.stringify(token);

  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeSymbol} ${safeDir}</title>
  <style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:auto;padding:20px;background:#0b0d10;color:#f4f4f5}
  .card{background:#171a1f;border:1px solid #2a2f37;border-radius:16px;padding:18px;line-height:1.6}
  .good{color:#4ade80}.muted{color:#a1a1aa}
  button{width:100%;margin-top:16px;padding:15px;border:0;border-radius:12px;font-weight:800;font-size:17px}
  </style>
  <div class="card">
    <h2>${safeSymbol} · ${safeDir}</h2>
    <div>Bildirim skoru: <b>${Number(payload.score)||"-"}/10</b></div>
    <div>Sinyal giriş fiyatı: ${Number(payload.entry)||"-"}</div>
    <div class="muted">Oluşturuldu: ${issued}</div>
    <div class="muted">Buton süresi: ${expires}</div>
    <p><b>Butona bastığında sistem sinyali yeniden analiz eder.</b> Skor 7/10 altına düşmüşse, yön değişmişse veya fiyat sinyal girişinden %${CFG.maxEntryDriftPct} fazla uzaklaşmışsa işlem iptal edilir.</p>
    <button id="tradeBtn" onclick="runTrade()">${safeDir} ${safeMode}</button>
    <div id="result" class="muted"></div>
  </div>
  <script>
  async function runTrade(){
    const btn=document.getElementById("tradeBtn"),result=document.getElementById("result");
    if(!confirm("${safeDir} ${safeMode} işlemini göndermek istiyor musun?"))return;
    btn.disabled=true;btn.textContent="Kontrol ediliyor...";
    try{
      const res=await fetch("/trade",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:${tokenJson}})});
      const out=await res.json();
      if(!res.ok||!out.ok)throw new Error(out.error||"İşlem başarısız");
      result.textContent=out.mode==="LIVE"?"Emir açıldı.":"TEST başarılı — gerçek pozisyon açılmadı.";
      btn.textContent=out.mode==="LIVE"?"EMİR AÇILDI":"TEST BAŞARILI";
    }catch(e){
      result.textContent="İşlem iptal: "+(e.message||e);
      btn.disabled=false;btn.textContent="${safeDir} ${safeMode}";
    }
  }
  </script>`;
}


async function bingxConnectionTest(env){
  // Her koşulda yalnızca /order/test kullanır; gerçek emir ve hesap ayarı değişikliği yoktur.
  if(!env?.BINGX_API_KEY||!env?.BINGX_SECRET_KEY)throw new Error("BingX API anahtarları eksik");

  const symbol="BTC-USDT";
  const [contract,m15]=await Promise.all([
    getContractInfo(symbol),
    getKlines(symbol,"15m",120),
  ]);

  const last=Number(m15.at(-1)?.close||0);
  if(!(last>0))throw new Error("BTC test fiyatı alınamadı");

  // TEST için gereksiz bakiye/pozisyon sorguları kaldırıldı.
  const dualData=await signedBingx(env,"GET","/openApi/swap/v1/positionSide/dual");
  await sleep(CFG.privateReadGapMs);

  const qp=Number(contract.quantityPrecision||0);
  const minQty=Math.max(0,Number(contract.tradeMinQuantity||0));
  const minUSDT=Math.max(0,Number(contract.tradeMinUSDT||0));
  const targetNotional=Math.max(25,minUSDT*1.25);
  const rawQty=Math.max(targetNotional/last,minQty);
  const qty=ceilPrecision(rawQty,qp);
  if(!(qty>0))throw new Error("BTC test miktarı hesaplanamadı");

  const dual=Boolean(dualData?.dualSidePosition);
  const positionSide=dual?"LONG":"BOTH";
  const clientOrderId=`cbconn${Date.now().toString(36)}`.slice(0,40);

  const testOrder=await signedBingx(env,"POST","/openApi/swap/v2/trade/order/test",{
    symbol,
    side:"BUY",
    positionSide,
    type:"MARKET",
    quantity:qty,
    clientOrderId
  });

  return {
    mode:"TEST_ONLY",
    symbol,
    quantity:qty,
    referencePrice:+last.toFixed(8),
    notionalUSDT:+(qty*last).toFixed(2),
    openPositions:null,
    hedgeMode:dual,
    endpoint:"/openApi/swap/v2/trade/order/test",
    testOrder
  };
}
async function executeApprovedTrade(env,token){
  const p=await verifyApprovalToken(env,token);
  const execMode=String(env?.EXECUTION_MODE||"TEST").toUpperCase();
  if(!["TEST","LIVE"].includes(execMode))throw new Error("EXECUTION_MODE yalnızca TEST veya LIVE olabilir");

  // Tek tuş onayından hemen önce teknik şartları yeniden kontrol et.
  const fresh=await analyzeSingle(p.symbol);
  if(!fresh.qualifies||fresh.direction!==p.direction){
    throw new Error(`Sinyal artık geçerli değil (${fresh.direction} ${fresh.score}/10)`);
  }

  const drift=Math.abs((fresh.entry-p.entry)/p.entry)*100;
  if(!Number.isFinite(drift)||drift>CFG.maxEntryDriftPct){
    throw new Error(`Fiyat sinyalden %${drift.toFixed(2)} uzaklaştı; işlem iptal`);
  }

  // Kontrat bilgisi public endpoint'ten gelir.
  const contract=await getContractInfo(p.symbol);

  let positions=[],balanceData=null,dualData=null,active=[];

  if(execMode==="TEST"){
    // TEST modunda gerçek pozisyon oluşmadığı için bakiye ve açık pozisyon
    // kontrolleri gereksiz API yükü oluşturuyordu. Yalnızca position mode okunur.
    dualData=await signedBingx(env,"GET","/openApi/swap/v1/positionSide/dual");
    await sleep(CFG.privateReadGapMs);
  }else{
    // LIVE güvenlik kontrolleri korunur fakat private çağrılar burst yerine sırayla yapılır.
    positions=await signedBingx(env,"GET","/openApi/swap/v2/user/positions");
    await sleep(CFG.privateReadGapMs);

    balanceData=await signedBingx(env,"GET","/openApi/swap/v3/user/balance");
    await sleep(CFG.privateReadGapMs);

    dualData=await signedBingx(env,"GET","/openApi/swap/v1/positionSide/dual");
    await sleep(CFG.privateReadGapMs);

    active=(Array.isArray(positions)?positions:[]).filter(x=>Math.abs(Number(x?.positionAmt||0))>0);
    if(active.some(x=>x?.symbol===p.symbol))throw new Error(`${p.symbol} için zaten açık pozisyon var`);
    if(active.length>=CFG.maxOpenPositions){
      throw new Error(`Açık pozisyon limiti dolu (${active.length}/${CFG.maxOpenPositions})`);
    }

    const balances=Array.isArray(balanceData)
      ? balanceData
      : Array.isArray(balanceData?.balance)
        ? balanceData.balance
        : (balanceData?.balance && typeof balanceData.balance==="object")
          ? [balanceData.balance]
          : [balanceData];

    const usdt=balances.find(x=>x?.asset==="USDT")||balances[0]||{};
    const equity=Number(usdt?.equity??usdt?.balance??0);
    const available=Number(usdt?.availableMargin??usdt?.availableBalance??0);

    if(!(available>=CFG.liveMarginUSDT)){
      throw new Error(`Kullanılabilir margin yetersiz: ${available||0} USDT`);
    }

    const used=active.reduce((a,x)=>a+Math.max(0,Number(x?.initialMargin||0)),0);
    if(equity>0&&used+CFG.liveMarginUSDT>equity*CFG.maxLiveMarginPct+1e-9){
      throw new Error(`Toplam margin limiti %${Math.round(CFG.maxLiveMarginPct*100)} aşılır`);
    }
  }

  const qp=Number(contract.quantityPrecision||0);
  const pp=Number(contract.pricePrecision||8);
  const qty=floorPrecision((CFG.liveMarginUSDT*CFG.leverage)/fresh.entry,qp);
  const minQty=Number(contract.tradeMinQuantity||0);
  const minUSDT=Number(contract.tradeMinUSDT||0);

  if(!(qty>0)||qty<minQty||qty*fresh.entry<minUSDT){
    throw new Error(`Hesaplanan miktar kontrat minimumunun altında (${qty})`);
  }

  const tp1Qty=floorPrecision(qty*CFG.tp1ClosePct/100,qp);
  const tp2Qty=floorPrecision(qty*CFG.tp2ClosePct/100,qp);
  const runnerQty=floorPrecision(qty-tp1Qty-tp2Qty,qp);

  if(tp1Qty<minQty||tp2Qty<minQty||runnerQty<minQty){
    throw new Error("20 USDT margin bu coinde kademeli TP için çok küçük");
  }

  const dual=Boolean(dualData?.dualSidePosition);
  const positionSide=dual?p.direction:"BOTH";
  const openSide=p.direction==="LONG"?"BUY":"SELL";
  const closeSide=p.direction==="LONG"?"SELL":"BUY";

  const stop=roundPrecision(fresh.stop,pp);
  const tp1=roundPrecision(fresh.tp1,pp);
  const tp2=roundPrecision(fresh.tp2,pp);
  const runnerRate=Math.max(0.005,Math.min(0.05,((fresh.runnerTrailATR||1.5)*(fresh.atr1hPct||1))/100));

  const tokenHash=(await hmacHex(env.TRADE_APPROVAL_SECRET,token)).slice(0,18);
  const id=(kind)=>`cb23${kind}${tokenHash}`.slice(0,40);

  if(execMode==="LIVE"){
    const mt=await signedBingx(env,"GET","/openApi/swap/v2/trade/marginType",{symbol:p.symbol});
    await sleep(CFG.privateReadGapMs);

    if(String(mt?.marginType||"").toUpperCase()!=="ISOLATED"){
      await signedBingx(env,"POST","/openApi/swap/v2/trade/marginType",{
        symbol:p.symbol,marginType:"ISOLATED"
      });
      await sleep(CFG.privateReadGapMs);
    }

    await signedBingx(env,"POST","/openApi/swap/v2/trade/leverage",{
      symbol:p.symbol,
      side:dual?p.direction:"BOTH",
      leverage:CFG.leverage
    });
    await sleep(CFG.privateReadGapMs);
  }

  const orderPath=execMode==="LIVE"
    ? "/openApi/swap/v2/trade/order"
    : "/openApi/swap/v2/trade/order/test";

  const baseClose={
    symbol:p.symbol,
    side:closeSide,
    positionSide,
    workingType:"MARK_PRICE"
  };
  const reduce=dual?{}:{reduceOnly:"true"};

  // Giriş emri + SL.
  const entry=await signedBingx(env,"POST",orderPath,{
    symbol:p.symbol,
    side:openSide,
    positionSide,
    type:"MARKET",
    quantity:qty,
    clientOrderId:id("e"),
    stopLoss:JSON.stringify({
      type:"STOP_MARKET",
      stopPrice:stop,
      workingType:"MARK_PRICE",
      stopGuaranteed:false
    })
  });

  const orderGap=execMode==="TEST"?CFG.testOrderGapMs:CFG.liveOrderGapMs;
  await sleep(orderGap);

  const tp1Order=await signedBingx(env,"POST",orderPath,{
    ...baseClose,...reduce,
    type:"TAKE_PROFIT_MARKET",
    quantity:tp1Qty,
    stopPrice:tp1,
    clientOrderId:id("1")
  });

  await sleep(orderGap);

  const tp2Order=await signedBingx(env,"POST",orderPath,{
    ...baseClose,...reduce,
    type:"TAKE_PROFIT_MARKET",
    quantity:tp2Qty,
    stopPrice:tp2,
    clientOrderId:id("2")
  });

  await sleep(orderGap);

  const runnerOrder=await signedBingx(env,"POST",orderPath,{
    ...baseClose,...reduce,
    type:"TRAILING_STOP_MARKET",
    quantity:runnerQty,
    activationPrice:tp2,
    priceRate:+runnerRate.toFixed(4),
    clientOrderId:id("r")
  });

  return {
    mode:execMode,
    symbol:p.symbol,
    direction:p.direction,
    score:fresh.score,
    entry:fresh.entry,
    stop,tp1,tp2,qty,
    tp1Qty,tp2Qty,runnerQty,
    runnerRatePct:+(runnerRate*100).toFixed(2),
    leverage:CFG.leverage,
    marginUSDT:CFG.liveMarginUSDT,
    maxOpenPositions:CFG.maxOpenPositions,
    entryOrder:entry,
    tp1Order,tp2Order,runnerOrder
  };
}

function paperTrackerStub(env){
  if(!env?.PAPER_TRACKER)throw new Error("PAPER_TRACKER binding eksik");
  const id=env.PAPER_TRACKER.idFromName("global");
  return env.PAPER_TRACKER.get(id);
}

async function paperTick(env,data){
  const stub=paperTrackerStub(env);
  const res=await stub.fetch("https://paper.local/tick",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      scannedAt:data.scannedAt,
      signals:data.signals||[]
    })
  });
  if(!res.ok)throw new Error(`Paper tracker HTTP ${res.status}`);
  return res.json();
}

async function paperSnapshot(env){
  const stub=paperTrackerStub(env);
  const res=await stub.fetch("https://paper.local/stats");
  if(!res.ok)throw new Error(`Paper tracker HTTP ${res.status}`);
  return res.json();
}

function legR(trade,price){
  const risk=Math.abs(Number(trade.entry)-Number(trade.initialStop));
  if(!(risk>0))return 0;
  const signed=trade.direction==="LONG"
    ? (Number(price)-Number(trade.entry))
    : (Number(trade.entry)-Number(price));
  return signed/risk;
}

function closePaperFraction(trade,price,fraction,label,at){
  const f=Math.max(0,Math.min(1,Number(fraction)||0));
  if(!(f>0))return;
  const r=legR(trade,price);
  trade.realizedR=Number(trade.realizedR||0)+r*f;
  trade.closedFraction=Number(trade.closedFraction||0)+f;
  trade.exits=Array.isArray(trade.exits)?trade.exits:[];
  trade.exits.push({
    label,
    price:+Number(price).toFixed(8),
    fraction:+f.toFixed(4),
    r:+r.toFixed(4),
    at
  });
}

function finishPaperTrade(trade,status,price,fraction,label,at){
  if(fraction>0)closePaperFraction(trade,price,fraction,label,at);
  trade.status=status;
  trade.closedAt=at;
  trade.closePrice=+Number(price).toFixed(8);
  trade.realizedR=+Number(trade.realizedR||0).toFixed(4);
  trade.closedFraction=+Math.min(1,Number(trade.closedFraction||0)).toFixed(4);
  trade.holdMinutes=Math.max(0,Math.round((Date.parse(at)-Date.parse(trade.createdAt))/60000));
  return trade;
}

function evaluatePaperBar(trade,bar){
  if(!trade||trade.status!=="OPEN")return false;
  const at=new Date(Number(bar.time)||Date.now()).toISOString();
  const high=Number(bar.high),low=Number(bar.low);
  if(!(high>0)||!(low>0))return false;

  const long=trade.direction==="LONG";
  const stop=Number(trade.currentStop);
  const tp1=Number(trade.tp1);
  const tp2=Number(trade.tp2);

  // Runner daha önce aktifse, önce bir önceki bardan kalan trailing stop kontrol edilir.
  // Yeni bar içindeki yeni tepe/dip, aynı barın stop seviyesini geriye dönük değiştirmez.
  if(trade.tp2Hit){
    const remaining=Math.max(0,1-Number(trade.closedFraction||0));
    if(!(remaining>0)){
      trade.status="CLOSED";
      trade.closedAt=at;
      return true;
    }

    if(long){
      const priorHigh=Number(trade.runnerExtreme||tp2);
      const trail=Math.max(Number(trade.entry),priorHigh*(1-Number(trade.runnerTrailRate||0)));
      if(low<=trail){
        finishPaperTrade(trade,"CLOSED_RUNNER",trail,remaining,"RUNNER_TRAIL",at);
        return true;
      }
      trade.runnerExtreme=Math.max(priorHigh,high);
      trade.currentStop=Math.max(Number(trade.entry),trade.runnerExtreme*(1-Number(trade.runnerTrailRate||0)));
    }else{
      const priorLow=Number(trade.runnerExtreme||tp2);
      const trail=Math.min(Number(trade.entry),priorLow*(1+Number(trade.runnerTrailRate||0)));
      if(high>=trail){
        finishPaperTrade(trade,"CLOSED_RUNNER",trail,remaining,"RUNNER_TRAIL",at);
        return true;
      }
      trade.runnerExtreme=Math.min(priorLow,low);
      trade.currentStop=Math.min(Number(trade.entry),trade.runnerExtreme*(1+Number(trade.runnerTrailRate||0)));
    }
    return false;
  }

  // TP1 görülmeden aynı 1dk mumda hem stop hem hedef varsa konservatif olarak stop önce sayılır.
  if(!trade.tp1Hit){
    const stopHit=long?low<=stop:high>=stop;
    const tp1Hit=long?high>=tp1:low<=tp1;
    if(stopHit){
      const remaining=Math.max(0,1-Number(trade.closedFraction||0));
      finishPaperTrade(trade,"CLOSED_SL",stop,remaining,"SL",at);
      return true;
    }
    if(tp1Hit){
      closePaperFraction(trade,tp1,Number(trade.tp1ClosePct||25)/100,"TP1",at);
      trade.tp1Hit=true;
      trade.tp1At=at;
      trade.currentStop=Number(trade.entry); // plan: TP1 sonrası kalan pozisyon BE
    }else{
      return false;
    }
  }

  // TP1 sonrası aynı mum girişe döndüyse, TP2'den önce BE varsayılır (konservatif).
  const beStop=Number(trade.currentStop);
  const beHit=long?low<=beStop:high>=beStop;
  const tp2Hit=long?high>=tp2:low<=tp2;
  if(beHit){
    const remaining=Math.max(0,1-Number(trade.closedFraction||0));
    finishPaperTrade(trade,"CLOSED_BE",beStop,remaining,"BREAK_EVEN",at);
    return true;
  }

  if(tp2Hit){
    closePaperFraction(trade,tp2,Number(trade.tp2ClosePct||25)/100,"TP2",at);
    trade.tp2Hit=true;
    trade.tp2At=at;
    trade.runnerExtreme=tp2;
    trade.runnerActivatedAt=at;
    // Aktivasyon mumunda trailing stop çalıştırılmıyor; sonraki 1dk mumdan itibaren izleniyor.
    return false;
  }

  return false;
}

function paperSummary(trades){
  const all=Array.isArray(trades)?trades:[];
  const open=all.filter(t=>t.status==="OPEN");
  const closed=all.filter(t=>t.status!=="OPEN");
  const wins=closed.filter(t=>Number(t.realizedR)>0.0001);
  const losses=closed.filter(t=>Number(t.realizedR)<-0.0001);
  const breakeven=closed.length-wins.length-losses.length;
  const avgR=closed.length?closed.reduce((a,t)=>a+Number(t.realizedR||0),0)/closed.length:0;
  const totalR=closed.reduce((a,t)=>a+Number(t.realizedR||0),0);
  const tp1=closed.filter(t=>t.tp1Hit).length;
  const tp2=closed.filter(t=>t.tp2Hit).length;

  const byScore={};
  for(const t of closed){
    const key=String(Number(t.score||0).toFixed(2));
    if(!byScore[key])byScore[key]={count:0,wins:0,totalR:0};
    byScore[key].count++;
    if(Number(t.realizedR)>0.0001)byScore[key].wins++;
    byScore[key].totalR+=Number(t.realizedR||0);
  }
  for(const v of Object.values(byScore)){
    v.winRatePct=v.count?+(100*v.wins/v.count).toFixed(1):0;
    v.avgR=v.count?+(v.totalR/v.count).toFixed(3):0;
    v.totalR=+v.totalR.toFixed(3);
  }

  const byDirection={};
  for(const dir of ["LONG","SHORT"]){
    const arr=closed.filter(t=>t.direction===dir);
    const w=arr.filter(t=>Number(t.realizedR)>0.0001).length;
    byDirection[dir]={
      count:arr.length,
      winRatePct:arr.length?+(100*w/arr.length).toFixed(1):0,
      avgR:arr.length?+(arr.reduce((a,t)=>a+Number(t.realizedR||0),0)/arr.length).toFixed(3):0
    };
  }

  return {
    sampleSize:all.length,
    open:open.length,
    closed:closed.length,
    wins:wins.length,
    losses:losses.length,
    breakeven,
    winRatePct:closed.length?+(100*wins.length/closed.length).toFixed(1):0,
    avgR:+avgR.toFixed(3),
    totalR:+totalR.toFixed(3),
    tp1RatePct:closed.length?+(100*tp1/closed.length).toFixed(1):0,
    tp2RatePct:closed.length?+(100*tp2/closed.length).toFixed(1):0,
    byScore,
    byDirection,
    methodology:"1dk mum; aynı mumda stop+hedef varsa konservatif olarak stop/BE önce; TP1 sonrası BE; TP2 sonrası sabit ATR-oranlı runner trailing; ücret/slippage hariç"
  };
}

export class PaperTracker{
  constructor(state,env){
    this.state=state;
    this.env=env;
  }

  async loadTrades(){
    return (await this.state.storage.get("trades"))||[];
  }

  async saveTrades(trades){
    const trimmed=trades
      .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
      .slice(0,CFG.paperMaxTrades);
    await this.state.storage.put("trades",trimmed);
    return trimmed;
  }

  async addSignals(trades,signals,scannedAt){
    const now=Date.parse(scannedAt)||Date.now();
    let added=0;

    for(const s of (Array.isArray(signals)?signals:[])){
      if(!s?.qualifies||!s?.symbol||!["LONG","SHORT"].includes(s.direction))continue;

      // Aynı coin için açık paper işlem varken ikinci işlem açma.
      if(trades.some(t=>t.status==="OPEN"&&t.symbol===s.symbol))continue;

      // 15dk stratejide aynı yönün art arda aynı hareketi çoğaltmaması için 30dk cooldown.
      const recent=trades.find(t=>
        t.symbol===s.symbol&&t.direction===s.direction&&
        now-Date.parse(t.createdAt)<CFG.paperCooldownMs
      );
      if(recent)continue;

      const risk=Math.abs(Number(s.entry)-Number(s.stop));
      if(!(risk>0)||!(Number(s.tp1)>0)||!(Number(s.tp2)>0))continue;

      const runnerTrailRate=Math.max(
        0.005,
        Math.min(0.05,((Number(s.runnerTrailATR)||1.5)*(Number(s.atr1hPct)||1))/100)
      );

      const createdMs=Date.parse(scannedAt)||Date.now();
      const firstFullMinute=Math.floor(createdMs/60000)*60000+60000;

      trades.push({
        id:`${s.symbol}:${s.direction}:${createdMs}`,
        symbol:s.symbol,
        direction:s.direction,
        score:Number(s.score),
        entry:Number(s.entry),
        initialStop:Number(s.stop),
        currentStop:Number(s.stop),
        tp1:Number(s.tp1),
        tp2:Number(s.tp2),
        targetR:Number(s.targetR||3),
        stopPct:Number(s.stopPct||0),
        tp1ClosePct:Number(s.tp1ClosePct||25),
        tp2ClosePct:Number(s.tp2ClosePct||25),
        runnerPct:Number(s.runnerPct||50),
        runnerTrailATR:Number(s.runnerTrailATR||1.5),
        runnerTrailRate,
        atr1hPct:Number(s.atr1hPct||0),
        createdAt:new Date(createdMs).toISOString(),
        firstTrackMinute:firstFullMinute,
        lastProcessedMinute:firstFullMinute-60000,
        lastCheckedAt:new Date(createdMs).toISOString(),
        status:"OPEN",
        tp1Hit:false,
        tp2Hit:false,
        closedFraction:0,
        realizedR:0,
        exits:[],
        reasons:Array.isArray(s.reasons)?s.reasons.slice(0,12):[]
      });
      added++;
    }
    return added;
  }

  async trackOpenTrades(trades){
    const open=trades
      .filter(t=>t.status==="OPEN")
      .sort((a,b)=>Date.parse(a.lastCheckedAt||a.createdAt)-Date.parse(b.lastCheckedAt||b.createdAt))
      .slice(0,CFG.paperTrackPerTick);

    const closedNow=[];

    for(const trade of open){
      try{
        const rows=await getKlines(trade.symbol,"1m",CFG.paperKlineLimit);
        const minTime=Math.max(
          Number(trade.firstTrackMinute||0),
          Number(trade.lastProcessedMinute||0)+60000
        );
        const bars=rows.filter(r=>Number(r.time)>=minTime).sort((a,b)=>a.time-b.time);

        for(const bar of bars){
          if(trade.status!=="OPEN")break;
          evaluatePaperBar(trade,bar);
          trade.lastProcessedMinute=Number(bar.time);
        }
        trade.lastCheckedAt=new Date().toISOString();

        if(trade.status!=="OPEN")closedNow.push(trade);
      }catch(e){
        trade.lastTrackError=String(e?.message||e).slice(0,220);
        trade.lastCheckedAt=new Date().toISOString();
      }
      await sleep(180);
    }

    return closedNow;
  }

  async notifyClosed(closedNow){
    for(const t of closedNow){
      const approxGrossPct=Number(t.realizedR||0)*Number(t.stopPct||0)*CFG.leverage;
      const resultLabel=
        t.status==="CLOSED_SL"?"SL":
        t.status==="CLOSED_BE"?"TP1 + BE":
        t.status==="CLOSED_RUNNER"?(t.tp2Hit?"TP1 + TP2 + RUNNER":"RUNNER"):
        t.status;

      const msg=[
        `${t.symbol} ${t.direction} · skor ${t.score}/10`,
        `Sonuç: ${resultLabel}`,
        `Gerçekleşen: ${t.realizedR>=0?"+":""}${Number(t.realizedR).toFixed(2)}R`,
        `5x brüt yaklaşık: ${approxGrossPct>=0?"+":""}%${Math.abs(approxGrossPct).toFixed(2)}`,
        `TP1: ${t.tp1Hit?"✅":"—"} · TP2: ${t.tp2Hit?"✅":"—"} · Süre: ${t.holdMinutes??"-"} dk`,
        `Paper takip; ücret ve slippage hariç.`
      ].join("\n");

      await sendPrimary(this.env,"PAPER SONUÇ",msg).catch(()=>{});
      await sleep(500);
    }
  }

  async fetch(request){
    const url=new URL(request.url);

    if(url.pathname==="/tick"){
      const body=await request.json().catch(()=>({}));
      let trades=await this.loadTrades();
      const added=await this.addSignals(trades,body?.signals,body?.scannedAt||new Date().toISOString());
      const closedNow=await this.trackOpenTrades(trades);
      trades=await this.saveTrades(trades);
      if(closedNow.length)await this.notifyClosed(closedNow);
      return Response.json({
        ok:true,
        added,
        closedNow:closedNow.map(t=>({symbol:t.symbol,direction:t.direction,status:t.status,realizedR:t.realizedR})),
        stats:paperSummary(trades)
      });
    }

    if(url.pathname==="/stats"){
      const trades=await this.loadTrades();
      const sorted=[...trades].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      return Response.json({
        ok:true,
        stats:paperSummary(sorted),
        trades:sorted.slice(0,100).map(t=>({
          id:t.id,symbol:t.symbol,direction:t.direction,score:t.score,
          entry:t.entry,stop:t.initialStop,tp1:t.tp1,tp2:t.tp2,
          createdAt:t.createdAt,status:t.status,closedAt:t.closedAt||null,
          realizedR:Number(t.realizedR||0),holdMinutes:t.holdMinutes??null,
          tp1Hit:Boolean(t.tp1Hit),tp2Hit:Boolean(t.tp2Hit),
          exits:t.exits||[],lastTrackError:t.lastTrackError||null
        }))
      });
    }

    return new Response("Not Found",{status:404});
  }
}

async function sendSignalAlerts(env,data){
  if(!data?.signals?.length)return;
  const base=String(env?.PUBLIC_BASE_URL||"https://bingx-paper-bot.yasinaltas39.workers.dev").replace(/\/$/,"");
  const execMode=String(env?.EXECUTION_MODE||"TEST").toUpperCase();

  for(const x of data.signals){
    const token=(env?.BINGX_API_KEY&&env?.BINGX_SECRET_KEY&&env?.TRADE_APPROVAL_SECRET)
      ? await makeApprovalToken(env,x,data.scannedAt)
      : null;

    const message=[
      `${x.symbol} ${x.direction} ${x.score}/10`,
      `Giriş: ${x.entry}`,
      `SL: ${x.stop??"-"} (${x.stopPct??"-"}%)`,
      `TP1: ${x.tp1??"-"} · %${x.tp1ClosePct} kapat`,
      `TP2: ${x.tp2??"-"} · %${x.tp2ClosePct} kapat`,
      `Runner: kalan %${x.runnerPct} · TP2 sonrası ATR trailing`,
      `4s/1s/15dk: ${x.trend4h}/${x.trend1h}/${x.trend15m}`,
      `Hacim: ${x.volumeRatio??"-"}x | Alış: ${x.buyPressurePct??"-"}% | Satış: ${x.sellPressurePct??"-"}%`,
      `${(x.reasons||[]).join(" · ")}`,
      execMode==="LIVE"?(token?`İşlem bağlantısı ${Math.round(CFG.approvalTtlMs/60000)} dk geçerli; açınca sinyal yeniden kontrol edilir.`:"İşlem bağlantısı oluşturulamadı."):"AUTO PAPER: sinyal kaydedildi; sonucu sistem kendisi takip edecek. TEST butonuna basman gerekmiyor."
    ].join("\n");

    const actionUrl=token?`${base}/signal?token=${encodeURIComponent(token)}`:base;
    const actionLabel=token
      ? (execMode==="LIVE"?`${x.direction} AÇ`:"PAPER DETAY")
      : "Bot sitesini aç";

    try{
      await sendPrimary(env,`BingX ${x.direction} ${x.score}/10 · V2.14`,message,actionUrl,actionLabel);
    }catch(e){
      console.error("ALERT_ERROR",String(e?.message||e));
    }

    if(data.signals.length>1)await sleep(1200);
  }
}

function page(data,execMode="KAPALI",paper=null){
  const cards=data.all.map(x=>{
    if(x.error)return `<div class="card"><b>${x.symbol}</b><div class="bad">${x.error}</div></div>`;
    const cls=x.qualifies?"good":"muted";
    const tradeButton=x.qualifies&&x.approvalToken
      ? `<button class="tradeBtn" onclick='runTrade(this,${JSON.stringify(x.approvalToken)},${JSON.stringify(`${x.direction} ${execMode==="LIVE"?"AÇ":"TEST"}`)})'>${x.direction} ${execMode==="LIVE"?"AÇ":"TEST"}</button>`
      : "";
    return `<div class="card"><div class="row"><b>${x.symbol}</b><span class="${cls}">${x.direction} · ${x.score}/10</span></div>
    <div>Fiyat: ${x.price}</div><div>4s/1s/15dk: ${x.trend4h} / ${x.trend1h} / ${x.trend15m}</div>
    <div>RSI: ${x.rsi} · Hacim: ${x.volumeRatio}x · ATR: ${x.atrPct}% · ADX4s: ${x.adx4h??"-"}</div>
    <div>Alış baskısı*: ${x.buyPressurePct??"-"}% · Satış baskısı*: ${x.sellPressurePct??"-"}%</div>
    <div>EMA200: ${x.ema200Aligned?"UYUMLU":"-"}</div><div>Giriş: ${x.entry}</div>
    <div>SL: ${x.stop??"-"} (${x.stopPct??"-"}%) · TP1: ${x.tp1??"-"} (${x.tp1MovePct??"-"}%) · TP2: ${x.tp2??"-"} (${x.tp2MovePct??"-"}%)</div>
    <div>Plan: TP1 %${x.tp1ClosePct} · TP2 %${x.tp2ClosePct} · Runner %${x.runnerPct}</div>
    <div>Runner: TP2 sonrası ATR trailing · TP1 sonrası SL girişe taşıma henüz otomatik değil</div>
    <div>5x brüt teorik: TP1 ≈ %${x.grossTp1Pct??"-"} · TP2 ≈ %${x.grossTp2Pct??"-"} <small>(ücret/slippage hariç)</small></div>
    <small>${(x.reasons||[]).join(" · ")||"Teyit yetersiz"}</small>${tradeButton}</div>`;
  }).join("");

  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.head{margin-bottom:14px}.card{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.tradeBtn{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;font-weight:700;font-size:16px}.tradeBtn:disabled{opacity:.55}.notifyBtn{margin:10px 0 4px;padding:10px 14px;border:0;border-radius:10px;font-weight:700}</style>
  <div class="head"><h2>BingX Paper Bot · Top100 V2.14</h2><div>Tarama: PAPER · İşlem köprüsü: ${execMode} · Eşik: ${data.minScore}/10 · BTC: ${data.btcDirection}</div>
  <div>4s + 1s + 15dk · 5x isolated · 20 USDT margin · LIVE max 5 pozisyon · TEST=AUTO PAPER</div>
  <div>${paper?.stats?`AUTO PAPER: ${paper.stats.open} açık · ${paper.stats.closed} kapanan · Win %${paper.stats.winRatePct} · Ort. ${paper.stats.avgR}R`:"AUTO PAPER: başlatılıyor..."}</div>
  <button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button>
  ${execMode!=="KAPALI"?`<button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button>`:""}
  <div>Top100 likit evren · Dilim ${data.shard}/${data.shardCount} · Bu tur ${data.all.length} coin</div><small>*15dk mum fiyat-konumu ve hacminden hesaplanan tahmini baskı · Son tarama: ${data.scannedAt}</small></div>${cards}
  <script>
  async function testNotify(btn){
    const old=btn?.textContent;
    if(btn){btn.disabled=true;btn.textContent="Gönderiliyor...";}
    try{
      const res=await fetch("/notify-test",{method:"POST"});
      const out=await res.json();
      if(!res.ok||!out.ok)throw new Error(out.error||"Bildirim testi başarısız");
      alert("Test bildirimi gönderildi");
    }catch(e){alert("Bildirim testi başarısız: "+(e.message||e));}
    finally{if(btn){btn.disabled=false;btn.textContent=old||"BİLDİRİM TESTİ";}}
  }
  async function testBingx(btn){
    if(!confirm("BingX API ve TEST emir yolunu kontrol edelim mi? Bu işlem gerçek pozisyon açmaz."))return;
    const old=btn?.textContent;
    if(btn){btn.disabled=true;btn.textContent="BingX kontrol ediliyor...";}
    try{
      const res=await fetch("/bingx-connection-test",{method:"POST"});
      const out=await res.json();
      if(!res.ok||!out.ok)throw new Error(out.error||"BingX bağlantı testi başarısız");
      alert("BINGX TEST BAŞARILI — API anahtarları ve test emir yolu çalışıyor. Gerçek pozisyon açılmadı.");
    }catch(e){
      alert("BingX bağlantı testi başarısız: "+(e.message||e));
    }finally{
      if(btn){btn.disabled=false;btn.textContent=old||"BINGX BAĞLANTI TESTİ";}
    }
  }

  async function runTrade(btn,token,label){
    if(!confirm(label+" işlemini göndermek istiyor musun?"))return;
    if(btn){btn.disabled=true;btn.textContent="Gönderiliyor...";}
    try{
      const res=await fetch("/trade",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});
      const out=await res.json();
      if(!res.ok||!out.ok)throw new Error(out.error||"İşlem başarısız");
      alert(out.mode==="LIVE"?"Emir açıldı":"TEST başarılı — gerçek pozisyon açılmadı");
    }catch(e){alert("İşlem iptal: "+(e.message||e));}
    finally{if(btn){btn.disabled=false;btn.textContent=label;}}
  }
  </script>`;
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/notify-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{
        const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ","Bildirim kanalı çalışıyor. 7/10+ sinyaller otomatik gönderilecek.");
        return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});
      }catch(e){
        return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{"cache-control":"no-store"}});
      }
    }
    if(url.pathname==="/bingx-connection-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{
        const result=await bingxConnectionTest(env);
        const msg=[
          `${result.symbol} test emri doğrulandı`,
          `TEST miktarı: ${result.quantity} · yaklaşık ${result.notionalUSDT} USDT`,
          `Açık pozisyon: ${result.openPositions}`,
          `Endpoint: ${result.endpoint}`,
          `Gerçek pozisyon açılmadı.`
        ].join("\n");
        await sendPrimary(env,"BingX BAĞLANTI TESTİ BAŞARILI",msg).catch(()=>{});
        return Response.json({ok:true,...result},{headers:{"cache-control":"no-store"}});
      }catch(e){
        const msg=String(e?.message||e);
        await sendPrimary(env,"BingX BAĞLANTI TESTİ BAŞARISIZ",msg).catch(()=>{});
        return Response.json({ok:false,error:msg},{status:400,headers:{"cache-control":"no-store"}});
      }
    }

    if(url.pathname==="/paper-stats"){
      try{
        const snap=await paperSnapshot(env);
        return Response.json(snap,{headers:{"cache-control":"no-store"}});
      }catch(e){
        return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{"cache-control":"no-store"}});
      }
    }

    if(url.pathname==="/signal"){
      try{
        const token=url.searchParams.get("token");
        const payload=await verifyApprovalToken(env,token);
        const execMode=String(env?.EXECUTION_MODE||"TEST").toUpperCase();
        return new Response(signalLandingPage(payload,token,execMode),{
          headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}
        });
      }catch(e){
        return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font-family:-apple-system;background:#0b0d10;color:white;padding:24px">
        <h3>İşlem bağlantısı geçersiz</h3><p>${String(e?.message||e)}</p></body>`,{
          status:400,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}
        });
      }
    }

    if(url.pathname==="/trade"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{
        const ct=request.headers.get("content-type")||"";
        const body=ct.includes("application/json")?await request.json():{};
        const result=await executeApprovedTrade(env,body?.token);
        const title=result.mode==="LIVE"?"BingX EMİR AÇILDI":"BingX TEST BAŞARILI";
        const msg=[`${result.symbol} ${result.direction} ${result.score}/10`,`Miktar: ${result.qty} · ${result.leverage}x · ${result.marginUSDT} USDT margin`,`SL: ${result.stop} · TP1: ${result.tp1} · TP2: ${result.tp2}`,`Runner: ${result.runnerQty} · trailing %${result.runnerRatePct}`,result.mode==="TEST"?"TEST modu: giriş + SL + TP1 + TP2 + runner şablonları doğrulandı; gerçek pozisyon açılmadı.":"LIVE modu: gerçek emir gönderildi."].join("\n");
        await sendPrimary(env,title,msg);
        return Response.json({ok:true,...result},{headers:{"cache-control":"no-store"}});
      }catch(e){
        const msg=String(e?.message||e);
        await sendPrimary(env,"BingX işlem iptal",msg).catch(()=>{});
        return Response.json({ok:false,error:msg},{status:400,headers:{"cache-control":"no-store"}});
      }
    }
    try{
      const data=await scan();
      if(url.pathname==="/json")return Response.json(data,{headers:{"cache-control":"no-store"}});
      const ready=env?.BINGX_API_KEY&&env?.BINGX_SECRET_KEY&&env?.TRADE_APPROVAL_SECRET;
      const execMode=ready?String(env?.EXECUTION_MODE||"TEST").toUpperCase():"KAPALI";
      if(ready){
        for(const x of data.all){
          if(x?.qualifies)x.approvalToken=await makeApprovalToken(env,x,data.scannedAt);
        }
      }
      const paper=await paperSnapshot(env).catch(()=>null);
      return new Response(page(data,execMode,paper),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }catch(e){return new Response(`Bot hatası: ${e.message||e}`,{status:500});}
  },
  async scheduled(controller,env,ctx){
    const data=await scan();
    console.log(JSON.stringify({
      cron:controller.cron,
      scannedAt:data.scannedAt,
      shard:data.shard,
      shardCount:data.shardCount,
      scanned:data.all.length,
      version:"V2.14",
      signals:data.signals.map(x=>({symbol:x.symbol,direction:x.direction,score:x.score}))
    }));
    ctx.waitUntil(paperTick(env,data).catch(e=>console.error("PAPER_TRACK_ERROR",String(e?.message||e))));
    if(data.signals.length)ctx.waitUntil(sendSignalAlerts(env,data).catch(e=>console.error("ALERT_ERROR",String(e?.message||e))));
  },
};
