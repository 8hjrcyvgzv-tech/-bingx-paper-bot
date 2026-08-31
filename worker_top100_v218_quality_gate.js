import baseWorker, { PaperTracker as BasePaperTracker } from "./worker_top100_v217_usd_sign_fix.js";

const BASE_URL = "https://bingx-paper-bot.yasinaltas39.workers.dev";
const V218 = {
  version: "V2.18",
  minScore: 8,
  minAdx4h: 25,
  minVolumeRatio: 1.20,
  minPressurePct: 58,
  maxPaperOpen: 5,
  maxSameDirection: 3,
  cooldownMs: 60 * 60 * 1000,
  alertCooldownMs: 60 * 60 * 1000,
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function esc(v){ return String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

function isSyntheticSymbol(symbol){
  const s=String(symbol||"").toUpperCase();
  return /(?:NCCO|BRENT|WTI|OIL|XAU|XAG|GOLD|SILVER|NASDAQ|SP500|DOW|DJI|FOREX)/.test(s);
}

function hasRealBreakout(x){
  const reasons=Array.isArray(x?.reasons)?x.reasons:[];
  return x?.direction==="LONG"
    ? reasons.some(r=>String(r).includes("20 mumluk tepe kırılımı"))
    : x?.direction==="SHORT"
      ? reasons.some(r=>String(r).includes("20 mumluk dip kırılımı"))
      : false;
}

function v218Checks(x){
  const direction=x?.direction;
  const pressure=direction==="LONG"?num(x?.buyPressurePct):num(x?.sellPressurePct);
  return {
    score:num(x?.score)!=null && Number(x.score)>=V218.minScore,
    direction:["LONG","SHORT"].includes(direction),
    trend:direction && x?.trend4h===direction && x?.trend1h===direction && x?.trend15m===direction,
    ema200:Boolean(x?.ema200Aligned),
    adx:num(x?.adx4h)!=null && Number(x.adx4h)>=V218.minAdx4h,
    volume:num(x?.volumeRatio)!=null && Number(x.volumeRatio)>=V218.minVolumeRatio,
    pressure:pressure!=null && pressure>=V218.minPressurePct,
    breakout:hasRealBreakout(x),
    liquid:!isSyntheticSymbol(x?.symbol),
    baseQualified:Boolean(x?.qualifies),
  };
}

function isV218Signal(x){
  const c=v218Checks(x);
  return Object.values(c).every(Boolean);
}

function rejectReasons(x){
  const c=v218Checks(x), out=[];
  if(!c.score)out.push("skor<8");
  if(!c.trend)out.push("4s/1s/15dk uyumsuz");
  if(!c.ema200)out.push("EMA200");
  if(!c.adx)out.push("ADX<25");
  if(!c.volume)out.push("hacim<1.20x");
  if(!c.pressure)out.push("order-flow<%58");
  if(!c.breakout)out.push("kapanış breakout yok");
  if(!c.liquid)out.push("sentetik/uygunsuz parite");
  if(!c.baseQualified)out.push("risk/hedef şartı");
  return out;
}

function upgradeData(raw){
  const all=(Array.isArray(raw?.all)?raw.all:[]).map(x=>({
    ...x,
    v218Qualifies:isV218Signal(x),
    qualifies:isV218Signal(x),
    v218RejectReasons:rejectReasons(x),
  }));
  const signals=all.filter(x=>x.v218Qualifies).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
  return {...raw,version:"TOP100_V2_18",minScore:V218.minScore,signals,all};
}

async function scanThroughBase(env){
  const res=await baseWorker.fetch(new Request(`${BASE_URL}/json`),env);
  if(!res.ok)throw new Error(`Tarama HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  return upgradeData(await res.json());
}

function trackerStub(env){
  if(!env?.PAPER_TRACKER)throw new Error("PAPER_TRACKER binding eksik");
  return env.PAPER_TRACKER.get(env.PAPER_TRACKER.idFromName("global"));
}

async function paperTick(env,data){
  const res=await trackerStub(env).fetch("https://paper.local/tick",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({scannedAt:data.scannedAt,signals:data.signals||[]})
  });
  if(!res.ok)throw new Error(`Paper tracker HTTP ${res.status}`);
  return res.json();
}

async function paperSnapshot(env){
  const res=await trackerStub(env).fetch("https://paper.local/stats");
  if(!res.ok)throw new Error(`Paper tracker HTTP ${res.status}`);
  return res.json();
}

async function claimAlerts(env,signals,scannedAt){
  const res=await trackerStub(env).fetch("https://paper.local/v218-claim-alerts",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({signals,scannedAt})
  });
  if(!res.ok)return signals;
  const json=await res.json();
  return Array.isArray(json?.signals)?json.signals:signals;
}

async function telegramSend(env,title,message){
  const token=String(env?.TELEGRAM_BOT_TOKEN||"").trim();
  const chatId=String(env?.TELEGRAM_CHAT_ID||"").trim();
  if(!token||!chatId)return false;
  const res=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      chat_id:chatId,
      text:`📈 ${title}\n\n${message}`,
      disable_web_page_preview:true,
      reply_markup:{inline_keyboard:[[{text:"Bot sitesini aç",url:BASE_URL}]]}
    })
  });
  if(!res.ok)throw new Error(`Telegram HTTP ${res.status}`);
  return true;
}

async function ntfyFallback(env,title,message){
  const topic=String(env?.NTFY_TOPIC||"").trim();
  if(!topic)return false;
  let last=0;
  for(let attempt=0;attempt<4;attempt++){
    const res=await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`,{
      method:"POST",headers:{"content-type":"text/plain; charset=utf-8",title,priority:"high",tags:"chart_with_upwards_trend"},body:message
    });
    if(res.ok)return true;
    last=res.status;
    if(res.status!==429&&res.status<500)break;
    if(attempt<3)await sleep(6000*(2**attempt));
  }
  throw new Error(`ntfy HTTP ${last}`);
}

async function sendPrimary(env,title,message){
  try{ if(await telegramSend(env,title,message))return "telegram"; }catch(e){ console.error("TELEGRAM_ERROR",String(e?.message||e)); }
  try{ if(await ntfyFallback(env,title,message))return "ntfy"; }catch(e){ console.error("NTFY_ERROR",String(e?.message||e)); }
  throw new Error("Bildirim kanalı kullanılamıyor");
}

function signalMessage(x){
  return [
    `${x.symbol} ${x.direction} ${x.score}/10`,
    `Giriş: ${x.entry}`,
    `SL: ${x.stop??"-"} (${x.stopPct??"-"}%)`,
    `TP1: ${x.tp1??"-"} · %${x.tp1ClosePct??25} kapat`,
    `TP2: ${x.tp2??"-"} · %${x.tp2ClosePct??25} kapat`,
    `Runner: kalan %${x.runnerPct??50} · TP2 sonrası ATR trailing`,
    `4s/1s/15dk: ${x.trend4h}/${x.trend1h}/${x.trend15m}`,
    `ADX4s: ${x.adx4h??"-"} · Hacim: ${x.volumeRatio??"-"}x`,
    `Alış: ${x.buyPressurePct??"-"}% · Satış: ${x.sellPressurePct??"-"}%`,
    `V2.18 kalite filtresi: 8/10+ · 3 zaman uyumu · EMA200 · ADX≥25 · hacim≥1.20x · baskı≥%58 · kapanış breakout`,
    `AUTO PAPER: sinyal kaydedildi; sonuç otomatik takip edilecek.`
  ].join("\n");
}

function paperSummaryHtml(paper){
  const s=paper?.stats||{};
  const open=Number(s.open||0),closed=Number(s.closed||0),wr=Number(s.winRatePct||0),pnl=Number(s.totalOpenUSDT||0);
  return `AUTO PAPER V2.18: <b>${open} açık</b> · ${closed} kapanan · Win %${wr.toFixed(1)} · Açık toplam <span class="${pnl>0?"good":pnl<0?"bad":"muted"}">${pnl>=0?"+":"-"}$${Math.abs(pnl).toFixed(2)}</span>`;
}

function openPaperHtml(paper){
  const trades=Array.isArray(paper?.trades)?paper.trades.filter(t=>t.status==="OPEN"):[];
  if(!trades.length)return `<div class="muted">Açık V2.18 paper işlem yok.</div>`;
  return trades.map(t=>{
    const usd=num(t.pnlUSDT), cls=usd>0?"good":usd<0?"bad":"muted";
    return `<div class="paperCard"><div class="row"><b>${esc(t.symbol)} · ${esc(t.direction)} · ${esc(t.score)}/10</b><span class="${cls}">${usd==null?"fiyat bekleniyor":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`}</span></div><div>Giriş: ${esc(t.entry)} · Güncel: ${esc(t.currentPrice??"-")}</div><div>SL: ${esc(t.stop)} · TP1: ${esc(t.tp1)} ${t.tp1Hit?"✅":""} · TP2: ${esc(t.tp2)} ${t.tp2Hit?"✅":""}</div></div>`;
  }).join("");
}

function scanCards(data){
  return (data.all||[]).map(x=>{
    if(x.error)return `<div class="card"><b>${esc(x.symbol)}</b><div class="bad">${esc(x.error)}</div></div>`;
    const ok=x.v218Qualifies;
    return `<div class="card"><div class="row"><b>${esc(x.symbol)}</b><span class="${ok?"good":"muted"}">${esc(x.direction)} · ${esc(x.score)}/10 ${ok?"✅":""}</span></div><div>4s/1s/15dk: ${esc(x.trend4h)} / ${esc(x.trend1h)} / ${esc(x.trend15m)}</div><div>EMA200: ${x.ema200Aligned?"✅":"—"} · ADX4s: ${esc(x.adx4h??"-")} · Hacim: ${esc(x.volumeRatio??"-")}x</div><div>Alış: ${esc(x.buyPressurePct??"-")}% · Satış: ${esc(x.sellPressurePct??"-")}%</div><div>Giriş: ${esc(x.entry)} · SL: ${esc(x.stop??"-")} · TP1: ${esc(x.tp1??"-")} · TP2: ${esc(x.tp2??"-")}</div><small>${ok?"V2.18 GİRİŞ UYGUN":`Elendi: ${esc((x.v218RejectReasons||[]).join(" · ")||"filtre")}`}</small></div>`;
  }).join("");
}

function page(data,paper,migration){
  const archived=Number(migration?.archivedTrades||0);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot V2.18</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.card,.paperWrap{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.paperWrap{background:#111419}.paperCard{padding:10px 0;border-bottom:1px solid #2a2f37}.paperCard:last-child{border-bottom:0}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.notifyBtn{margin:10px 6px 4px 0;padding:10px 14px;border:0;border-radius:10px;font-weight:700}</style><div class="head"><h2>BingX Paper Bot · Top100 V2.18</h2><div>Tarama: PAPER · Eşik: <b>8/10</b> · BTC: ${esc(data.btcDirection)}</div><div>Kalite kapısı: 4s+1s+15dk aynı yön · EMA200 · ADX≥25 · hacim≥1.20x · yön baskısı≥%58 · mum kapanışı breakout</div><div>5x isolated · 20 USDT margin · AUTO PAPER max 5 pozisyon · aynı yönde max 3</div><div>${paperSummaryHtml(paper)}</div><div class="muted">V2.17 arşivi: ${archived} işlem saklandı; V2.18 istatistiğine karışmıyor.</div><button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button><button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button><div>Top100 likit evren · Dilim ${esc(data.shard)}/${esc(data.shardCount)} · Bu tur ${(data.all||[]).length} coin · Uygun ${(data.signals||[]).length}</div><small>Son tarama: ${esc(data.scannedAt)}</small></div><div class="paperWrap"><b>AÇIK AUTO PAPER POZİSYONLARI</b>${openPaperHtml(paper)}</div>${scanCards(data)}<script>async function testNotify(btn){const old=btn.textContent;btn.disabled=true;btn.textContent="Gönderiliyor...";try{const r=await fetch('/notify-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('Test bildirimi gönderildi');}catch(e){alert('Bildirim testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}async function testBingx(btn){if(!confirm('BingX API ve TEST emir yolunu kontrol edelim mi? Gerçek pozisyon açılmaz.'))return;const old=btn.textContent;btn.disabled=true;btn.textContent='Kontrol ediliyor...';try{const r=await fetch('/bingx-connection-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('BINGX TEST BAŞARILI — gerçek pozisyon açılmadı.');}catch(e){alert('BingX testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}</script>`;
}

export class PaperTracker extends BasePaperTracker {
  async ensureV218Migration(){
    const marker=await this.state.storage.get("v218_migrated");
    if(marker)return marker;
    const oldTrades=(await this.state.storage.get("trades"))||[];
    const archivedAt=new Date().toISOString();
    const archive={version:"V2.17",archivedAt,trades:oldTrades};
    await this.state.storage.put("archive_v217",archive);
    await this.state.storage.put("trades",[]);
    const m={version:"V2.18",archivedAt,archivedTrades:oldTrades.length};
    await this.state.storage.put("v218_migrated",m);
    await this.state.storage.put("v218_alerts",{});
    return m;
  }

  async addSignals(trades,signals,scannedAt){
    const now=Date.parse(scannedAt)||Date.now();
    const open=trades.filter(t=>t.status==="OPEN");
    let free=Math.max(0,V218.maxPaperOpen-open.length);
    if(!free)return [];
    const dirCount={LONG:open.filter(t=>t.direction==="LONG").length,SHORT:open.filter(t=>t.direction==="SHORT").length};
    const selected=[];
    const sorted=(Array.isArray(signals)?signals:[]).filter(isV218Signal).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)||(Number(b.volumeRatio)||0)-(Number(a.volumeRatio)||0));
    for(const s of sorted){
      if(!free)break;
      if(dirCount[s.direction]>=V218.maxSameDirection)continue;
      if(trades.some(t=>t.symbol===s.symbol && now-Date.parse(t.createdAt)<V218.cooldownMs))continue;
      selected.push(s);dirCount[s.direction]++;free--;
    }
    return super.addSignals(trades,selected,scannedAt);
  }

  async fetch(request){
    const migration=await this.ensureV218Migration();
    const url=new URL(request.url);
    if(url.pathname==="/v218-migration")return Response.json({ok:true,...migration});
    if(url.pathname==="/v218-archive"){
      const archive=(await this.state.storage.get("archive_v217"))||null;
      return Response.json({ok:true,archive});
    }
    if(url.pathname==="/v218-claim-alerts"){
      const body=await request.json().catch(()=>({}));
      const now=Date.parse(body?.scannedAt)||Date.now();
      const history=(await this.state.storage.get("v218_alerts"))||{};
      const allowed=[];
      for(const s of (Array.isArray(body?.signals)?body.signals:[])){
        if(!isV218Signal(s))continue;
        const key=`${s.symbol}:${s.direction}`;
        if(now-Number(history[key]||0)<V218.alertCooldownMs)continue;
        history[key]=now;allowed.push(s);
      }
      for(const [k,t] of Object.entries(history))if(now-Number(t)>24*60*60*1000)delete history[k];
      await this.state.storage.put("v218_alerts",history);
      return Response.json({ok:true,signals:allowed});
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/notify-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ · V2.18","Bildirim kanalı çalışıyor. Yalnızca V2.18 kalite kapısını geçen 8/10+ sinyaller gönderilecek.");return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/json"){
      try{return Response.json(await scanThroughBase(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/paper-stats"){
      try{return Response.json(await paperSnapshot(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/v218-migration"||url.pathname==="/v218-archive")return trackerStub(env).fetch(`https://paper.local${url.pathname}`);

    if(url.pathname==="/"||url.pathname===""){
      try{
        const [data,paper,migRes]=await Promise.all([scanThroughBase(env),paperSnapshot(env),trackerStub(env).fetch("https://paper.local/v218-migration")]);
        const migration=migRes.ok?await migRes.json():{};
        return new Response(page(data,paper,migration),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      }catch(e){return new Response(`Bot hatası: ${String(e?.message||e)}`,{status:500});}
    }

    // Trade, signal landing, BingX connection test and other established routes stay on V2.17's proven execution bridge.
    return baseWorker.fetch(request,env);
  },

  async scheduled(controller,env,ctx){
    const data=await scanThroughBase(env);
    const paper=await paperTick(env,data);
    const alerts=await claimAlerts(env,data.signals||[],data.scannedAt);
    console.log(JSON.stringify({cron:controller.cron,version:"V2.18",scannedAt:data.scannedAt,shard:data.shard,scanned:data.all?.length||0,qualified:data.signals?.length||0,alerts:alerts.length,paper:paper?.stats||null}));
    if(alerts.length){
      ctx.waitUntil((async()=>{
        for(const x of alerts){
          try{await sendPrimary(env,`BingX ${x.direction} ${x.score}/10 · V2.18`,signalMessage(x));}catch(e){console.error("ALERT_ERROR",String(e?.message||e));}
          if(alerts.length>1)await sleep(1200);
        }
      })());
    }
  }
};
