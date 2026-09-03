import baseWorker, { PaperTracker as BasePaperTracker } from "./worker_top100_v300_hybrid_base.js";
import { enrichHybridData, isV300Signal, stageLabel, publicStatusLabel } from "./hybrid_v300.js";

const BASE_URL = "https://bingx-paper-bot.yasinaltas39.workers.dev";
const V219 = {
  version: "V3.1",
  minScore: 5.5,
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
function paperEnv(env){ return {...env,EXECUTION_MODE:"TEST"}; }
function marginForQuality(q){
  q=Number(q);
  if(!Number.isFinite(q)||q<7.5)return null;
  if(q>=9)return 15;
  if(q>=8)return 10;
  return Math.max(5,Math.min(7,Math.round(5+((q-7.5)/0.5)*2)));
}
function marginForSignal(x){ return marginForQuality(x?.executionScore??x?.entryQuality??x?.score); }
function errInfo(stage,e){
  const message=String(e?.message||e||"bilinmeyen hata");
  const stack=String(e?.stack||"").split("\n").slice(0,4).join(" | ");
  console.error(`V3.1 ${stage}`,stack||message);
  return {stage,message,stack};
}
function emptyPaper(error=null){return {ok:false,stats:{open:0,closed:0,winRatePct:0,totalOpenUSDT:0},trades:[],error};}


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
    entryValid:Boolean(x?.entryStillValid!==false),
    fundingOk:num(x?.fundingRate)==null||Math.abs(Number(x.fundingRate))<0.003,
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
  if(!c.entryValid)out.push("Last/Mark giriş bölgesini doğrulamıyor");
  if(!c.fundingOk)out.push("funding aşırı");
  if(!c.baseQualified)out.push("risk/hedef şartı");
  return out;
}

function upgradeData(raw){
  const all=(Array.isArray(raw?.all)?raw.all:[]).map(x=>({
    ...x,
    v300BaseEligible:!x?.error && ["LONG","SHORT"].includes(x?.direction) && !isSyntheticSymbol(x?.symbol) && Boolean(x?.riskOk) && Boolean(x?.rangeOk),
    v219RejectReasons:rejectReasons(x),
  }));
  return {...raw,version:"BINGX_WIDE_V3_1",minScore:7.5,signals:[],all};
}

async function scanThroughBase(env,focusSymbols=[]){
  const u=new URL(`${BASE_URL}/json`);
  const focus=(Array.isArray(focusSymbols)?focusSymbols:[]).map(String).filter(Boolean).slice(0,10);
  if(focus.length)u.searchParams.set("focus",focus.join(","));
  const res=await baseWorker.fetch(new Request(u),paperEnv(env));
  if(!res.ok)throw new Error(`Tarama HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  const data=await enrichHybridData(upgradeData(await res.json()));
  data.fastFocusSymbols=focus;
  return data;
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

async function getFastWatch(env){
  try{
    const res=await trackerStub(env).fetch("https://paper.local/v223-fast-watch");
    if(!res.ok)return [];
    const j=await res.json();
    return Array.isArray(j?.watch)?j.watch.slice(0,5):[];
  }catch{return [];}
}

async function updateFastWatch(env,data){
  try{
    const candidates=(Array.isArray(data?.all)?data.all:[]).filter(x=>x?.hybridWatchCandidate);
    const res=await trackerStub(env).fetch("https://paper.local/v223-fast-watch",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({candidates,signals:data?.signals||[],scannedSymbols:data?.scannedSymbols||[],scannedAt:data?.scannedAt})
    });
    return res.ok?res.json():null;
  }catch{return null;}
}

async function getDiscoveryFocus(env){
  try{
    const res=await trackerStub(env).fetch("https://paper.local/v31-discovery-focus");
    if(!res.ok)return [];
    const j=await res.json();
    return Array.isArray(j?.discovery)?j.discovery.slice(0,5):[];
  }catch{return [];}
}

async function updateDiscoveryFocus(env,data){
  try{
    const candidates=(Array.isArray(data?.all)?data.all:[]).filter(x=>x?.discoveryCandidate);
    const res=await trackerStub(env).fetch("https://paper.local/v31-discovery-focus",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({candidates,scannedSymbols:data?.scannedSymbols||[],scannedAt:data?.scannedAt})
    });
    return res.ok?res.json():null;
  }catch{return null;}
}

function mergeFocus(watch,discovery){
  const out=[],seen=new Set();
  for(const x of [...(Array.isArray(watch)?watch:[]),...(Array.isArray(discovery)?discovery:[])]){
    const sym=String(x?.symbol||""); if(!sym||seen.has(sym))continue;
    seen.add(sym);out.push(x); if(out.length>=10)break;
  }
  return out;
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
    `${publicStatusLabel(x.publicStatus)} · HYBRID ${x.hybridExecutionScore??x.executionScore??"-"}/10`,
    `Emre ${x.emreScore??"-"}/10 · Aksel ${x.akselScore??"-"}/10 · Belit ${x.belitScore??"-"}/10`,
    `Pattern: ${x.patternType??"-"} · Fib: ${x.emreFibLabel??"-"} (${x.emreFibRetracement??"-"})`,
    `Last: ${x.lastPrice??x.entry} · Mark: ${x.markPrice??"-"} · Giriş: ${x.entry}`,
    `SL: ${x.stop??"-"} (${x.stopPct??"-"}%) · TP1: ${x.tp1??"-"} · TP2: ${x.tp2??"-"}`,
    `Yatay sınır: ${x.boundary??"-"} · test ${x.boundaryTests??0} · Flag sınır: ${x.flagBoundary??"-"} · ${x.flagDistanceATR??"-"} ATR`,
    `1G SMA ${x.smaDaily??"-"} · ADR20 %${x.adr20Pct??"-"} · 4s/1s/15dk ${x.trend4h}/${x.trend1h}/${x.trend15m}`,
    `RSI4s ${x.rsi4h??"-"} · ADX4s ${x.adx4h??"-"} · Hacim ${x.volumeRatio??"-"}x · Funding ${x.fundingRate??"-"}`,
    `Teorik margin: ${marginForSignal(x)??"-"} USDT · 5x isolated · PAPER/TEST ONLY`,
    `Konsensüs: Emre yön/HTF + Aksel yapı/kırılım + Belit execution aynı yönde doğrulandı.`
  ].join("\n");
}

function watchMessage(x){
  return [
    `${x.symbol} ${x.direction} · ${x.isCore5?"CORE5":"GENİŞ TARAMA"}`,
    `${publicStatusLabel(x.publicStatus)} · HYBRID Setup ${x.hybridSetupScore??x.setupQuality??"-"}/10 · ŞİMDİ GİRİŞ YOK`,
    `Emre ${x.emreScore??"-"}/10 · Aksel ${x.akselScore??"-"}/10 · Belit ${x.belitScore??"-"}/10`,
    `Pattern: ${x.patternType??"-"} · Fib ${x.emreFibLabel??"-"}`,
    `Yatay sınır ${x.boundary??"-"} · Flag sınır ${x.flagBoundary??"-"} · Flag mesafe ${x.flagDistanceATR??"-"} ATR`,
    `Tetik gelmeden PAPER GİR yok; uzarsa KOVALAMA, retest bekle.`
  ].join("\n");
}

function paperSummaryHtml(paper){
  const s=paper?.stats||{};
  const trades=Array.isArray(paper?.trades)?paper.trades:[];
  const fresh=trades.filter(t=>t.scannerVersion==="V3.1");
  const freshOpen=fresh.filter(t=>t.status==="OPEN");
  const freshClosed=fresh.filter(t=>t.status!=="OPEN");
  const freshWins=freshClosed.filter(t=>Number(t.realizedR)>0.0001).length;
  const freshWr=freshClosed.length?100*freshWins/freshClosed.length:0;
  const totalOpen=Number(s.open||0),totalClosed=Number(s.closed||0);
  return `V3.1 YENİ: <b>${freshOpen.length} açık</b> · ${freshClosed.length} kapanan · Win %${freshWr.toFixed(1)} · <span class="muted">Geçmiş kayıt: ${totalOpen} açık / ${totalClosed} kapanan</span>`;
}

function openPaperHtml(paper){
  const trades=Array.isArray(paper?.trades)?paper.trades.filter(t=>t.status==="OPEN"):[];
  if(!trades.length)return `<div class="muted">Açık paper işlem yok.</div>`;
  return trades.map(t=>{
    const usd=num(t.pnlUSDT), cls=usd>0?"good":usd<0?"bad":"muted";
    const meta=t.scannerVersion==="V3.1"?` · Emre ${esc(t.emreScore??"-")}/10 · Aksel ${esc(t.akselScore??"-")}/10 · Belit ${esc(t.belitScore??"-")}/10 · Hybrid ${esc(t.executionScore??t.entryQuality??"-")}/10 · ${esc(publicStatusLabel(t.publicStatus||"WAIT"))}`:"";
    return `<div class="paperCard"><div class="row"><b>${esc(t.symbol)} · ${esc(t.direction)} · ${esc(t.score)}/10${meta}</b><span class="${cls}">${usd==null?"fiyat bekleniyor":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`}</span></div><div>Giriş: ${esc(t.entry)} · Güncel: ${esc(t.currentPrice??"-")}</div><div>Margin: ${esc(t.paperMarginUSDT??"-")} USDT · ${esc(t.scoreBand??"-")} · ${esc(t.leverage??5)}x</div><div>SL: ${esc(t.stop)} · TP1: ${esc(t.tp1)} ${t.tp1Hit?"✅":""} · TP2: ${esc(t.tp2)} ${t.tp2Hit?"✅":""}</div></div>`;
  }).join("");
}

function scanCards(data){
  return (data.all||[]).map(x=>{
    if(x.error)return `<div class="card"><b>${esc(x.symbol)}</b><div class="bad">${esc(x.error)}</div></div>`;
    const ok=Boolean(x.v300Qualifies),watch=Boolean(x.hybridWatchCandidate),discovery=Boolean(x.discoveryCandidate);
    const status=ok?publicStatusLabel(x.publicStatus||"WAIT"):watch?publicStatusLabel(x.publicStatus||"WAIT"):discovery?"DISCOVERY":publicStatusLabel(x.publicStatus||"WAIT");
    const cls=ok?"good":watch||discovery?"warn":x.publicStatus==="MISSED"?"bad":"muted";
    const exec=x.hybridExecutionScore==null?"—":`${esc(x.hybridExecutionScore)}/10`;
    return `<div class="card"><div class="row"><b>${esc(x.symbol)} ${x.isCore5?"· CORE5":"· GENİŞ"}</b><span class="${cls}">${esc(status)}</span></div><div><b>Hybrid Setup ${esc(x.hybridSetupScore??x.setupQuality??"-")}/10 · Execution ${exec}</b></div><div>Emre <b>${esc(x.emreScore??"-")}</b> · Aksel <b>${esc(x.akselScore??"-")}</b> · Belit <b>${esc(x.belitScore??"-")}</b> · Klasik ${esc(x.score??"-")}</div><div>Pattern <b>${esc(x.patternType??"-")}</b> · Fib ${esc(x.emreFibLabel??"-")} · retrace ${esc(x.emreFibRetracement??"-")}</div><div>Yatay sınır ${esc(x.boundary??"-")} · test ${esc(x.boundaryTests??0)} (${esc(x.boundaryTestQuality??"-")}) · Flag sınır ${esc(x.flagBoundary??"-")} · ${esc(x.flagDistanceATR??"-")} ATR</div><div>1G SMA ${esc(x.smaDaily??"-")} · ADR20 %${esc(x.adr20Pct??"-")} · 4s/1s/15dk ${esc(x.trend4h)}/${esc(x.trend1h)}/${esc(x.trend15m)} · RSI4s ${esc(x.rsi4h??"-")} · Hacim ${esc(x.volumeRatio??"-")}x</div><div>Last ${esc(x.lastPrice??"-")} · Mark ${esc(x.markPrice??"-")} · Giriş ${esc(x.entry)} · SL ${esc(x.stop??"-")} · TP1 ${esc(x.tp1??"-")} · TP2 ${esc(x.tp2??"-")}</div><small>${ok?"V3.1 ÜÇLÜ KONSENSÜS PAPER GİR":watch?"Konsensüs hazırlığı var; tetik bekleniyor":discovery?`PRE-BREAKOUT DISCOVERY ${esc(x.discoveryDirection??"")} · skor ${esc(x.discoveryScore??"-")}/10 · sınır ${esc(x.discoveryBoundary??"-")}`:"Üçlü konsensüs / tetik şartları tamamlanmadı"}</small></div>`;
  }).join("");
}

function watchHtml(data){
  const w=Array.isArray(data.watch)?data.watch:[];
  if(!w.length)return `<div class="muted">Bu turda üçlü konsensüsle 7.5/10+ HAZIRLANIYOR/ARMED aday yok.</div>`;
  return w.map(x=>`<div class="paperCard"><b>${esc(x.symbol)} · ${esc(publicStatusLabel(x.publicStatus))} · Hybrid ${esc(x.hybridSetupScore??x.setupQuality)}/10</b><div>Emre ${esc(x.emreScore??"-")} · Aksel ${esc(x.akselScore??"-")} · Belit ${esc(x.belitScore??"-")} · ${esc(x.patternType??"-")}</div><div>Yatay ${esc(x.boundary??"-")} · Flag ${esc(x.flagBoundary??"-")} · ŞİMDİ GİRİŞ YOK</div></div>`).join("");
}

function discoveryHtml(data){
  const d=Array.isArray(data.discovery)?data.discovery:[];
  if(!d.length)return `<div class="muted">Bu turda 6.5/10+ PRE-BREAKOUT DISCOVERY adayı yok.</div>`;
  return d.map(x=>`<div class="paperCard"><b>${esc(x.symbol)} · ${esc(x.discoveryDirection??"-")} · Discovery ${esc(x.discoveryScore??"-")}/10</b><div>Sınır ${esc(x.discoveryBoundary??"-")} · ${esc(x.discoveryBoundaryTests??0)} test · mesafe %${esc(x.discoveryDistancePct??"-")}</div><div>Base ${esc(x.discoveryBaseSpanDays??"-")}g · staircase ${x.discoveryStaircase?"EVET":"—"} · sıkışma ${x.discoveryCompression?"EVET":"—"} · squeeze ${x.discoverySqueeze?"EVET":"—"} · SMA ${esc(x.discoverySma??"-")}</div><small>DISCOVERY = işlem değil. Hacim tetik şartı aranmaz; aday hızlı takibe alınır. HAZIR/ARMED ve PAPER GİR ayrı teyit ister.</small></div>`).join("");
}

function page(data,paper,migration){
  const archived=Number(migration?.archivedTrades||0);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot V3.1 Wide Discovery</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:860px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.card,.paperWrap{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.paperWrap{background:#111419}.paperCard{padding:10px 0;border-bottom:1px solid #2a2f37}.paperCard:last-child{border-bottom:0}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.warn{color:#facc15}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.notifyBtn{margin:10px 6px 4px 0;padding:10px 14px;border:0;border-radius:10px;font-weight:700}</style><div class="head"><h2>BingX Paper Bot · V3.1 · Wide Discovery + Emre + Aksel + Belit</h2><div><b>PAPER/TEST ONLY</b> · EXECUTION_MODE zorla TEST · BTC ${esc(data.btcDirection)}</div><div><b>Emre katmanı:</b> 4s+1s HTF yön · 1G SMA rejimi · 4s RSI · objektif impuls/Fibonacci retracement · invalidation</div><div><b>Aksel katmanı:</b> yatay boundary/test + 4s flag/channel · kapanışla kırılım/retest · pattern invalidation · giriş güncelliği</div><div><b>Belit katmanı:</b> SMA10/20/50/100/200 · sıkışma · hacim/baskı · ADR/ATR · 15dk tetik · KAÇTI/KOVALAMA</div><div><b>PAPER GİR:</b> üçlü konsensüs + Hybrid Execution ≥7.5 · Emre ≥6 · Aksel ≥6.5 · Belit ≥6.25 · Last/Mark geçerli · risk/hedef geçerli</div><div>5x isolated · margin 7.5–7.9 = 5–7 USDT · 8.0–8.5 = 10 · 9+ = 15 · max 5 açık · aynı yön max 3 · en iyi 1–2 tetik</div><div>İlk 10 likit + CORE5 her dakika · en iyi 5 HAZIR/ARMED + en iyi 5 DISCOVERY hızlı takip · Top100 hard cutoff YOK · yeterli likiditeli BingX perpetual geniş evren dönüşümlü tarama · Telegram yalnız PAPER GİR</div><div>${paperSummaryHtml(paper)}</div><div class="muted">Geçmiş V2.x/V3.0 paper kayıtları korunur; V3.1 ayrı yeni örneklem olarak sayılır. DISCOVERY trade değildir; yalnız base + higher-low/lower-high + boundary + SMA dönüşü/sıkışma adaylarını erken bulur. Elliott dalga sayımı otomatik kullanılmaz.</div><button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button><button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button><div>Geniş likit evren ${esc(data.universeCount??"-")} coin · Dilim ${esc(data.shard)}/${esc(data.shardCount)} (~${esc(data.estimatedFullCycleMin??data.shardCount)} dk tam tur) · Bu tur ${(data.all||[]).length} coin · DISCOVERY ${(data.discovery||[]).length} · HAZIR/ARMED ${(data.watch||[]).length} · PAPER GİR ${(data.signals||[]).length}</div><small>Son tarama ${esc(data.scannedAt)}</small></div><div class="paperWrap"><b>PRE-BREAKOUT DISCOVERY RADARI</b>${discoveryHtml(data)}</div><div class="paperWrap"><b>ÜÇLÜ KONSENSÜS RADARI</b>${watchHtml(data)}</div><div class="paperWrap"><b>AÇIK AUTO PAPER POZİSYONLARI</b>${openPaperHtml(paper)}</div>${scanCards(data)}<script>async function testNotify(btn){const old=btn.textContent;btn.disabled=true;btn.textContent="Gönderiliyor...";try{const r=await fetch('/notify-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('Test bildirimi gönderildi');}catch(e){alert('Bildirim testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}async function testBingx(btn){if(!confirm('BingX API ve TEST emir yolunu kontrol edelim mi? Gerçek pozisyon açılmaz.'))return;const old=btn.textContent;btn.disabled=true;btn.textContent='Kontrol ediliyor...';try{const r=await fetch('/bingx-connection-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('BINGX TEST BAŞARILI — gerçek pozisyon açılmadı.');}catch(e){alert('BingX testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}</script>`;
}

export class PaperTracker extends BasePaperTracker {
  async ensureV219Migration(){
    const marker=await this.state.storage.get("v219_migrated");
    if(marker)return marker;
    const oldTrades=(await this.state.storage.get("trades"))||[];
    const archivedAt=new Date().toISOString();
    const archive={version:"V2.x",archivedAt,trades:oldTrades};
    await this.state.storage.put("archive_v218",archive);
    await this.state.storage.put("trades",[]);
    const m={version:"V3.1",archivedAt,archivedTrades:oldTrades.length};
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
    const sorted=(Array.isArray(signals)?signals:[]).filter(isV300Signal).sort((a,b)=>(Number(b.executionScore)||0)-(Number(a.executionScore)||0)||(Number(b.setupQuality)||0)-(Number(a.setupQuality)||0)||(Number(b.score)||0)-(Number(a.score)||0));
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
      t.scannerVersion="V3.1";
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
      t.emreScore=Number(s.emreScore||0);
      t.akselScore=Number(s.akselScore||0);
      t.belitScore=Number(s.belitScore||0);
      t.hybridSetupScore=Number(s.hybridSetupScore||0);
      t.hybridExecutionScore=s.hybridExecutionScore==null?null:Number(s.hybridExecutionScore);
      t.patternType=s.patternType||null;
      t.emreFibLabel=s.emreFibLabel||null;
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
        if(!isV300Signal(s))continue;
        const key=`${s.symbol}:${s.direction}:${s.publicStatus||s.belitStage||"CLASSIC"}`;
        if(now-Number(history[key]||0)<V219.alertCooldownMs)continue;
        history[key]=now;allowed.push(s);
      }
      for(const [k,t] of Object.entries(history))if(now-Number(t)>24*60*60*1000)delete history[k];
      await this.state.storage.put("v219_alerts",history);
      return Response.json({ok:true,signals:allowed});
    }
    if(url.pathname==="/v223-fast-watch"){
      const now=Date.now(),ttl=4*60*60*1000;
      let state=(await this.state.storage.get("v223_fast_watch"))||{};
      for(const [sym,v] of Object.entries(state))if(now-Number(v?.updatedAt||0)>ttl)delete state[sym];
      if(request.method==="POST"){
        const body=await request.json().catch(()=>({}));
        const scanned=new Set((Array.isArray(body?.scannedSymbols)?body.scannedSymbols:[]).map(String));
        const candidates=Array.isArray(body?.candidates)?body.candidates:[];
        const candidateMap=new Map(candidates.filter(x=>x?.symbol&&x?.hybridWatchCandidate).map(x=>[String(x.symbol),x]));
        for(const sym of scanned)if(!candidateMap.has(sym))delete state[sym];
        for(const x of candidateMap.values()){
          state[String(x.symbol)]={symbol:String(x.symbol),direction:x.direction,boundary:x.boundary,setupQuality:Number(x.setupQuality||0),triggerReadiness:Number(x.triggerReadiness||0),publicStatus:x.publicStatus||"PREPARING",updatedAt:Date.parse(body?.scannedAt)||now};
        }
      }
      const watch=Object.values(state)
        .sort((a,b)=>(b.publicStatus==="ARMED")-(a.publicStatus==="ARMED")||(Number(b.setupQuality)||0)-(Number(a.setupQuality)||0)||(Number(b.triggerReadiness)||0)-(Number(a.triggerReadiness)||0))
        .slice(0,5);
      const keep=new Set(watch.map(x=>x.symbol));
      state=Object.fromEntries(Object.entries(state).filter(([k])=>keep.has(k)));
      await this.state.storage.put("v223_fast_watch",state);
      return Response.json({ok:true,watch});
    }
    if(url.pathname==="/v31-discovery-focus"){
      const now=Date.now(),ttl=8*60*60*1000;
      let state=(await this.state.storage.get("v31_discovery_focus"))||{};
      for(const [sym,v] of Object.entries(state))if(now-Number(v?.updatedAt||0)>ttl)delete state[sym];
      if(request.method==="POST"){
        const body=await request.json().catch(()=>({}));
        const scanned=new Set((Array.isArray(body?.scannedSymbols)?body.scannedSymbols:[]).map(String));
        const candidates=Array.isArray(body?.candidates)?body.candidates:[];
        const candidateMap=new Map(candidates.filter(x=>x?.symbol&&x?.discoveryCandidate).map(x=>[String(x.symbol),x]));
        for(const sym of scanned)if(!candidateMap.has(sym))delete state[sym];
        for(const x of candidateMap.values())state[String(x.symbol)]={symbol:String(x.symbol),direction:x.discoveryDirection,discoveryScore:Number(x.discoveryScore||0),boundary:x.discoveryBoundary,distancePct:x.discoveryDistancePct,updatedAt:Date.parse(body?.scannedAt)||now};
      }
      const discovery=Object.values(state).sort((a,b)=>(Number(b.discoveryScore)||0)-(Number(a.discoveryScore)||0)||Math.abs(Number(a.distancePct)||99)-Math.abs(Number(b.distancePct)||99)).slice(0,5);
      const keep=new Set(discovery.map(x=>x.symbol));
      state=Object.fromEntries(Object.entries(state).filter(([k])=>keep.has(k)));
      await this.state.storage.put("v31_discovery_focus",state);
      return Response.json({ok:true,discovery});
    }
    if(url.pathname==="/v220-claim-watch"){
      const body=await request.json().catch(()=>({}));
      const now=Date.parse(body?.scannedAt)||Date.now();
      const history=(await this.state.storage.get("v220_watch_alerts"))||{};
      const allowed=[];
      for(const s of (Array.isArray(body?.watch)?body.watch:[])){
        if(!s?.hybridWatchCandidate)continue;
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
      try{const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ · V3.1","Bildirim kanalı çalışıyor. V3.1 Wide Discovery + Emre+Aksel+Belit üçlü konsensüs aktiftir. Telegram yalnız PAPER GİR LONG/SHORT sinyallerini gönderir. Worker EXECUTION_MODE zorla TEST kilitlidir; gerçek emir açılamaz.");return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/json"){
      try{
        const [watchFocus,discoveryFocus]=await Promise.all([getFastWatch(env),getDiscoveryFocus(env)]);
        const focus=mergeFocus(watchFocus,discoveryFocus);
        const data=await scanThroughBase(env,focus.map(x=>x?.symbol).filter(Boolean));
        return Response.json(data,{headers:{"cache-control":"no-store"}});
      }catch(e){const info=errInfo("JSON_SCAN",e);return Response.json({ok:false,error:info.message,stage:info.stage,stack:info.stack},{status:500,headers:{"cache-control":"no-store"}});}
    }
    if(url.pathname==="/paper-stats"){
      try{return Response.json(await paperSnapshot(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/v219-migration"||url.pathname==="/v219-archive")return trackerStub(env).fetch(`https://paper.local${url.pathname}`);

    if(url.pathname==="/"||url.pathname===""){
      let focus=[],data=null,paper=null,migration={},scanError=null,paperError=null;
      try{const [watchFocus,discoveryFocus]=await Promise.all([getFastWatch(env),getDiscoveryFocus(env)]);focus=mergeFocus(watchFocus,discoveryFocus);}catch(e){errInfo("FAST_FOCUS",e);focus=[];}
      try{data=await scanThroughBase(env,(Array.isArray(focus)?focus:[]).map(x=>x?.symbol).filter(Boolean));}
      catch(e){scanError=errInfo("SCAN",e);}
      try{paper=await paperSnapshot(env);}catch(e){paperError=errInfo("PAPER_STATS",e);paper=emptyPaper(String(e?.message||e));}
      try{const migRes=await trackerStub(env).fetch("https://paper.local/v219-migration");migration=migRes.ok?await migRes.json():{};}catch(e){errInfo("MIGRATION",e);migration={};}
      if(!data){
        const detail=scanError?.stack?`<div style="margin-top:12px;color:#666;font-size:13px">Aşama: ${esc(scanError.stage)} · ${esc(scanError.stack)}</div>`:"";
        return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px"><h2>BingX Paper Bot · V3.1</h2><p><b>Tarama geçici olarak durdu.</b> PAPER/TEST kilidi aktif; gerçek emir açılamaz.</p><p>Hata aşaması: <b>${esc(scanError?.stage||"SCAN")}</b><br>${esc(scanError?.message||"bilinmeyen hata")}</p>${detail}<p>Paper istatistik katmanı: ${paperError?"hata":"çalışıyor"}</p></body>`,{status:500,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      }
      return new Response(page(data,paper||emptyPaper(),migration),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }

    // Trade, signal landing, BingX connection test and other established routes stay on V2.17's proven execution bridge.
    return baseWorker.fetch(request,paperEnv(env));
  },

  async scheduled(controller,env,ctx){
    const [watchFocus,discoveryFocus]=await Promise.all([getFastWatch(env).catch(()=>[]),getDiscoveryFocus(env).catch(()=>[])]);
    const focus=mergeFocus(watchFocus,discoveryFocus);
    let data;
    try{data=await scanThroughBase(env,focus.map(x=>x?.symbol).filter(Boolean));}
    catch(e){errInfo("CRON_SCAN",e);return;}
    const paper=await paperTick(env,data).catch(e=>{errInfo("CRON_PAPER",e);return {stats:null};});
    const [fastWatch,fastDiscovery]=await Promise.all([updateFastWatch(env,data),updateDiscoveryFocus(env,data)]);
    // Telegram is intentionally signal-only in V3.0.
    // HAZIRLANIYOR / ARMED / other early-warning candidates remain visible on the web radar,
    // but they are not claimed or pushed to Telegram.
    const alerts=await claimAlerts(env,data.signals||[],data.scannedAt);
    console.log(JSON.stringify({cron:controller.cron,version:"V3.1",scannedAt:data.scannedAt,shard:data.shard,scanned:data.all?.length||0,qualified:data.signals?.length||0,watch:data.watch?.length||0,discovery:data.discovery?.length||0,fastWatch:(fastWatch?.watch||watchFocus).map(x=>x.symbol),fastDiscovery:(fastDiscovery?.discovery||discoveryFocus).map(x=>x.symbol),alerts:alerts.length,telegramWatchAlerts:0,paper:paper?.stats||null}));
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
