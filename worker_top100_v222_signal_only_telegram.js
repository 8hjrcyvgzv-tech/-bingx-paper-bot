import baseWorker, { PaperTracker as BasePaperTracker } from "./worker_top100_v217_usd_sign_fix.js";
import { enrichBelitData, isV221Signal, stageLabel, publicStatusLabel } from "./belit_daily_v221.js";

const BASE_URL = "https://bingx-paper-bot.yasinaltas39.workers.dev";
const V219 = {
  version: "V2.19",
  minScore: 8,
  minAdx4h: 22,
  minVolumeRatio: 1.05,
  minPressurePct: 55,
  maxPaperOpen: 5,
  maxSameDirection: 3,
  cooldownMs: 60 * 60 * 1000,
  alertCooldownMs: 60 * 60 * 1000,
  watchCooldownMs: 4 * 60 * 60 * 1000,
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

function hasRetestOrContinuation(x){
  const reasons=Array.isArray(x?.reasons)?x.reasons.map(String):[];
  if(x?.direction==="LONG") return reasons.some(r=>r.includes("tepe kırılımına 0.2 ATR içinde"));
  if(x?.direction==="SHORT") return reasons.some(r=>r.includes("dip kırılımına 0.2 ATR içinde"));
  return false;
}

function hasEntryTrigger(x){
  return hasRealBreakout(x) || hasRetestOrContinuation(x) || x?.trend15m===x?.direction;
}

function v219Checks(x){
  const direction=x?.direction;
  const pressure=direction==="LONG"?num(x?.buyPressurePct):num(x?.sellPressurePct);
  return {
    score:num(x?.score)!=null && Number(x.score)>=V219.minScore,
    direction:["LONG","SHORT"].includes(direction),
    trend:direction && x?.trend4h===direction && x?.trend1h===direction,
    entryTrigger:hasEntryTrigger(x),
    ema200:Boolean(x?.ema200Aligned),
    adx:num(x?.adx4h)!=null && Number(x.adx4h)>=V219.minAdx4h,
    volume:num(x?.volumeRatio)!=null && Number(x.volumeRatio)>=V219.minVolumeRatio,
    pressure:pressure!=null && pressure>=V219.minPressurePct,
    liquid:!isSyntheticSymbol(x?.symbol),
    baseQualified:Boolean(x?.qualifies),
  };
}

function isV219Signal(x){
  const c=v219Checks(x);
  return Object.values(c).every(Boolean);
}

function rejectReasons(x){
  const c=v219Checks(x), out=[];
  if(!c.score)out.push("skor<8");
  if(!c.trend)out.push("4s/1s ana trend uyumsuz");
  if(!c.entryTrigger)out.push("15dk tetik/retest/breakout yok");
  if(!c.ema200)out.push("EMA200");
  if(!c.adx)out.push("ADX<22");
  if(!c.volume)out.push("hacim<1.05x");
  if(!c.pressure)out.push("order-flow<%55");
  if(!c.liquid)out.push("sentetik/uygunsuz parite");
  if(!c.baseQualified)out.push("risk/hedef şartı");
  return out;
}

function upgradeData(raw){
  const all=(Array.isArray(raw?.all)?raw.all:[]).map(x=>({
    ...x,
    v219Qualifies:isV219Signal(x),
    qualifies:isV219Signal(x),
    v219RejectReasons:rejectReasons(x),
  }));
  const signals=all.filter(x=>x.v219Qualifies).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
  return {...raw,version:"TOP100_V2_19",minScore:V219.minScore,signals,all};
}

async function scanThroughBase(env){
  const res=await baseWorker.fetch(new Request(`${BASE_URL}/json`),env);
  if(!res.ok)throw new Error(`Tarama HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  return enrichBelitData(upgradeData(await res.json()));
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
  const res=await trackerStub(env).fetch("https://paper.local/v219-claim-alerts",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({signals,scannedAt})
  });
  if(!res.ok)return signals;
  const json=await res.json();
  return Array.isArray(json?.signals)?json.signals:signals;
}

async function claimWatch(env,watch,scannedAt){
  const res=await trackerStub(env).fetch("https://paper.local/v220-claim-watch",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({watch,scannedAt})
  });
  if(!res.ok)return watch;
  const json=await res.json();
  return Array.isArray(json?.watch)?json.watch:watch;
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
    `${x.symbol} ${x.direction} · ${x.isCore5?"CORE5":"GENİŞ TARAMA"}`,
    `${publicStatusLabel(x.publicStatus)} · Setup ${x.setupQuality??"-"}/10 · Execution ${x.executionScore??x.entryQuality??"-"}/10 · Klasik ${x.score}/10`,
    `Giriş: ${x.entry}`,
    `SL: ${x.stop??"-"} (${x.stopPct??"-"}%)`,
    `TP1: ${x.tp1??"-"} · TP2: ${x.tp2??"-"}`,
    `Sınır: ${x.boundary??"-"} · test ${x.boundaryTests??0} (${x.boundaryTestQuality??"-"}) · mesafe ${x.distanceToBoundaryPct??"-"}%`,
    `1G ADR20 %${x.adr20Pct??"-"} · ATR20 %${x.atr20DailyPct??"-"} · volatilite ${x.volatilitySanity??"-"} · sıkışma ${x.compressionRatio??"-"}x · SMA ${x.smaDaily??"-"}`,
    `4s/1s/15dk: ${x.trend4h}/${x.trend1h}/${x.trend15m} · ADX4s ${x.adx4h??"-"} · Hacim ${x.volumeRatio??"-"}x`,
    `AUTO PAPER: gerçek tetik teyitli; uzamış hareket kovalanmadı.`
  ].join("\n");
}

function watchMessage(x){
  const missing=x.publicStatus==="ARMED"?"kalıcı kırılım + hacim":"sınıra yaklaşım + kalıcı kırılım + hacim";
  return [
    `${x.symbol} ${x.direction} · ${x.isCore5?"CORE5":"GENİŞ TARAMA"}`,
    `${publicStatusLabel(x.publicStatus)} · Setup ${x.setupQuality??"-"}/10 · Tetik ${x.triggerReadiness??x.entryQuality??"-"}/10 · ŞİMDİ GİRİŞ YOK`,
    `Ana sınır: ${x.boundary??"-"} · ${x.boundaryTests??0} test (${x.boundaryTestQuality??"-"}) · mesafe ${x.distanceToBoundaryPct??"-"}%`,
    `Sıkışma ${x.compressionRatio??"-"}x · yönlü sıkışma ${x.directionalSqueeze?"EVET":"-"}`,
    `1G SMA ${x.smaDaily??"-"} · ADR20 %${x.adr20Pct??"-"} · ATR20 %${x.atr20DailyPct??"-"} · volatilite ${x.volatilitySanity??"-"}`,
    `Eksik teyit: ${missing}. Kırılım uzarsa KOVALAMA; retest bekle.`
  ].join("\n");
}

function paperSummaryHtml(paper){
  const s=paper?.stats||{};
  const open=Number(s.open||0),closed=Number(s.closed||0),wr=Number(s.winRatePct||0),pnl=Number(s.totalOpenUSDT||0);
  return `AUTO PAPER V2.22: <b>${open} açık</b> · ${closed} kapanan · Win %${wr.toFixed(1)} · Açık toplam <span class="${pnl>0?"good":pnl<0?"bad":"muted"}">${pnl>=0?"+":"-"}$${Math.abs(pnl).toFixed(2)}</span>`;
}

function openPaperHtml(paper){
  const trades=Array.isArray(paper?.trades)?paper.trades.filter(t=>t.status==="OPEN"):[];
  if(!trades.length)return `<div class="muted">Açık paper işlem yok.</div>`;
  return trades.map(t=>{
    const usd=num(t.pnlUSDT), cls=usd>0?"good":usd<0?"bad":"muted";
    const meta=t.scannerVersion==="V2.22"?` · Setup ${esc(t.setupQuality??"-")}/10 · Execution ${esc(t.executionScore??t.entryQuality??"-")}/10 · ${esc(publicStatusLabel(t.publicStatus||"WAIT"))}`:"";
    return `<div class="paperCard"><div class="row"><b>${esc(t.symbol)} · ${esc(t.direction)} · ${esc(t.score)}/10${meta}</b><span class="${cls}">${usd==null?"fiyat bekleniyor":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`}</span></div><div>Giriş: ${esc(t.entry)} · Güncel: ${esc(t.currentPrice??"-")}</div><div>SL: ${esc(t.stop)} · TP1: ${esc(t.tp1)} ${t.tp1Hit?"✅":""} · TP2: ${esc(t.tp2)} ${t.tp2Hit?"✅":""}</div></div>`;
  }).join("");
}

function scanCards(data){
  return (data.all||[]).map(x=>{
    if(x.error)return `<div class="card"><b>${esc(x.symbol)}</b><div class="bad">${esc(x.error)}</div></div>`;
    const ok=Boolean(x.v221Qualifies), watch=Boolean(x.belitWatchCandidate);
    const status=publicStatusLabel(x.publicStatus||"WAIT");
    const cls=ok?"good":watch?"warn":x.publicStatus==="MISSED"?"bad":"muted";
    const baseReject=(x.v219RejectReasons||[]).join(" · ")||"filtre";
    const reason=x.belitExtended?"ADR/ATR açısından uzamış; kovalanmaz":x.publicStatus==="WAIT"?baseReject:"tetik henüz tamamlanmadı";
    const exec=x.executionScore==null?"—":`${esc(x.executionScore)}/10`;
    return `<div class="card"><div class="row"><b>${esc(x.symbol)} ${x.isCore5?"· CORE5":"· GENİŞ"}</b><span class="${cls}">${esc(status)}</span></div><div>Setup <b>${esc(x.setupQuality??"-")}/10</b> · Tetik <b>${esc(x.triggerReadiness??x.entryQuality??"-")}/10</b> · Execution <b>${exec}</b> · Klasik ${esc(x.score)}/10</div><div>Sınır ${esc(x.boundary??"-")} · test ${esc(x.boundaryTests??0)} (${esc(x.boundaryTestQuality??"-")}) · mesafe ${esc(x.distanceToBoundaryPct??"-")}% · kalıcılık ${x.persistentBreakout?"✅":"—"}</div><div>1G SMA ${esc(x.smaDaily??"-")} · ADR20 %${esc(x.adr20Pct??"-")} · ATR20 %${esc(x.atr20DailyPct??"-")} · volatilite ${esc(x.volatilitySanity??"-")} · sıkışma ${esc(x.compressionRatio??"-")}x</div><div>4s/1s/15dk ${esc(x.trend4h)} / ${esc(x.trend1h)} / ${esc(x.trend15m)} · EMA200 ${x.ema200Aligned?"✅":"—"} · ADX ${esc(x.adx4h??"-")} · Hacim ${esc(x.volumeRatio??"-")}x</div><div>Giriş ${esc(x.entry)} · SL ${esc(x.stop??"-")} · TP1 ${esc(x.tp1??"-")} · TP2 ${esc(x.tp2??"-")}</div><small>${ok?"V2.22 TETİKLENMİŞ PAPER GİR":watch?`${esc(status)}: kalıcı mum + hacim teyidi bekleniyor`:`Elendi: ${esc(reason)}`}</small>${x.belitError?`<small class="bad"> · 1G analiz: ${esc(x.belitError)}</small>`:""}</div>`;
  }).join("");
}

function watchHtml(data){
  const w=Array.isArray(data.watch)?data.watch:[];
  if(!w.length)return `<div class="muted">Bu turda 7.5/10+ HAZIRLANIYOR/ARMED setup yok.</div>`;
  return w.map(x=>`<div class="paperCard"><b>${esc(x.symbol)} · ${esc(publicStatusLabel(x.publicStatus))} · Setup ${esc(x.setupQuality)}/10 · Tetik ${esc(x.triggerReadiness??x.entryQuality??"-")}/10</b><div>Sınır ${esc(x.boundary??"-")} · ${esc(x.boundaryTests??0)} test (${esc(x.boundaryTestQuality??"-")}) · mesafe ${esc(x.distanceToBoundaryPct??"-")}% · ŞİMDİ GİRİŞ YOK</div></div>`).join("");
}

function page(data,paper,migration){
  const archived=Number(migration?.archivedTrades||0);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot V2.22</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:820px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.card,.paperWrap{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.paperWrap{background:#111419}.paperCard{padding:10px 0;border-bottom:1px solid #2a2f37}.paperCard:last-child{border-bottom:0}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.warn{color:#facc15}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.notifyBtn{margin:10px 6px 4px 0;padding:10px 14px;border:0;border-radius:10px;font-weight:700}</style><div class="head"><h2>BingX Paper Bot · Top100 V2.22 · Setup/Trigger Scoring</h2><div>Tarama: PAPER · klasik kapı <b>8/10+</b> + ayrı <b>Setup / Tetik / Execution</b> · BTC ${esc(data.btcDirection)}</div><div>Statü: HAZIRLANIYOR → ARMED → TETİKLENDİ → RETEST · uzamışsa KAÇTI/KOVALAMA</div><div>Boundary: 2 test zayıf · 3 test kabul · 4+ test premium · breakout hacmi execution skoruna daha ağır yansır</div><div>1G yatay sınır · sıkışma · SMA10/20/50/100/200 · ADR/ATR sanity-check · 4s+1s trend · 15dk yardımcı tetik</div><div>5x isolated · 20 USDT margin · AUTO PAPER max 5 açık · aynı yönde max 3 · tur başına en iyi 1-2 gerçek tetik</div><div>${paperSummaryHtml(paper)}</div><div class="muted">V2.18 arşivi ${archived} işlem. V2.22 mevcut paper kayıtlarını korur; yeni kayıtlara Setup/Tetik/Execution ve public status ekler.</div><button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button><button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button><div>Top100 likit evren · Dilim ${esc(data.shard)}/${esc(data.shardCount)} · Bu tur ${(data.all||[]).length} coin · TETİKLENDİ ${(data.signals||[]).length} · HAZIR/ARMED ${(data.watch||[]).length}</div><small>Son tarama ${esc(data.scannedAt)}</small></div><div class="paperWrap"><b>ERKEN BREAKOUT RADARI</b>${watchHtml(data)}</div><div class="paperWrap"><b>AÇIK AUTO PAPER POZİSYONLARI</b>${openPaperHtml(paper)}</div>${scanCards(data)}<script>async function testNotify(btn){const old=btn.textContent;btn.disabled=true;btn.textContent="Gönderiliyor...";try{const r=await fetch('/notify-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('Test bildirimi gönderildi');}catch(e){alert('Bildirim testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}async function testBingx(btn){if(!confirm('BingX API ve TEST emir yolunu kontrol edelim mi? Gerçek pozisyon açılmaz.'))return;const old=btn.textContent;btn.disabled=true;btn.textContent='Kontrol ediliyor...';try{const r=await fetch('/bingx-connection-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('BINGX TEST BAŞARILI — gerçek pozisyon açılmadı.');}catch(e){alert('BingX testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}</script>`;
}

export class PaperTracker extends BasePaperTracker {
  async ensureV219Migration(){
    const marker=await this.state.storage.get("v219_migrated");
    if(marker)return marker;
    const oldTrades=(await this.state.storage.get("trades"))||[];
    const archivedAt=new Date().toISOString();
    const archive={version:"V2.18",archivedAt,trades:oldTrades};
    await this.state.storage.put("archive_v218",archive);
    await this.state.storage.put("trades",[]);
    const m={version:"V2.22",archivedAt,archivedTrades:oldTrades.length};
    await this.state.storage.put("v219_migrated",m);
    await this.state.storage.put("v219_alerts",{});
    await this.state.storage.put("v220_watch_alerts",{});
    return m;
  }

  async addSignals(trades,signals,scannedAt){
    const now=Date.parse(scannedAt)||Date.now();
    const open=trades.filter(t=>t.status==="OPEN");
    let free=Math.max(0,V219.maxPaperOpen-open.length);
    if(!free)return [];
    const before=new Set(trades.map(t=>t.id));
    const dirCount={LONG:open.filter(t=>t.direction==="LONG").length,SHORT:open.filter(t=>t.direction==="SHORT").length};
    const selected=[];
    const sorted=(Array.isArray(signals)?signals:[]).filter(isV221Signal).sort((a,b)=>(Number(b.executionScore)||0)-(Number(a.executionScore)||0)||(Number(b.setupQuality)||0)-(Number(a.setupQuality)||0)||(Number(b.score)||0)-(Number(a.score)||0));
    for(const s of sorted){
      if(!free||selected.length>=2)break;
      if(dirCount[s.direction]>=V219.maxSameDirection)continue;
      if(trades.some(t=>t.symbol===s.symbol && now-Date.parse(t.createdAt)<V219.cooldownMs))continue;
      selected.push(s);dirCount[s.direction]++;free--;
    }
    const added=await super.addSignals(trades,selected,scannedAt);
    for(const t of trades){
      if(before.has(t.id))continue;
      const s=selected.find(x=>x.symbol===t.symbol&&x.direction===t.direction);
      if(!s)continue;
      t.scannerVersion="V2.22";
      t.setupQuality=Number(s.setupQuality||0);
      t.entryQuality=Number(s.entryQuality||0);
      t.triggerReadiness=Number(s.triggerReadiness||s.entryQuality||0);
      t.executionScore=s.executionScore==null?null:Number(s.executionScore);
      t.publicStatus=s.publicStatus||"WAIT";
      t.boundaryTestQuality=s.boundaryTestQuality||null;
      t.volatilitySanity=s.volatilitySanity||null;
      t.belitStage=s.belitStage||"NONE";
      t.boundary=s.boundary??null;
      t.boundaryTests=Number(s.boundaryTests||0);
      t.adr20Pct=s.adr20Pct??null;
      t.atr20DailyPct=s.atr20DailyPct??null;
      t.isCore5=Boolean(s.isCore5);
    }
    return added;
  }

  async fetch(request){
    const migration=await this.ensureV219Migration();
    const url=new URL(request.url);
    if(url.pathname==="/v219-migration")return Response.json({ok:true,...migration});
    if(url.pathname==="/v219-archive"){
      const archive=(await this.state.storage.get("archive_v218"))||null;
      return Response.json({ok:true,archive});
    }
    if(url.pathname==="/v219-claim-alerts"){
      const body=await request.json().catch(()=>({}));
      const now=Date.parse(body?.scannedAt)||Date.now();
      const history=(await this.state.storage.get("v219_alerts"))||{};
      const allowed=[];
      for(const s of (Array.isArray(body?.signals)?body.signals:[])){
        if(!isV221Signal(s))continue;
        const key=`${s.symbol}:${s.direction}:${s.publicStatus||s.belitStage||"CLASSIC"}`;
        if(now-Number(history[key]||0)<V219.alertCooldownMs)continue;
        history[key]=now;allowed.push(s);
      }
      for(const [k,t] of Object.entries(history))if(now-Number(t)>24*60*60*1000)delete history[k];
      await this.state.storage.put("v219_alerts",history);
      return Response.json({ok:true,signals:allowed});
    }
    if(url.pathname==="/v220-claim-watch"){
      const body=await request.json().catch(()=>({}));
      const now=Date.parse(body?.scannedAt)||Date.now();
      const history=(await this.state.storage.get("v220_watch_alerts"))||{};
      const allowed=[];
      for(const s of (Array.isArray(body?.watch)?body.watch:[])){
        if(!s?.belitWatchCandidate)continue;
        const key=`${s.symbol}:${s.direction}:${s.publicStatus||s.belitStage}:${s.boundary}`;
        if(now-Number(history[key]||0)<V219.watchCooldownMs)continue;
        history[key]=now;allowed.push(s);
      }
      for(const [k,t] of Object.entries(history))if(now-Number(t)>48*60*60*1000)delete history[k];
      await this.state.storage.put("v220_watch_alerts",history);
      return Response.json({ok:true,watch:allowed});
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/notify-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ · V2.22","Bildirim kanalı çalışıyor. V2.22; Telegram yalnız tetiklenmiş LONG/SHORT sinyallerini gönderir. HAZIRLANIYOR/ARMED erken uyarıları sadece web radarında kalır. Setup/Tetik/Execution ayrımı ve 3 test kabul / 4+ premium boundary filtresi aktiftir.");return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/json"){
      try{return Response.json(await scanThroughBase(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/paper-stats"){
      try{return Response.json(await paperSnapshot(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/v219-migration"||url.pathname==="/v219-archive")return trackerStub(env).fetch(`https://paper.local${url.pathname}`);

    if(url.pathname==="/"||url.pathname===""){
      try{
        const [data,paper,migRes]=await Promise.all([scanThroughBase(env),paperSnapshot(env),trackerStub(env).fetch("https://paper.local/v219-migration")]);
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
    // Telegram is intentionally signal-only in V2.22.
    // HAZIRLANIYOR / ARMED / other early-warning candidates remain visible on the web radar,
    // but they are not claimed or pushed to Telegram.
    const alerts=await claimAlerts(env,data.signals||[],data.scannedAt);
    console.log(JSON.stringify({cron:controller.cron,version:"V2.22",scannedAt:data.scannedAt,shard:data.shard,scanned:data.all?.length||0,qualified:data.signals?.length||0,watch:data.watch?.length||0,alerts:alerts.length,telegramWatchAlerts:0,paper:paper?.stats||null}));
    if(alerts.length){
      ctx.waitUntil((async()=>{
        for(const x of alerts){
          try{await sendPrimary(env,`BingX ${x.direction} · ${x.symbol} · Execution ${x.executionScore??x.entryQuality}/10`,signalMessage(x));}catch(e){console.error("ALERT_ERROR",String(e?.message||e));}
          if(alerts.length>1)await sleep(1200);
        }
      })());
    }
  }
};
