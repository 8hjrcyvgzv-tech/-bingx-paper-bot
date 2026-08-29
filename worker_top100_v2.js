const CFG = {
  minScore: 7,
  leverage: 5,
  paperBalance: 200,
  maxMarginPct: 0.10,
  universeSize: 100,
  shardSize: 14,
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
  const dx = [];
  for (let end = period; end <= tr.length; end++) {
    const trN = sum(tr.slice(end-period, end));
    if (!trN) continue;
    const plusDI = 100 * sum(plusDM.slice(end-period, end)) / trN;
    const minusDI = 100 * sum(minusDM.slice(end-period, end)) / trN;
    const denom = plusDI + minusDI;
    if (denom > 0) dx.push(100 * Math.abs(plusDI - minusDI) / denom);
  }
  if (dx.length < period) return null;
  return avg(dx.slice(-period));
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

function takerPressure(rows, lookback=4) {
  const recent=rows.slice(-lookback);
  const quoteTotal=sum(recent.map(x=>Number(x.quoteVolume||0)));
  const takerBuyQuote=sum(recent.map(x=>Number(x.takerBuyQuote||0)));
  if (!(quoteTotal>0) || !(takerBuyQuote>=0)) return {buyShare:null,sellShare:null};
  const buyShare=Math.max(0,Math.min(1,takerBuyQuote/quoteTotal));
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
  const pressure=takerPressure(m15,4);

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
    if(pressure.buyShare>=0.63){score+=1;reasons.push(`agresif alış %${(pressure.buyShare*100).toFixed(0)}`);}
    else if(pressure.buyShare>=0.58){score+=0.5;reasons.push(`alış baskısı %${(pressure.buyShare*100).toFixed(0)}`);}
  }
  if(direction==="SHORT"&&pressure.sellShare!=null){
    if(pressure.sellShare>=0.63){score+=1;reasons.push(`agresif satış %${(pressure.sellShare*100).toFixed(0)}`);}
    else if(pressure.sellShare>=0.58){score+=0.5;reasons.push(`satış baskısı %${(pressure.sellShare*100).toFixed(0)}`);}
  }

  if(direction==="LONG"&&rr!=null&&rr>=50&&rr<=72){score+=0.5;reasons.push(`RSI ${rr.toFixed(1)}`);}
  if(direction==="SHORT"&&rr!=null&&rr>=28&&rr<=50){score+=0.5;reasons.push(`RSI ${rr.toFixed(1)}`);}
  if(atrPct>=0.35&&atrPct<=2.5){score+=0.5;reasons.push(`ATR ${atrPct.toFixed(2)}%`);}

  score=Math.min(10,Math.round(score*4)/4);

  let stop=null,tp1=null,tp2=null;
  if(direction!=="NEUTRAL"&&a){
    const risk=1.4*a;
    if(direction==="LONG"){stop=last.close-risk;tp1=last.close+1.5*risk;tp2=last.close+2.5*risk;}
    else{stop=last.close+risk;tp1=last.close-1.5*risk;tp2=last.close-2.5*risk;}
  }

  return {
    symbol,direction,score,qualifies:score>=CFG.minScore&&direction!=="NEUTRAL",
    price:+last.close.toFixed(8),rsi:rr==null?null:+rr.toFixed(1),volumeRatio:+volRatio.toFixed(2),
    atrPct:+atrPct.toFixed(2),adx4h:adx4h==null?null:+adx4h.toFixed(1),ema200Aligned:ema200.aligned,
    takerBuyPct:pressure.buyShare==null?null:+(pressure.buyShare*100).toFixed(1),
    takerSellPct:pressure.sellShare==null?null:+(pressure.sellShare*100).toFixed(1),
    trend4h:dir4h,trend1h:dir1h,trend15m:dir15,quoteVolume24h:quoteVolume==null?null:Math.round(quoteVolume),
    entry:+last.close.toFixed(8),stop:stop==null?null:+stop.toFixed(8),tp1:tp1==null?null:+tp1.toFixed(8),tp2:tp2==null?null:+tp2.toFixed(8),
    leverage:CFG.leverage,paperMarginUSDT:+(CFG.paperBalance*CFG.maxMarginPct).toFixed(2),reasons
  };
}

function shardIndexFor(shardCount,date=new Date()){
  if(!shardCount)return 0;
  return Math.floor(date.getTime()/120000)%shardCount;
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
    mode:"PAPER_ONLY",version:"TOP100_V2",scannedAt:new Date().toISOString(),btcDirection:btcDir,minScore:CFG.minScore,
    universe:`BingX top ${top.length} USDT perpetual by 24h quote volume`,shard:shardIndex+1,shardCount,
    scannedSymbols:selected.map(x=>x.symbol),paperBalanceUSDT:CFG.paperBalance,
    signals:results.filter(x=>x.qualifies).sort((a,b)=>b.score-a.score),
    all:results.sort((a,b)=>(b.score||0)-(a.score||0)),
  };
}

async function sendNtfy(env,data){
  if(!env?.NTFY_TOPIC||!data?.signals?.length)return;
  const body=data.signals.map(x=>[
    `${x.symbol} ${x.direction} ${x.score}/10`,
    `Giriş: ${x.entry}`,`SL: ${x.stop??"-"}`,`TP1: ${x.tp1??"-"}`,`TP2: ${x.tp2??"-"}`,
    `4s/1s/15dk: ${x.trend4h}/${x.trend1h}/${x.trend15m}`,
    `Hacim: ${x.volumeRatio??"-"}x | Taker alış: ${x.takerBuyPct??"-"}%`,
    `ADX4s: ${x.adx4h??"-"} | RSI: ${x.rsi??"-"} | ATR: ${x.atrPct??"-"}%`,
    `${(x.reasons||[]).join(" · ")}`,
  ].join("\n")).join("\n\n");

  const res=await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`,{
    method:"POST",
    headers:{"content-type":"text/plain; charset=utf-8",title:"BingX 7/10+ Sinyal · Top100 V2",priority:"high",tags:"chart_with_upwards_trend"},
    body,
  });
  if(!res.ok)throw new Error(`ntfy gönderim hatası: HTTP ${res.status}`);
}

function page(data){
  const cards=data.all.map(x=>{
    if(x.error)return `<div class="card"><b>${x.symbol}</b><div class="bad">${x.error}</div></div>`;
    const cls=x.qualifies?"good":"muted";
    return `<div class="card"><div class="row"><b>${x.symbol}</b><span class="${cls}">${x.direction} · ${x.score}/10</span></div>
    <div>Fiyat: ${x.price}</div><div>4s/1s/15dk: ${x.trend4h} / ${x.trend1h} / ${x.trend15m}</div>
    <div>RSI: ${x.rsi} · Hacim: ${x.volumeRatio}x · ATR: ${x.atrPct}% · ADX4s: ${x.adx4h??"-"}</div>
    <div>Taker alış: ${x.takerBuyPct??"-"}% · Taker satış: ${x.takerSellPct??"-"}%</div>
    <div>EMA200: ${x.ema200Aligned?"UYUMLU":"-"}</div><div>Giriş: ${x.entry}</div>
    <div>SL: ${x.stop??"-"} · TP1: ${x.tp1??"-"} · TP2: ${x.tp2??"-"}</div>
    <small>${(x.reasons||[]).join(" · ")||"Teyit yetersiz"}</small></div>`;
  }).join("");

  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.head{margin-bottom:14px}.card{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.bad{color:#fb7185}.muted,small{color:#a1a1aa}</style>
  <div class="head"><h2>BingX Paper Bot · Top100 V2</h2><div>Mod: PAPER ONLY · Eşik: ${data.minScore}/10 · BTC: ${data.btcDirection}</div>
  <div>4s + 1s + 15dk · Hacim + kırılım + EMA200 + ADX + Taker</div>
  <div>Top100 likit evren · Dilim ${data.shard}/${data.shardCount} · Bu tur ${data.all.length} coin</div><small>Son tarama: ${data.scannedAt}</small></div>${cards}`;
}

export default {
  async fetch(request){
    try{
      const data=await scan(),url=new URL(request.url);
      if(url.pathname==="/json")return Response.json(data,{headers:{"cache-control":"no-store"}});
      return new Response(page(data),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }catch(e){return new Response(`Bot hatası: ${e.message||e}`,{status:500});}
  },
  async scheduled(controller,env,ctx){
    const data=await scan();
    console.log(JSON.stringify({cron:controller.cron,...data}));
    if(data.signals.length)ctx.waitUntil(sendNtfy(env,data));
  },
};
