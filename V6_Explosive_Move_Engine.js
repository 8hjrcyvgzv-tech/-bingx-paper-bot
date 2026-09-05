// BingX Paper Bot V6.0 — Explosive Move Engine
// Derived from the proven V3.2 single-worker PAPER core. EXECUTION_MODE stays hard-locked to TEST.

const __belit = (() => {
const V221_BELIT = {
  minWatchSetupQuality: 7.5,
  minArmedSetupQuality: 8,
  minExecutionQuality: 7.5,
  armedDistancePct: 1.5,
  maxSignalsPerScan: 2,
  maxWatchPerScan: 5,
  maxDiscoveryPerScan: 5,
  minDiscoveryScore: 6.5,
  maxDiscoveryDistancePct: 8,
  dailyLookback: 220,
};

const CORE5 = new Set(["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","DOGE-USDT"]);

function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function arr(v){ return Array.isArray(v)?v:[]; }
function avg(a){ a=arr(a); return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function round2(v){ return Number.isFinite(v)?Math.round(v*100)/100:null; }
function isSyntheticSymbol(symbol){
  const s=String(symbol||"").toUpperCase();
  return /(?:NCCO|BRENT|WTI|OIL|XAU|XAG|GOLD|SILVER|NASDAQ|SP500|DOW|DJI|FOREX)/.test(s);
}

function normalizeKlines(payload){
  const raw=Array.isArray(payload)?payload:(payload?.data??[]);
  return raw.map(r=>Array.isArray(r)
    ? {time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5],closeTime:+(r[6]??0)}
    : {time:+(r.time??r.openTime??r.ts??0),open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+(r.volume??r.vol??0),closeTime:+(r.closeTime??0)}
  ).filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.time-b.time);
}

async function getDailyKlines(symbol,limit=V221_BELIT.dailyLookback){
  const u=new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines");
  u.searchParams.set("symbol",symbol);
  u.searchParams.set("interval","1d");
  u.searchParams.set("limit",String(limit));
  const res=await fetch(u,{headers:{accept:"application/json"}});
  if(!res.ok)throw new Error(`${symbol} 1d HTTP ${res.status}`);
  const json=await res.json();
  if(json?.code!=null&&Number(json.code)!==0)throw new Error(`${symbol} 1d: ${json.msg||json.code}`);
  const rows=normalizeKlines(json);
  if(rows.length<45)throw new Error(`${symbol} 1d yetersiz mum (${rows.length})`);
  return rows;
}

function sma(values,p){ values=arr(values); return values.length<p?null:avg(values.slice(-p)); }
function tr(rows,i){
  if(i<=0)return rows[i].high-rows[i].low;
  const prev=rows[i-1].close;
  return Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-prev),Math.abs(rows[i].low-prev));
}
function atr(rows,p=20){
  rows=arr(rows);
  if(rows.length<=p)return null;
  const vals=[]; for(let i=rows.length-p;i<rows.length;i++)vals.push(tr(rows,i));
  return avg(vals);
}
function adrPct(rows,p=20){
  rows=arr(rows);
  if(rows.length<p)return null;
  const vals=rows.slice(-p).map(r=>r.low>0?((r.high-r.low)/r.low)*100:null).filter(Number.isFinite);
  return vals.length?avg(vals):null;
}

function swings(rows,kind,wing=2){
  const out=[];
  for(let i=wing;i<rows.length-wing;i++){
    const p=kind==="HIGH"?rows[i].high:rows[i].low;
    let ok=true;
    for(let j=i-wing;j<=i+wing;j++){
      if(j===i)continue;
      const q=kind==="HIGH"?rows[j].high:rows[j].low;
      if(kind==="HIGH"?q>p:q<p){ok=false;break;}
    }
    if(ok)out.push({index:i,price:p,time:rows[i].time});
  }
  return out;
}

function clusters(points,tol){
  const out=[];
  for(const p of points){
    let best=null,dist=Infinity;
    for(const c of out){
      const d=Math.abs(p.price-c.level);
      if(d<=tol&&d<dist){best=c;dist=d;}
    }
    if(!best)out.push({level:p.price,tests:1,lastIndex:p.index,points:[p]});
    else{
      best.points.push(p); best.tests++; best.level=avg(best.points.map(x=>x.price)); best.lastIndex=Math.max(best.lastIndex,p.index);
    }
  }
  return out;
}

function pickBoundary(list,current,a,side){
  const maxGap=Math.max(a*4,current*0.12);
  const candidates=list.filter(c=>{
    if(c.tests<2)return false;
    return side==="RESISTANCE"
      ? c.level>=current-a*0.9&&c.level<=current+maxGap
      : c.level<=current+a*0.9&&c.level>=current-maxGap;
  });
  if(!candidates.length)return null;
  candidates.sort((x,y)=>{
    const den=Math.max(a,current*0.002);
    const sx=x.tests*2-Math.abs(x.level-current)/den+x.lastIndex*0.002;
    const sy=y.tests*2-Math.abs(y.level-current)/den+y.lastIndex*0.002;
    return sy-sx;
  });
  return candidates[0];
}

function pickBrokenBoundary(list,current,a,side){
  const candidates=list.filter(c=>{
    if(c.tests<2)return false;
    if(side==="RESISTANCE")return c.level<current-a*0.9&&c.level>=current*0.65;
    return c.level>current+a*0.9&&c.level<=current*1.35;
  });
  if(!candidates.length)return null;
  candidates.sort((x,y)=>{
    const dx=Math.abs(x.level-current),dy=Math.abs(y.level-current);
    if(Math.abs(dx-dy)>a*0.25)return dx-dy;
    return y.tests-x.tests;
  });
  return candidates[0];
}

function compression(rows){
  if(rows.length<25)return {ratio:null,tightPct:null,ok:false};
  const recent=rows.slice(-5),prior=rows.slice(-20,-5),recentStart=rows.length-5,priorStart=rows.length-20;
  const r=avg(recent.map((_,j)=>tr(rows,recentStart+j)));
  const p=avg(prior.map((_,j)=>tr(rows,priorStart+j)));
  const hi=Math.max(...recent.map(x=>x.high)),lo=Math.min(...recent.map(x=>x.low)),last=recent.at(-1).close;
  const ratio=p>0?r/p:null;
  return {ratio,tightPct:last>0?((hi-lo)/last)*100:null,ok:ratio!=null&&ratio<=0.85};
}

function directionalSqueeze(rows,direction){
  const r=rows.slice(-15); if(r.length<12)return false;
  const c=[r.slice(0,5),r.slice(5,10),r.slice(10,15)];
  if(direction==="LONG"){
    const lows=c.map(a=>Math.min(...a.map(x=>x.low)));
    return lows[1]>=lows[0]*0.995&&lows[2]>=lows[1]*0.995&&lows[2]>lows[0];
  }
  const highs=c.map(a=>Math.max(...a.map(x=>x.high)));
  return highs[1]<=highs[0]*1.005&&highs[2]<=highs[1]*1.005&&highs[2]<highs[0];
}

function risingSwingLows(rows){
  const pts=swings(rows,"LOW",2).slice(-4);
  if(pts.length<3)return false;
  const p=pts.slice(-3).map(x=>x.price);
  return p[1]>=p[0]*0.985&&p[2]>=p[1]*0.985&&p[2]>p[0]*1.01;
}
function fallingSwingHighs(rows){
  const pts=swings(rows,"HIGH",2).slice(-4);
  if(pts.length<3)return false;
  const p=pts.slice(-3).map(x=>x.price);
  return p[1]<=p[0]*1.015&&p[2]<=p[1]*1.015&&p[2]<p[0]*0.99;
}
function boundarySpanDays(boundary){
  const pts=arr(boundary?.points);
  if(pts.length<2)return 0;
  const times=pts.map(x=>Number(x.time||0)).filter(x=>x>0);
  if(times.length<2)return Math.max(0,Number(boundary?.lastIndex||0)-Number(pts[0]?.index||0));
  return Math.max(0,(Math.max(...times)-Math.min(...times))/(24*60*60*1000));
}
function discoverySide(rows,x,direction,a,current,highClusters,lowClusters,comp){
  const boundary=direction==="LONG"?pickBoundary(highClusters,current,a,"RESISTANCE"):pickBoundary(lowClusters,current,a,"SUPPORT");
  if(!boundary||boundary.tests<2)return null;
  const market=num(x?.lastPrice)||current;
  const distPct=direction==="LONG"?(boundary.level-market)/market*100:(market-boundary.level)/market*100;
  if(distPct<0||distPct>V221_BELIT.maxDiscoveryDistancePct)return null;
  const smas=smaState(rows,direction);
  const squeeze=directionalSqueeze(rows,direction);
  const structure=rows.slice(-100);
  const staircase=direction==="LONG"?risingSwingLows(structure):fallingSwingHighs(structure);
  const spanDays=boundarySpanDays(boundary);
  const trend4=String(x?.trend4h||"NEUTRAL"),trend1=String(x?.trend1h||"NEUTRAL");
  const opposite=direction==="LONG"?"SHORT":"LONG";
  const stronglyOpposite=trend4===opposite&&trend1===opposite;
  if(stronglyOpposite)return null;
  let score=0;
  score+=boundary.tests>=4?2:boundary.tests===3?1.5:1;
  score+=distPct<=1.5?2:distPct<=3?1.5:distPct<=5?1.25:0.75;
  if(comp.ok)score+=1.25;
  if(squeeze)score+=1.25;
  if(staircase)score+=1.25;
  score+=Math.min(1.25,smas.score*0.5);
  if(spanDays>=20)score+=0.75; else if(spanDays>=10)score+=0.5;
  if(trend4===direction||trend1===direction)score+=0.5;
  // V3.2: hacim liderliği discovery'nin ana kapısı değildir ama hareket başlamadan önceki akış artık anlamlı bonus alır.
  if(num(x?.v32RadarScore)>=7)score+=0.75; else if(num(x?.v32RadarScore)>=6.25)score+=0.5; else if(num(x?.volumeRatio)>=1.2)score+=0.25;
  score=clamp(Math.round(score*4)/4,0,10);
  return {direction,score,boundary:boundary.level,boundaryTests:boundary.tests,distPct,compression:Boolean(comp.ok),squeeze,staircase,sma:smas.label,smaScore:smas.score,spanDays:round2(spanDays)};
}
function analyzeDiscovery(rows,x){
  rows=arr(rows);
  const currentRow=rows.at(-1),completed=rows.length>3?rows.slice(0,-1):rows.slice();
  if(!currentRow||completed.length<45)return {candidate:false,score:0};
  const a=atr(completed,20); if(!(a>0))return {candidate:false,score:0};
  const structure=completed.slice(-100),tol=Math.max(a*0.55,currentRow.close*0.012);
  const highClusters=clusters(swings(structure,"HIGH"),tol),lowClusters=clusters(swings(structure,"LOW"),tol);
  const comp=compression(completed);
  const long=discoverySide(completed.concat([currentRow]),x,"LONG",a,currentRow.close,highClusters,lowClusters,comp);
  const short=discoverySide(completed.concat([currentRow]),x,"SHORT",a,currentRow.close,highClusters,lowClusters,comp);
  const best=[long,short].filter(Boolean).sort((a,b)=>b.score-a.score)[0];
  if(!best)return {candidate:false,score:0};
  const funding=num(x?.fundingRate);
  const fundingOk=funding==null||Math.abs(funding)<0.003;
  const candidate=best.score>=V221_BELIT.minDiscoveryScore&&fundingOk&&!isSyntheticSymbol(x?.symbol);
  return {candidate,score:best.score,direction:best.direction,boundary:round2(best.boundary),boundaryTests:best.boundaryTests,distancePct:round2(best.distPct),compression:best.compression,squeeze:best.squeeze,staircase:best.staircase,sma:best.sma,baseSpanDays:best.spanDays,fundingOk};
}

function smaState(rows,direction){
  const c=rows.map(x=>x.close),last=c.at(-1);
  const s10=sma(c,10),s20=sma(c,20),s50=sma(c,50),s100=sma(c,100),s200=sma(c,200);
  let score=0,label="KARMA";
  if(direction==="LONG"){
    if(s20&&s50&&last>s20&&s20>s50)score+=1;
    if(s10&&s20&&s10>s20)score+=0.5;
    if(s50&&s100&&s50>s100)score+=0.5;
    if(s100&&s200&&s100>s200)score+=0.5;
    label=score>=2?"POZİTİF":score>=1?"İYİLEŞİYOR":"KARMA";
  }else{
    if(s20&&s50&&last<s20&&s20<s50)score+=1;
    if(s10&&s20&&s10<s20)score+=0.5;
    if(s50&&s100&&s50<s100)score+=0.5;
    if(s100&&s200&&s100<s200)score+=0.5;
    label=score>=2?"NEGATİF":score>=1?"ZAYIFLIYOR":"KARMA";
  }
  return {score,label,s10,s20,s50,s100,s200};
}

function barsSinceBreak(rows,boundary,direction,lookback=18){
  const start=Math.max(1,rows.length-lookback); let found=null;
  for(let i=start;i<rows.length;i++){
    const prev=rows[i-1].close,cur=rows[i].close;
    if(direction==="LONG"&&prev<=boundary*1.002&&cur>boundary*1.002)found=rows.length-1-i;
    if(direction==="SHORT"&&prev>=boundary*0.998&&cur<boundary*0.998)found=rows.length-1-i;
  }
  return found;
}

function stageLabel(stage){
  return ({PRE_BREAKOUT:"HAZIRLANIYOR",BREAKOUT_CONFIRMED:"BREAKOUT TEYİTLİ",INTRADAY_BREAKOUT_CONFIRMED:"15DK BREAKOUT TEYİTLİ",INTRADAY_RETEST:"15DK RETEST",RETEST:"RETEST",CONTINUATION_PREP:"CONTINUATION HAZIRLIK",CONTINUATION_BREAKOUT:"CONTINUATION BREAKOUT",EXTENDED:"KAÇMIŞ",NONE:"KLASİK"})[stage]||stage;
}

function publicStatusLabel(status){
  return ({PREPARING:"HAZIRLANIYOR",ARMED:"ARMED",EARLY_ENTRY:"ERKEN GİRİŞ ADAYI",TRIGGERED:"TETİKLENDİ",RETEST:"RETEST",MISSED:"KAÇTI / KOVALAMA",WAIT:"BEKLE/PAS"})[status]||status||"BEKLE/PAS";
}

function boundaryTestQuality(tests){
  if(tests>=4)return "PREMIUM";
  if(tests===3)return "KABUL";
  if(tests===2)return "ZAYIF";
  return "YETERSİZ";
}

function volatilitySanity(atrPct,adr){
  if(!(adr>0)&&!(atrPct>0))return {label:"BİLİNMİYOR",ratio:null,penalty:0};
  if(!(adr>0))return {label:"BİLİNMİYOR",ratio:null,penalty:0};
  const ratio=atrPct/adr;
  if(ratio>1.35)return {label:"AGRESİF",ratio,penalty:1};
  if(ratio>1.15)return {label:"YÜKSEK",ratio,penalty:0.5};
  return {label:"NORMAL",ratio,penalty:0};
}

function derivePublicStatus(stage,distPct,setup,tests){
  if(stage==="EXTENDED")return "MISSED";
  if(stage==="RETEST"||stage==="INTRADAY_RETEST")return "RETEST";
  if(["BREAKOUT_CONFIRMED","INTRADAY_BREAKOUT_CONFIRMED","CONTINUATION_BREAKOUT"].includes(stage))return "TRIGGERED";
  if(["PRE_BREAKOUT","CONTINUATION_PREP"].includes(stage)){
    if(Math.abs(distPct)<=V221_BELIT.armedDistancePct&&setup>=V221_BELIT.minArmedSetupQuality&&tests>=3)return "ARMED";
    return "PREPARING";
  }
  return "WAIT";
}

function fastIntradayTrigger(level,direction,x){
  const bars=(Array.isArray(x?.recent15mBars)?x.recent15mBars:[])
    .filter(r=>Number.isFinite(Number(r?.close)))
    .map(r=>({...r,time:Number(r.time||0),close:Number(r.close),high:Number(r.high),low:Number(r.low),volume:Number(r.volume||0)}))
    .sort((a,b)=>a.time-b.time)
    .slice(-6);
  const a15=num(x?.atr15)||(num(x?.atrPct)&&num(x?.analysisPrice)?num(x.atrPct)*num(x.analysisPrice)/100:null);
  const lastPrice=num(x?.lastPrice)||num(x?.entry)||num(x?.price);
  const markPrice=num(x?.markPrice);
  const marketRef=lastPrice!=null&&markPrice!=null?(lastPrice+markPrice)/2:(lastPrice??markPrice);
  let breakAgeBars=null;
  for(let i=1;i<bars.length;i++){
    const prev=bars[i-1].close,cur=bars[i].close;
    const crossed=direction==="LONG"?(prev<=level*1.001&&cur>level*1.001):(prev>=level*0.999&&cur<level*0.999);
    if(crossed)breakAgeBars=bars.length-1-i;
  }
  const latest=bars.at(-1);
  const lastAccepted=lastPrice==null?false:(direction==="LONG"?lastPrice>level:lastPrice<level);
  const markAccepted=markPrice==null?true:(direction==="LONG"?markPrice>level:markPrice<level);
  const closeAccepted=latest? (direction==="LONG"?latest.close>level:latest.close<level):false;
  const signedDistAtr=(a15>0&&marketRef!=null)?(direction==="LONG"?(marketRef-level)/a15:(level-marketRef)/a15):null;
  const triggerDistanceAtr=(a15>0&&marketRef!=null)?Math.abs(marketRef-level)/a15:null;
  const confirmed=breakAgeBars!=null&&breakAgeBars<=1&&closeAccepted&&lastAccepted&&markAccepted&&signedDistAtr!=null&&signedDistAtr>=0&&signedDistAtr<=1.0&&Boolean(x?.entryStillValid!==false);
  const retest=breakAgeBars!=null&&breakAgeBars>=1&&breakAgeBars<=4&&latest&&a15>0&&lastAccepted&&markAccepted&&
    (direction==="LONG"?latest.close>=level&&latest.close<=level+0.35*a15:latest.close<=level&&latest.close>=level-0.35*a15)&&Boolean(x?.entryStillValid!==false);
  const extended=breakAgeBars!=null&&signedDistAtr!=null&&signedDistAtr>1.5;
  return {breakAgeBars,confirmed,retest,extended,triggerDistanceAtr:round2(triggerDistanceAtr),signedDistanceAtr:round2(signedDistAtr),lastAccepted,markAccepted,closeAccepted};
}

function analyzeBelitDaily(rows,x){
  rows=arr(rows);
  const current=rows.at(-1),completed=rows.length>3?rows.slice(0,-1):rows.slice();
  const direction=["LONG","SHORT"].includes(x?.direction)?x.direction:"NEUTRAL";
  if(!current||direction==="NEUTRAL")return {stage:"NONE",publicStatus:"WAIT",setupQuality:0,triggerReadiness:0,executionScore:null,entryQuality:0,watchCandidate:false,extended:false};
  const a=atr(completed,20),adr=adrPct(completed,20);
  if(!(a>0))return {stage:"NONE",publicStatus:"WAIT",setupQuality:0,triggerReadiness:0,executionScore:null,entryQuality:num(x?.score)||0,watchCandidate:false,extended:false};

  const structure=completed.slice(-100),tol=Math.max(a*0.55,current.close*0.012);
  const highClusters=clusters(swings(structure,"HIGH"),tol);
  const lowClusters=clusters(swings(structure,"LOW"),tol);
  const res=pickBoundary(highClusters,current.close,a,"RESISTANCE")||pickBrokenBoundary(highClusters,current.close,a,"RESISTANCE");
  const sup=pickBoundary(lowClusters,current.close,a,"SUPPORT")||pickBrokenBoundary(lowClusters,current.close,a,"SUPPORT");
  const boundary=direction==="LONG"?res:sup;
  const comp=compression(completed),squeeze=directionalSqueeze(completed,direction),smas=smaState(completed.concat([current]),direction);
  const atrPct=a/current.close*100;
  const volSan=volatilitySanity(atrPct,adr);

  if(!boundary)return {
    stage:"NONE",publicStatus:"WAIT",setupQuality:round2(Math.min(6,(num(x?.score)||0)*0.65)),triggerReadiness:round2(Math.min(4,num(x?.score)||0)),executionScore:null,entryQuality:round2(Math.min(4,num(x?.score)||0)),watchCandidate:false,extended:false,
    boundary:null,boundaryTests:0,boundaryTestQuality:"YETERSİZ",adr20Pct:round2(adr),atr20Pct:round2(atrPct),volatilitySanity:volSan.label,volatilityRatio:round2(volSan.ratio),compressionRatio:round2(comp.ratio),
    compressionTightPct:round2(comp.tightPct),directionalSqueeze:squeeze,smaDaily:smas.label,smaStackScore:round2(smas.score),isCore5:CORE5.has(String(x?.symbol||"").toUpperCase())
  };

  const level=boundary.level;
  const marketClose=num(x?.lastPrice)||current.close;
  const distPct=direction==="LONG"?(level-marketClose)/marketClose*100:(marketClose-level)/marketClose*100;
  const distAtr=direction==="LONG"?(marketClose-level)/a:(level-marketClose)/a;
  const fast=fastIntradayTrigger(level,direction,x);
  const last2=completed.slice(-2).map(r=>r.close);
  const persistent=last2.length===2&&(direction==="LONG"?last2.every(c=>c>level*1.002):last2.every(c=>c<level*0.998));
  const since=barsSinceBreak(completed,level,direction);
  const r7=completed.slice(-7),rHi=Math.max(...r7.map(r=>r.high)),rLo=Math.min(...r7.map(r=>r.low));
  const held=direction==="LONG"?rLo>=level-0.35*a:rHi<=level+0.35*a;
  const highZone=since!=null&&since>=2&&since<=15&&held&&(rHi-rLo)/a<=4.2;
  const contBreak=highZone&&(direction==="LONG"?current.close>rHi*1.001:current.close<rLo*0.999);
  const retest=since!=null&&since<=12&&(direction==="LONG"
    ? current.close>=level-0.35*a&&current.close<=level+0.85*a
    : current.close<=level+0.35*a&&current.close>=level-0.85*a);
  const pre=distPct>=0&&distPct<=5&&boundary.tests>=2&&(comp.ok||squeeze);
  const confirmed=persistent&&(since==null||since<=2);
  const extended=(distAtr>3.2&&!highZone&&!retest)||fast.extended;

  let stage="NONE";
  if(extended)stage="EXTENDED";
  else if(fast.retest)stage="INTRADAY_RETEST";
  else if(fast.confirmed)stage="INTRADAY_BREAKOUT_CONFIRMED";
  else if(contBreak)stage="CONTINUATION_BREAKOUT";
  else if(highZone)stage="CONTINUATION_PREP";
  else if(retest&&since!=null&&since>=1)stage="RETEST";
  else if(confirmed)stage="BREAKOUT_CONFIRMED";
  else if(pre)stage="PRE_BREAKOUT";

  const pressure=direction==="LONG"?num(x?.buyPressurePct):num(x?.sellPressurePct);
  const volumeRatio=num(x?.volumeRatio)||0;
  const tests=boundary.tests;
  let setup=0;

  // Boundary quality is intentionally conservative: 3 tests are acceptable, 4+ are premium.
  setup+=tests>=5?2.25:tests===4?2:tests===3?1.25:tests===2?0.75:0;
  setup+=Math.abs(distPct)<=1.5?1.5:Math.abs(distPct)<=2.5?1.25:Math.abs(distPct)<=5?0.75:0;
  setup+=comp.ratio!=null&&comp.ratio<=0.7?1.5:comp.ratio!=null&&comp.ratio<=0.85?1:0;
  if(squeeze)setup+=1;
  setup+=Math.min(1.5,smas.score*0.6);
  if(x?.trend4h===direction&&x?.trend1h===direction)setup+=1;
  // Volume is mostly an execution confirmation, so it only nudges structural setup quality.
  setup+=volumeRatio>=1.2?0.5:volumeRatio>=1.05?0.25:0;
  setup+=pressure!=null&&pressure>=60?0.75:pressure!=null&&pressure>=55?0.5:0;
  if(x?.riskOk&&x?.rangeOk)setup+=0.5;
  if(["BREAKOUT_CONFIRMED","INTRADAY_BREAKOUT_CONFIRMED","INTRADAY_RETEST","RETEST","CONTINUATION_BREAKOUT"].includes(stage))setup+=0.25;
  setup-=volSan.penalty;
  setup=clamp(Math.round(setup*4)/4,0,10);
  if(stage==="PRE_BREAKOUT"&&tests===3)setup=Math.min(setup,9);
  if(stage==="PRE_BREAKOUT"&&tests<=2)setup=Math.min(setup,8.25);

  let readiness=0,execution=null;
  if(stage==="PRE_BREAKOUT"){
    readiness=3;
    readiness+=Math.abs(distPct)<=1.5?1.5:Math.abs(distPct)<=2.5?1:0.5;
    if(comp.ok)readiness+=0.5;
    if(squeeze)readiness+=0.5;
    if(x?.trend4h===direction&&x?.trend1h===direction)readiness+=0.5;
    if(smas.score>=2)readiness+=0.5;
    if(tests>=4)readiness+=0.5; else if(tests===3)readiness+=0.25;
    readiness-=volSan.penalty*0.5;
    readiness=Math.min(6,readiness);
  }else if(stage==="CONTINUATION_PREP"){
    readiness=3.75+(setup>=8?0.5:0)+(tests>=4?0.5:tests===3?0.25:0)+(x?.trend4h===direction&&x?.trend1h===direction?0.5:0);
    readiness-=volSan.penalty*0.5;
    readiness=Math.min(6.25,readiness);
  }else if(stage==="INTRADAY_BREAKOUT_CONFIRMED"){
    readiness=7.25+(volumeRatio>=1.2?0.75:volumeRatio>=1.05?0.5:0)+(pressure>=55?0.5:0)+(x?.riskOk&&x?.rangeOk?0.5:0)+(tests>=4?0.25:0)+(x?.entryStillValid?0.25:0)-volSan.penalty*0.5;
    execution=readiness;
  }else if(stage==="INTRADAY_RETEST"){
    readiness=7.5+(comp.ok?0.5:0)+(pressure>=55?0.5:0)+(x?.riskOk&&x?.rangeOk?0.5:0)+(volumeRatio>=1.05?0.25:0)+(x?.entryStillValid?0.25:0)-volSan.penalty*0.5;
    execution=readiness;
  }else if(stage==="BREAKOUT_CONFIRMED"){
    readiness=7+(volumeRatio>=1.2?0.75:volumeRatio>=1.05?0.5:0)+(pressure>=55?0.5:0)+(x?.riskOk&&x?.rangeOk?0.5:0)+(tests>=4?0.25:0)-volSan.penalty*0.5;
    execution=readiness;
  }else if(stage==="RETEST"){
    readiness=7.5+(comp.ok?0.5:0)+(pressure>=55?0.5:0)+(x?.riskOk&&x?.rangeOk?0.5:0)+(volumeRatio>=1.05?0.25:0)-volSan.penalty*0.5;
    execution=readiness;
  }else if(stage==="CONTINUATION_BREAKOUT"){
    readiness=7.75+(volumeRatio>=1.2?0.75:volumeRatio>=1.05?0.5:0)+(pressure>=55?0.5:0)+(x?.riskOk&&x?.rangeOk?0.5:0)-volSan.penalty*0.5;
    execution=readiness;
  }else if(stage==="EXTENDED"){
    readiness=Math.min(3,Math.max(1,(num(x?.score)||0)-5));
  }else{
    readiness=Math.min(4,num(x?.score)||0);
  }

  readiness=clamp(Math.round(readiness*4)/4,0,10);
  if(execution!=null)execution=clamp(Math.round(execution*4)/4,0,10);
  const publicStatus=derivePublicStatus(stage,distPct,setup,tests);
  const watchCandidate=["PREPARING","ARMED"].includes(publicStatus)&&setup>=V221_BELIT.minWatchSetupQuality&&
    x?.trend4h===direction&&x?.trend1h===direction&&x?.trend15m===direction&&Boolean(x?.ema200Aligned)&&!isSyntheticSymbol(x?.symbol)&&
    fast.triggerDistanceAtr!=null&&fast.triggerDistanceAtr<=0.5&&volumeRatio>=1.05;

  return {
    stage,publicStatus,setupQuality:setup,triggerReadiness:readiness,executionScore:execution,entryQuality:execution??readiness,watchCandidate,extended,
    boundary:+level.toFixed(8),boundaryTests:tests,boundaryTestQuality:boundaryTestQuality(tests),distanceToBoundaryPct:round2(distPct),distanceFromBoundaryATR:round2(distAtr),
    barsSinceBreak:since,persistentBreakout:persistent,intradayBreakAgeBars:fast.breakAgeBars,fastTriggerDistanceATR:fast.triggerDistanceAtr,fastDistanceFromBoundaryATR:fast.signedDistanceAtr,
    fastLastAccepted:fast.lastAccepted,fastMarkAccepted:fast.markAccepted,compressionRatio:round2(comp.ratio),compressionTightPct:round2(comp.tightPct),directionalSqueeze:squeeze,
    adr20Pct:round2(adr),atr20Pct:round2(atrPct),volatilitySanity:volSan.label,volatilityRatio:round2(volSan.ratio),smaDaily:smas.label,smaStackScore:round2(smas.score),
    isCore5:CORE5.has(String(x?.symbol||"").toUpperCase())
  };
}

function isV223Signal(x){
  const stage=String(x?.belitStage||"");
  const realTrigger=["BREAKOUT_CONFIRMED","INTRADAY_BREAKOUT_CONFIRMED","INTRADAY_RETEST","RETEST","CONTINUATION_BREAKOUT"].includes(stage);
  return Boolean(x?.v219Qualifies)&&realTrigger&&!Boolean(x?.belitExtended)&&Boolean(x?.entryStillValid!==false)&&num(x?.executionScore)!=null&&Number(x.executionScore)>=V221_BELIT.minExecutionQuality;
}

const isV221Signal=isV223Signal;
const isV220Signal=isV223Signal;

async function enrichBelitData(raw){
  const source=Array.isArray(raw?.all)?raw.all:[],all=[];
  for(let i=0;i<source.length;i+=2){
    const batch=source.slice(i,i+2);
    const enriched=await Promise.all(batch.map(async x=>{
      if(x?.error)return x;
      let b={stage:"NONE",publicStatus:"WAIT",setupQuality:0,triggerReadiness:0,executionScore:null,entryQuality:num(x?.score)||0,watchCandidate:false,extended:false,isCore5:CORE5.has(String(x?.symbol||"").toUpperCase())};
      let discovery={candidate:false,score:0},belitError=null;
      try{ const daily=await getDailyKlines(x.symbol); b=analyzeBelitDaily(daily,x); discovery=analyzeDiscovery(daily,x); }catch(e){ belitError=String(e?.message||e); }
      const out={
        ...x,
        belitStage:b.stage,publicStatus:b.publicStatus||"WAIT",setupQuality:b.setupQuality,triggerReadiness:b.triggerReadiness??b.entryQuality??0,executionScore:b.executionScore??null,
        entryQuality:b.entryQuality,belitWatchCandidate:b.watchCandidate,belitExtended:b.extended,
        boundary:b.boundary??null,boundaryTests:b.boundaryTests??0,boundaryTestQuality:b.boundaryTestQuality??"YETERSİZ",distanceToBoundaryPct:b.distanceToBoundaryPct??null,
        distanceFromBoundaryATR:b.distanceFromBoundaryATR??null,barsSinceBreak:b.barsSinceBreak??null,persistentBreakout:Boolean(b.persistentBreakout),
        compressionRatio:b.compressionRatio??null,compressionTightPct:b.compressionTightPct??null,directionalSqueeze:Boolean(b.directionalSqueeze),
        adr20Pct:b.adr20Pct??null,atr20DailyPct:b.atr20Pct??null,volatilitySanity:b.volatilitySanity??null,volatilityRatio:b.volatilityRatio??null,
        smaDaily:b.smaDaily??null,smaStackScore:b.smaStackScore??null,isCore5:b.isCore5??CORE5.has(String(x?.symbol||"").toUpperCase()),
        discoveryCandidate:Boolean(discovery.candidate),discoveryScore:discovery.score??0,discoveryDirection:discovery.direction??null,discoveryBoundary:discovery.boundary??null,discoveryBoundaryTests:discovery.boundaryTests??0,discoveryDistancePct:discovery.distancePct??null,discoveryCompression:Boolean(discovery.compression),discoverySqueeze:Boolean(discovery.squeeze),discoveryStaircase:Boolean(discovery.staircase),discoverySma:discovery.sma??null,discoveryBaseSpanDays:discovery.baseSpanDays??null,belitError
      };
      out.v223Qualifies=isV223Signal(out);
      out.v221Qualifies=out.v223Qualifies;
      out.v220Qualifies=out.v223Qualifies;
      out.qualifies=out.v223Qualifies;
      return out;
    }));
    all.push(...enriched);
  }
  const signals=all.filter(isV223Signal)
    .sort((a,b)=>(Number(b.executionScore)||0)-(Number(a.executionScore)||0)||(Number(b.setupQuality)||0)-(Number(a.setupQuality)||0)||(Number(b.score)||0)-(Number(a.score)||0))
    .slice(0,V221_BELIT.maxSignalsPerScan);
  const signalSymbols=new Set(signals.map(x=>x.symbol));
  const watch=all.filter(x=>x.belitWatchCandidate&&!signalSymbols.has(x.symbol))
    .sort((a,b)=>(b.publicStatus==="ARMED")-(a.publicStatus==="ARMED")||(Number(b.setupQuality)||0)-(Number(a.setupQuality)||0)||(Number(b.triggerReadiness)||0)-(Number(a.triggerReadiness)||0)||Math.abs(Number(a.distanceToBoundaryPct)||99)-Math.abs(Number(b.distanceToBoundaryPct)||99))
    .slice(0,V221_BELIT.maxWatchPerScan);
  const watchSymbols=new Set(watch.map(x=>x.symbol));
  const discovery=all.filter(x=>x.discoveryCandidate&&!signalSymbols.has(x.symbol)&&!watchSymbols.has(x.symbol))
    .sort((a,b)=>(Number(b.discoveryScore)||0)-(Number(a.discoveryScore)||0)||Math.abs(Number(a.discoveryDistancePct)||99)-Math.abs(Number(b.discoveryDistancePct)||99))
    .slice(0,V221_BELIT.maxDiscoveryPerScan);
  return {...raw,version:"BINGX_WIDE_V3_2_DISCOVERY",signals,watch,discovery,all};
}

return { V221_BELIT, analyzeDiscovery, stageLabel, publicStatusLabel, fastIntradayTrigger, analyzeBelitDaily, isV223Signal, isV221Signal, isV220Signal, enrichBelitData };
})();

const __hybrid = (() => {
const { enrichBelitData, stageLabel: belitStageLabel, publicStatusLabel } = __belit;


function stageLabel(stage){ return belitStageLabel(stage); }

const CORE5=new Set(["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","DOGE-USDT"]);
const CFG={minHybridSetup:7.5,minExecution:7.5,minEarlyExecution:8.3,minEmre:6,minAksel:6.5,minBelit:6.25,maxSignals:2,maxWatch:5};
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round2=v=>Number.isFinite(v)?Math.round(v*100)/100:null;
const arr=v=>Array.isArray(v)?v:[];
const avg=a=>arr(a).length?arr(a).reduce((x,y)=>x+y,0)/arr(a).length:0;

function atr(rows,p=14){
  if(!Array.isArray(rows)||rows.length<=p)return null;
  const v=[]; for(let i=rows.length-p;i<rows.length;i++){const prev=rows[i-1].close;v.push(Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-prev),Math.abs(rows[i].low-prev)));}
  return avg(v);
}
function lin(values){
  const n=values.length;if(n<3)return null;let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=i;sy+=values[i];sxx+=i*i;sxy+=i*values[i];}
  const d=n*sxx-sx*sx;if(!d)return null;const slope=(n*sxy-sx*sy)/d,intercept=(sy-slope*sx)/n;
  return {slope,intercept,at:i=>intercept+slope*i};
}
function impulseFib(x){
  const rows=arr(x?.recent4hBars).slice(-54); const dir=x?.direction;
  if(rows.length<28||!["LONG","SHORT"].includes(dir))return {valid:false,score:0,retracement:null,impulsePct:null,invalid:false,label:"YOK"};
  const cut=Math.max(12,Math.floor(rows.length*0.68));
  let startI=-1,endI=-1,start=null,end=null;
  if(dir==="LONG"){
    for(let i=0;i<cut;i++)if(start==null||rows[i].low<start){start=rows[i].low;startI=i;}
    if(startI>=0)for(let i=startI+3;i<rows.length;i++)if(end==null||rows[i].high>end){end=rows[i].high;endI=i;}
  }else{
    for(let i=0;i<cut;i++)if(start==null||rows[i].high>start){start=rows[i].high;startI=i;}
    if(startI>=0)for(let i=startI+3;i<rows.length;i++)if(end==null||rows[i].low<end){end=rows[i].low;endI=i;}
  }
  if(!(start>0)||!(end>0)||endI<=startI)return {valid:false,score:0,retracement:null,impulsePct:null,invalid:false,label:"YOK"};
  const move=Math.abs(end-start),current=num(x?.lastPrice)||rows.at(-1).close,a=atr(rows,14);
  const impulsePct=move/start*100; if(!(a>0)||move<3*a||impulsePct<3)return {valid:false,score:0,retracement:null,impulsePct:round2(impulsePct),invalid:false,label:"ZAYIF"};
  const retr=dir==="LONG"?(end-current)/move:(current-end)/move;
  let score=0,label="UZAMIŞ";
  if(retr>=0.236&&retr<=0.618){score=2;label="FIB 0.236–0.618";}
  else if(retr>0.618&&retr<=0.786){score=1;label="FIB 0.618–0.786";}
  else if(retr>=0&&retr<0.236){score=1.25;label="SIĞ RETRACE";}
  else if(retr<0){score=1;label="YENİ ZİRVE/DİP";}
  const invalid=retr>0.786;
  return {valid:true,score,retracement:round2(retr),impulsePct:round2(impulsePct),invalid,label,start,end,startI,endI};
}
function emreLayer(x){
  const dir=x?.direction; if(!["LONG","SHORT"].includes(dir))return {score:0,invalid:true,label:"YÖN YOK",fib:impulseFib(x),reasons:["yön henüz belirlenmedi"]};
  const fib=impulseFib(x); let s=0,reasons=[];
  if(x?.trend4h===dir&&x?.trend1h===dir){s+=2.5;reasons.push("4s+1s HTF uyum");}
  else if(x?.trend4h===dir){s+=1.25;reasons.push("4s yön uyum");}
  if(x?.ema200Aligned){s+=1;reasons.push("4s EMA200");}
  const daily=String(x?.smaDaily||"");
  const dailyGood=dir==="LONG"?["POZİTİF","İYİLEŞİYOR"].includes(daily):["NEGATİF","ZAYIFLIYOR"].includes(daily);
  if(dailyGood){s+=1.5;reasons.push("1G SMA rejimi");}
  const r=num(x?.rsi4h);
  if(r!=null){if(dir==="LONG"&&r>=48&&r<=72){s+=1;reasons.push(`4s RSI ${r}`);} if(dir==="SHORT"&&r>=28&&r<=52){s+=1;reasons.push(`4s RSI ${r}`);}}
  if(num(x?.adx4h)>=22){s+=0.5;reasons.push("4s trend gücü");}
  if(fib.valid){s+=fib.score;reasons.push(fib.label);}
  if(x?.trend15m===dir)s+=0.5;
  if(x?.entryStillValid!==false)s+=0.5;
  if(x?.isCore5||CORE5.has(String(x?.symbol||"")))s+=0.25;
  const invalid=Boolean(fib.invalid)||(x?.trend4h&&x.trend4h!=="NEUTRAL"&&x.trend4h!==dir);
  if(invalid)s=Math.min(s,5.75);
  return {score:round2(clamp(s,0,10)),invalid,label:invalid?"HTF/FIB INVALID":"HTF UYUMLU",fib,reasons};
}
function flagChannel(x){
  const dir=x?.direction,rows=arr(x?.recent4hBars).slice(-40); if(rows.length<28||!["LONG","SHORT"].includes(dir))return {candidate:false,armed:false,confirmed:false,retest:false,extended:false};
  const flagN=10,flag=rows.slice(-flagN),prior=rows.slice(-28,-flagN); if(prior.length<12)return {candidate:false,armed:false,confirmed:false,retest:false,extended:false};
  const priorMovePct=(prior.at(-1).close-prior[0].close)/prior[0].close*100;
  const hi=lin(flag.map(r=>r.high)),lo=lin(flag.map(r=>r.low)); if(!hi||!lo)return {candidate:false,armed:false,confirmed:false,retest:false,extended:false};
  const px=flag.at(-1).close,hiSlopePct=hi.slope/px*100,loSlopePct=lo.slope/px*100;
  const slopeParallel=Math.abs(hiSlopePct-loSlopePct)<=Math.max(0.20,0.9*Math.max(Math.abs(hiSlopePct),Math.abs(loSlopePct)));
  const impulseOk=dir==="LONG"?priorMovePct>=3.5:priorMovePct<=-3.5;
  const channelOk=dir==="LONG"?(hiSlopePct<0.02&&loSlopePct<0.02):(hiSlopePct>-0.02&&loSlopePct>-0.02);
  const a4=atr(rows,14),width=Math.abs(hi.at(flagN-1)-lo.at(flagN-1));
  const compact=a4>0&&width<=4.5*a4;
  const candidate=impulseOk&&channelOk&&slopeParallel&&compact;
  const boundary=dir==="LONG"?hi.at(flagN):lo.at(flagN);
  const a15=num(x?.atr15),last=num(x?.lastPrice)||px,mark=num(x?.markPrice),bars=arr(x?.recent15mBars).slice(-8);
  const latest=bars.at(-1),prev=bars.at(-2);
  const accept=dir==="LONG"?(last>boundary&&(mark==null||mark>boundary)):(last<boundary&&(mark==null||mark<boundary));
  const closeAccept=latest? (dir==="LONG"?latest.close>boundary:latest.close<boundary):false;
  const crossed=latest&&prev?(dir==="LONG"?prev.close<=boundary&&latest.close>boundary:prev.close>=boundary&&latest.close<boundary):false;
  const distATR=a15>0?(dir==="LONG"?(last-boundary)/a15:(boundary-last)/a15):null;
  const confirmed=candidate&&crossed&&closeAccept&&accept&&distATR!=null&&distATR>=0&&distATR<=1.0&&x?.entryStillValid!==false;
  const armed=candidate&&!confirmed&&a15>0&&Math.abs(last-boundary)<=0.5*a15;
  const retest=candidate&&!confirmed&&accept&&a15>0&&distATR!=null&&distATR>=0&&distATR<=0.35;
  const extended=candidate&&distATR!=null&&distATR>1.5;
  return {candidate,armed,confirmed,retest,extended,boundary:round2(boundary),priorMovePct:round2(priorMovePct),hiSlopePct:round2(hiSlopePct),loSlopePct:round2(loSlopePct),distATR:round2(distATR),compact,slopeParallel};
}
function akselLayer(x){
  const dir=x?.direction,flag=flagChannel(x); let s=0,reasons=[];
  const tests=Number(x?.boundaryTests||0);
  if(tests>=4){s+=2.5;reasons.push("4+ yatay test");} else if(tests===3){s+=2;reasons.push("3 yatay test");} else if(tests===2){s+=1;}
  if(flag.candidate){s+=3;reasons.push("4s flag/channel");}
  if(flag.armed){s+=0.75;reasons.push("eğimli sınır yakın");}
  if(flag.confirmed||flag.retest){s+=1.5;reasons.push(flag.retest?"flag retest":"flag kırılım kapanışı");}
  if(["TRIGGERED","RETEST"].includes(x?.publicStatus)){s+=1.25;reasons.push("yatay kırılım/retest");}
  if(x?.compressionRatio!=null&&Number(x.compressionRatio)<=0.85){s+=0.75;reasons.push("sıkışma");}
  if(x?.trend4h===dir&&x?.trend1h===dir)s+=0.75;
  if(x?.entryStillValid!==false)s+=0.5;
  if(x?.riskOk&&x?.rangeOk)s+=0.75;
  if(flag.extended||x?.belitExtended)s=Math.min(s,5.5);
  const pattern=flag.candidate&&tests>=3?"YATAY + FLAG":flag.candidate?"FLAG/CHANNEL":tests>=2?"YATAY BREAKOUT":"YAPI ZAYIF";
  return {score:round2(clamp(s,0,10)),pattern,flag,reasons};
}
function belitLayer(x,flag){
  const dir=x?.direction; let s=num(x?.executionScore)??num(x?.triggerReadiness)??num(x?.setupQuality)??0;
  // Flag setupında yatay boundary şartı Belit katmanını haksız yere sıfırlamasın; execution bileşenlerinden ayrı destek puanı oluştur.
  if(flag?.candidate&&s<6.25){
    let g=3.5;
    if(x?.trend15m===dir)g+=0.75;
    if(num(x?.volumeRatio)>=1.2)g+=1; else if(num(x?.volumeRatio)>=1.05)g+=0.5;
    if(num(x?.v32RadarScore)>=7)g+=0.75; else if(num(x?.v32RadarScore)>=6.25)g+=0.5;
    const pressure=dir==="LONG"?num(x?.buyPressurePct):num(x?.sellPressurePct); if(pressure>=60)g+=1; else if(pressure>=55)g+=0.5;
    if(x?.smaStackScore>=1.5)g+=1;
    if(x?.entryStillValid!==false)g+=0.5;
    if(x?.riskOk&&x?.rangeOk)g+=0.75;
    s=Math.max(s,g);
  }
  return {score:round2(clamp(s,0,10)),label:"HACİM/SMA/ADR-ATR/15DK"};
}
function mergeStatus(x,aksel,setup){
  if(x?.publicStatus==="MISSED"||aksel.flag.extended)return "MISSED";
  if(aksel.flag.retest)return "RETEST";
  if(aksel.flag.confirmed)return "TRIGGERED";
  if(["TRIGGERED","RETEST"].includes(x?.publicStatus))return x.publicStatus;
  if(aksel.flag.armed&&setup>=7.5)return "ARMED";
  if((aksel.flag.candidate||["PREPARING","ARMED"].includes(x?.publicStatus))&&setup>=7.5)return x?.publicStatus==="ARMED"?"ARMED":"PREPARING";
  return "WAIT";
}
function hybridOne(x){
  if(x?.error)return x;
  const emre=emreLayer(x),aksel=akselLayer(x),belit=belitLayer(x,aksel.flag);
  const flag=aksel.flag.candidate;
  const setupBase=flag?0.30*emre.score+0.40*aksel.score+0.30*belit.score:0.25*emre.score+0.35*aksel.score+0.40*belit.score;
  const radarScore=num(x?.v32RadarScore)??0;
  const radarSetupBonus=radarScore>=7?0.5:radarScore>=6.25?0.35:radarScore>=5?0.15:0;
  const setup=round2(clamp(setupBase+radarSetupBonus,0,10));
  const status=mergeStatus(x,aksel,setup);
  const realTrigger=["TRIGGERED","RETEST"].includes(status);
  let exec=realTrigger?setupBase:null;
  if(exec!=null&&num(x?.volumeRatio)>=1.2)exec+=0.25;
  if(exec!=null&&radarScore>=6.25)exec+=0.25;
  if(exec!=null&&x?.entryStillValid===false)exec=Math.min(exec,5.5);
  if(exec!=null&&(x?.belitExtended||aksel.flag.extended))exec=Math.min(exec,5.5);
  exec=exec==null?null:round2(clamp(exec,0,10));
  const fundingOk=num(x?.fundingRate)==null||Math.abs(Number(x.fundingRate))<0.003;
  const normalQualifies=realTrigger&&!emre.invalid&&emre.score>=CFG.minEmre&&aksel.score>=CFG.minAksel&&belit.score>=CFG.minBelit&&exec>=CFG.minExecution&&x?.entryStillValid!==false&&fundingOk&&Boolean(x?.riskOk)&&Boolean(x?.rangeOk)&&!Boolean(x?.belitExtended)&&!Boolean(aksel.flag.extended);

  // V3.2 EARLY STARTER: hareketi teyitten sonra kovalamak yerine, güçlü hacim liderliği + kaliteli yapı
  // sınırın hemen yakınındayken küçük PAPER kademe açar. Gerçek para için bu durum ayrıca temel/katalizör review ister.
  const dir=x?.direction,opposite=dir==="LONG"?"SHORT":dir==="SHORT"?"LONG":"NEUTRAL";
  const radarDir=String(x?.v32DirectionHint||"NEUTRAL");
  const radarAligned=radarDir==="NEUTRAL"||radarDir===dir;
  const boundaryDist=Math.abs(num(x?.distanceToBoundaryPct)??99),flagDist=Math.abs(num(aksel?.flag?.distATR)??99),discDist=Math.abs(num(x?.discoveryDistancePct)??99);
  const nearBoundary=boundaryDist<=2.5||flagDist<=0.75||discDist<=3.0;
  const earlyBase=setup+(radarScore>=8?0.75:radarScore>=7?0.6:radarScore>=6.25?0.45:0);
  const earlyExec=round2(clamp(earlyBase,0,10));
  const earlyCandidate=!realTrigger&&["PREPARING","ARMED"].includes(status)&&Boolean(x?.earlyVolumeLead)&&radarScore>=6.25&&radarAligned&&x?.trend15m!==opposite&&nearBoundary&&!emre.invalid&&emre.score>=6&&aksel.score>=6.25&&belit.score>=6&&setup>=7.75&&earlyExec>=CFG.minEarlyExecution&&x?.entryStillValid!==false&&fundingOk&&Boolean(x?.riskOk)&&Boolean(x?.rangeOk)&&!Boolean(x?.belitExtended)&&!Boolean(aksel.flag.extended);

  const qualifies=normalQualifies||earlyCandidate;
  const finalExec=earlyCandidate?earlyExec:exec;
  const finalStatus=earlyCandidate?"EARLY_ENTRY":status;
  const paperEntryType=earlyCandidate?"EARLY_STARTER":normalQualifies?"CONFIRMED":null;
  const watch=!qualifies&&["PREPARING","ARMED"].includes(status)&&setup>=CFG.minHybridSetup&&!emre.invalid&&emre.score>=5.5&&aksel.score>=6&&belit.score>=5.75;
  return {...x,
    emreScore:emre.score,emreFibRetracement:emre.fib.retracement,emreFibLabel:emre.fib.label,emreImpulsePct:emre.fib.impulsePct,emreInvalid:emre.invalid,
    akselScore:aksel.score,patternType:aksel.pattern,flagBoundary:aksel.flag.boundary??null,flagDistanceATR:aksel.flag.distATR??null,flagCandidate:Boolean(aksel.flag.candidate),flagConfirmed:Boolean(aksel.flag.confirmed),flagRetest:Boolean(aksel.flag.retest),
    belitScore:belit.score,belitSetupQuality:x?.setupQuality??null,belitExecutionScore:x?.executionScore??null,
    hybridSetupScore:setup,hybridExecutionScore:finalExec,setupQuality:setup,executionScore:finalExec,entryQuality:finalExec??setup,triggerReadiness:finalExec??setup,
    publicStatus:finalStatus,hybridQualifies:qualifies,v300Qualifies:qualifies,qualifies,paperEntryType,earlyEntryCandidate:earlyCandidate,requiresFundamentalReview:earlyCandidate,belitWatchCandidate:watch,hybridWatchCandidate:watch,
    hybridReasons:[...(Array.isArray(emre?.reasons)?emre.reasons:[]).slice(0,2),...(Array.isArray(aksel?.reasons)?aksel.reasons:[]).slice(0,2),...(radarScore>=6.25?[`V3.2 hacim radar ${radarScore}/10`]:[]),`Belit ${belit.score}/10`]
  };
}

function isV300Signal(x){ return Boolean(x?.v300Qualifies)&&Number(x?.hybridExecutionScore??x?.executionScore)>=CFG.minExecution; }
async function enrichHybridData(raw){
  const b=await enrichBelitData(raw);
  const source=arr(b?.all);
  const all=source.map(x=>{
    try{return hybridOne(x);}
    catch(e){return {...x,error:`HYBRID: ${String(e?.message||e)}`,hybridQualifies:false,v300Qualifies:false,qualifies:false,hybridWatchCandidate:false,belitWatchCandidate:false};}
  });
  const signals=all.filter(isV300Signal).sort((a,b)=>(Number(b.hybridExecutionScore)||0)-(Number(a.hybridExecutionScore)||0)||(Number(b.hybridSetupScore)||0)-(Number(a.hybridSetupScore)||0)).slice(0,CFG.maxSignals);
  const ss=new Set(signals.map(x=>x.symbol));
  const watch=all.filter(x=>x.hybridWatchCandidate&&!ss.has(x.symbol)).sort((a,b)=>(b.publicStatus==="ARMED")-(a.publicStatus==="ARMED")||(Number(b.hybridSetupScore)||0)-(Number(a.hybridSetupScore)||0)).slice(0,CFG.maxWatch);
  return {...b,version:"BINGX_WIDE_V3_2_HYBRID",signals,watch,all};
}

return { publicStatusLabel, stageLabel, isV300Signal, enrichHybridData };
})();

const __base = (() => {
const CORE5 = ["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","DOGE-USDT"];
const FAST_LIQUID_COUNT = 10;
const MIN_QUOTE_VOLUME_USDT = 1_500_000;
const MAX_TICKER_SPREAD_PCT = 0.45;

const CFG = {
  minScore: 7,
  leverage: 5,
  paperBalance: 200,
  maxMarginPct: 0.10,
  universeSize: 600, // hard rank cutoff yok; yalnız güvenlik üst sınırı
  shardSize: 12,
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

function paperQuality(s){
  const q=Number(s?.executionScore ?? s?.entryQuality ?? s?.score);
  return Number.isFinite(q)?q:0;
}

function paperMarginForQuality(q){
  q=Number(q);
  if(!Number.isFinite(q)||q<7.5)return 0;
  if(q>=9)return 15;
  if(q>=8)return 10;
  // 7.5–7.99 deneysel bant: 5–7 USDT; puan yükseldikçe kademeli artar.
  return Math.max(5,Math.min(7,Math.round(5+((q-7.5)/0.5)*2)));
}

function paperScoreBand(q){
  q=Number(q);
  if(q>=9)return "9+";
  if(q>=8)return "8.0-8.5";
  if(q>=7.5)return "7.5-7.9";
  return "<7.5";
}

function tradePaperMargin(trade){
  const m=Number(trade?.paperMarginUSDT ?? trade?.marginUSDT);
  return Number.isFinite(m)&&m>0?m:CFG.liveMarginUSDT; // legacy kayıtlar 20 USDT olarak kalır
}

function asArray(v){ return Array.isArray(v)?v:[]; }
function avg(arr) { arr=asArray(arr); return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function sum(arr) { arr=asArray(arr); return arr.reduce((a,b)=>a+b,0); }

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

function syntheticTickerSymbol(symbol){
  const s=String(symbol||"").toUpperCase();
  return /(?:NCCO|BRENT|WTI|OIL|XAU|XAG|GOLD|SILVER|NASDAQ|SP500|DOW|DJI|FOREX)/.test(s);
}

async function getUniverseSymbols(limit = CFG.universeSize) {
  const u = new URL("https://open-api.bingx.com/openApi/swap/v2/quote/ticker");
  const json = await bingxJson(u);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .filter(x => typeof x?.symbol === "string" && x.symbol.endsWith("-USDT") && !syntheticTickerSymbol(x.symbol))
    .map(x => {
      const bid=Number(x.bidPrice ?? x.bid ?? x.bestBidPrice);
      const ask=Number(x.askPrice ?? x.ask ?? x.bestAskPrice);
      const last=Number(x.lastPrice||0), qv=Number(x.quoteVolume||0);
      const mid=bid>0&&ask>0?(bid+ask)/2:null;
      const spreadPct=mid?((ask-bid)/mid)*100:null;
      return {symbol:x.symbol,quoteVolume:qv,lastPrice:last,spreadPct:Number.isFinite(spreadPct)?spreadPct:null};
    })
    .filter(x => Number.isFinite(x.quoteVolume) && x.quoteVolume>=MIN_QUOTE_VOLUME_USDT && Number.isFinite(x.lastPrice) && x.lastPrice>0)
    .filter(x => x.spreadPct==null || x.spreadPct<=MAX_TICKER_SPREAD_PCT)
    .sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,limit);
}

async function getPremiumIndexMap(){
  const u=new URL("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex");
  const json=await bingxJson(u);
  const rows=Array.isArray(json?.data)?json.data:(json?.data?[json.data]:[]);
  const out=new Map();
  for(const r of rows){
    const symbol=String(r?.symbol||"");
    if(!symbol)continue;
    const markPrice=Number(r?.markPrice);
    const fundingRate=Number(r?.lastFundingRate);
    out.set(symbol,{
      markPrice:Number.isFinite(markPrice)&&markPrice>0?markPrice:null,
      fundingRate:Number.isFinite(fundingRate)?fundingRate:null,
      indexPrice:Number.isFinite(Number(r?.indexPrice))?Number(r.indexPrice):null,
    });
  }
  return out;
}

function completedRows(rows,intervalMs){
  const now=Date.now();
  const done=(Array.isArray(rows)?rows:[]).filter(r=>{
    const ct=Number(r?.closeTime||0),ot=Number(r?.time||0);
    if(ct>0)return ct<=now+1500;
    if(ot>0)return ot+intervalMs<=now+1500;
    return true;
  });
  return done.length?done:(Array.isArray(rows)?rows:[]);
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
  rows=asArray(rows);
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

function analyze(symbol,h4,h1,m15,btcDir,quoteVolume=null,marketLastPrice=null,premium=null) {
  const h4Use=completedRows(h4,4*60*60*1000);
  const h1Use=completedRows(h1,60*60*1000);
  const m15Use=completedRows(m15,15*60*1000);
  const m15c=m15Use.map(x=>x.close);
  const dir4h=trend(h4Use), dir1h=trend(h1Use), dir15=trend(m15Use);
  const direction=chooseDirection(dir4h,dir1h,dir15);
  const last=m15Use.at(-1), rr=rsi(m15c,14), a=atr(m15Use,14);
  if(!last)throw new Error(`${symbol} 15m: kapanmış mum yok`);
  const analysisClose=Number(last.close);
  const currentLast=Number.isFinite(Number(marketLastPrice))&&Number(marketLastPrice)>0?Number(marketLastPrice):analysisClose;
  const markPrice=Number.isFinite(Number(premium?.markPrice))&&Number(premium.markPrice)>0?Number(premium.markPrice):null;
  const fundingRate=Number.isFinite(Number(premium?.fundingRate))?Number(premium.fundingRate):null;
  const atrPct=a?(a/analysisClose)*100:99, adx4h=adx(h4Use,14), ema200=ema200Alignment(h4Use,direction);
  const entryDriftPct=analysisClose>0?Math.abs(currentLast-analysisClose)/analysisClose*100:null;
  const entryDriftATR=a?Math.abs(currentLast-analysisClose)/a:null;
  const markLastGapPct=markPrice&&currentLast?Math.abs(markPrice-currentLast)/currentLast*100:null;
  const entryStillValid=(entryDriftATR==null||entryDriftATR<=0.75)&&(markLastGapPct==null||markLastGapPct<=0.35);

  const recentVol=avg(m15Use.slice(-4).map(x=>x.volume));
  const baseVol=avg(m15Use.slice(-24,-4).map(x=>x.volume));
  const volRatio=baseVol>0?recentVol/baseVol:0;

  const prior=m15Use.slice(-21,-1), prevHigh=Math.max(...prior.map(x=>x.high)), prevLow=Math.min(...prior.map(x=>x.low));
  const breakoutLong=analysisClose>prevHigh, breakoutShort=analysisClose<prevLow;
  const nearLong=!breakoutLong&&a&&analysisClose<=prevHigh&&(prevHigh-analysisClose)<=0.2*a;
  const nearShort=!breakoutShort&&a&&analysisClose>=prevLow&&(analysisClose-prevLow)<=0.2*a;
  const pressure=volumePressure(m15Use,6);

  let score=0; const reasons=[];
  if (direction!=="NEUTRAL"&&dir4h===direction){score+=1.5;reasons.push("4s ana trend uyumlu");}
  if (direction!=="NEUTRAL"&&ema200.aligned){score+=0.5;reasons.push("4s EMA200 uyumlu");}
  if (direction!=="NEUTRAL"&&adx4h!=null){
    if(adx4h>=25){score+=0.5;reasons.push(`4s ADX güçlü ${adx4h.toFixed(1)}`);}
    else if(adx4h>=20){score+=0.25;reasons.push(`4s ADX orta ${adx4h.toFixed(1)}`);}
  }
  if(direction!=="NEUTRAL"&&dir1h===direction){score+=1;reasons.push("1s trend teyidi");}
  if(direction!=="NEUTRAL"&&dir15===direction){score+=0.5;reasons.push("15dk kapanmış mum momentumu aynı yönde");}
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
  if(!entryStillValid){reasons.push(`giriş güncelliği zayıf: ${entryDriftATR==null?"-":entryDriftATR.toFixed(2)} ATR · Last/Mark farkı %${markLastGapPct==null?"-":markLastGapPct.toFixed(2)}`);}

  score=Math.min(10,Math.round(score*4)/4);

  const a1=atr(h1Use,14);
  const h1Ema20=ema(h1Use.map(x=>x.close),20);
  const rsi4h=rsi(h4Use.map(x=>x.close),14);
  const rsi1h=rsi(h1Use.map(x=>x.close),14);
  const swing=m15Use.slice(-13,-1);
  const swingHigh=swing.length?Math.max(...swing.map(x=>x.high)):last.high;
  const swingLow=swing.length?Math.min(...swing.map(x=>x.low)):last.low;

  let stop=null,tp1=null,tp2=null,riskDist=null,stopPct=null,tp1MovePct=null,tp2MovePct=null;
  let targetR=null,rangeOk=false,riskOk=false,runnerTrailATR=null;
  if(direction!=="NEUTRAL"&&a&&a1){
    const buffer=0.25*a;
    const structuralStop=direction==="LONG"?(swingLow-buffer):(swingHigh+buffer);
    const structuralRisk=direction==="LONG"?(currentLast-structuralStop):(structuralStop-currentLast);
    const atrRisk=Math.max(1.5*a,0.65*a1);
    riskDist=Math.max(atrRisk,structuralRisk>0?structuralRisk:0);

    const strongTrend=dir4h===direction&&dir1h===direction&&adx4h!=null&&adx4h>=25;
    const breakoutWithVolume=(direction==="LONG"&&breakoutLong||direction==="SHORT"&&breakoutShort)&&volRatio>=1.5;
    const veryStrong=strongTrend&&breakoutWithVolume;
    targetR=veryStrong?5:(strongTrend?4:3);
    runnerTrailATR=veryStrong?2.0:(strongTrend?1.7:1.5);

    stopPct=(riskDist/currentLast)*100;
    tp1MovePct=(2*riskDist/currentLast)*100;
    tp2MovePct=(targetR*riskDist/currentLast)*100;
    riskOk=stopPct<=CFG.maxStopPct;
    rangeOk=tp2MovePct>=CFG.minTP2MovePct;

    if(direction==="LONG"){
      stop=currentLast-riskDist;
      tp1=currentLast+2*riskDist;
      tp2=currentLast+targetR*riskDist;
    }else{
      stop=currentLast+riskDist;
      tp1=currentLast-2*riskDist;
      tp2=currentLast-targetR*riskDist;
    }

    if(strongTrend) reasons.push(`trend güçlü: TP2 ${targetR}R`);
    if(!rangeOk) reasons.push(`hedef aralığı dar: TP2 hareketi %${tp2MovePct.toFixed(2)}`);
    if(!riskOk) reasons.push(`stop aralığı geniş: %${stopPct.toFixed(2)}`);
  }

  const qualifies=score>=CFG.minScore&&direction!=="NEUTRAL"&&rangeOk&&riskOk&&entryStillValid;
  const grossTp1Pct=tp1MovePct==null?null:tp1MovePct*CFG.leverage;
  const grossTp2Pct=tp2MovePct==null?null:tp2MovePct*CFG.leverage;
  const runnerPlan=`TP1'de %${CFG.tp1ClosePct} kapat → SL girişe; TP2'de %${CFG.tp2ClosePct} kapat → kalan %${CFG.runnerPct} 1s EMA20 / ${runnerTrailATR??1.5} ATR trailing`;
  const recent15mBars=m15Use.slice(-12).map(r=>({time:Number(r.time||0),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume||0)}));
  const recent4hBars=h4Use.slice(-72).map(r=>({time:Number(r.time||0),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume||0)}));
  const recent1hBars=h1Use.slice(-72).map(r=>({time:Number(r.time||0),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume||0)}));

  return {
    symbol,direction,score,qualifies,
    price:+currentLast.toFixed(8),analysisPrice:+analysisClose.toFixed(8),lastPrice:+currentLast.toFixed(8),markPrice:markPrice==null?null:+markPrice.toFixed(8),fundingRate,
    entryDriftPct:entryDriftPct==null?null:+entryDriftPct.toFixed(3),entryDriftATR:entryDriftATR==null?null:+entryDriftATR.toFixed(2),markLastGapPct:markLastGapPct==null?null:+markLastGapPct.toFixed(3),entryStillValid,
    rsi:rr==null?null:+rr.toFixed(1),volumeRatio:+volRatio.toFixed(2),atr15:a==null?null:+a.toFixed(8),
    atrPct:+atrPct.toFixed(2),adx4h:adx4h==null?null:+adx4h.toFixed(1),ema200Aligned:ema200.aligned,
    buyPressurePct:pressure.buyShare==null?null:+(pressure.buyShare*100).toFixed(1),
    sellPressurePct:pressure.sellShare==null?null:+(pressure.sellShare*100).toFixed(1),
    trend4h:dir4h,trend1h:dir1h,trend15m:dir15,quoteVolume24h:quoteVolume==null?null:Math.round(quoteVolume),
    entry:+currentLast.toFixed(8),stop:stop==null?null:+stop.toFixed(8),tp1:tp1==null?null:+tp1.toFixed(8),tp2:tp2==null?null:+tp2.toFixed(8),
    stopPct:stopPct==null?null:+stopPct.toFixed(2),tp1MovePct:tp1MovePct==null?null:+tp1MovePct.toFixed(2),tp2MovePct:tp2MovePct==null?null:+tp2MovePct.toFixed(2),
    targetR,rangeOk,riskOk,runnerTrailATR,h1Ema20:h1Ema20==null?null:+h1Ema20.toFixed(8),
    atr1hPct:a1==null?null:+((a1/currentLast)*100).toFixed(2),rsi4h:rsi4h==null?null:+rsi4h.toFixed(1),rsi1h:rsi1h==null?null:+rsi1h.toFixed(1),recent15mBars,recent4hBars,recent1hBars,
    tp1ClosePct:CFG.tp1ClosePct,tp2ClosePct:CFG.tp2ClosePct,runnerPct:CFG.runnerPct,runnerPlan,
    grossTp1Pct:grossTp1Pct==null?null:+grossTp1Pct.toFixed(1),grossTp2Pct:grossTp2Pct==null?null:+grossTp2Pct.toFixed(1),
    leverage:CFG.leverage,paperMarginUSDT:null,reasons
  };
}

function shardIndexFor(shardCount,date=new Date()){
  if(!shardCount)return 0;
  return Math.floor(date.getTime()/60000)%shardCount;
}

async function scan(extraSymbols=[]){
  extraSymbols=asArray(extraSymbols);
  const [top,premiumMap,btc4h,btc1h,btc15]=await Promise.all([
    getUniverseSymbols(CFG.universeSize),
    getPremiumIndexMap(),
    getKlines("BTC-USDT","4h",220),
    getKlines("BTC-USDT","1h",120),
    getKlines("BTC-USDT","15m",120),
  ]);

  const btc15Use=completedRows(btc15,15*60*1000);
  const btc4=trend(btc4h),btc1=trend(btc1h),btc15dir=trend(btc15Use);
  const btcDir=btc4!=="NEUTRAL"?btc4:(btc1===btc15dir?btc1:"NEUTRAL");

  const shardCount=Math.ceil(top.length/CFG.shardSize), shardIndex=shardIndexFor(shardCount);
  const topSafe=asArray(top);
  const shardItems=topSafe.slice(shardIndex*CFG.shardSize,(shardIndex+1)*CFG.shardSize);
  const focusSet=new Set((Array.isArray(extraSymbols)?extraSymbols:[]).map(String));
  const coreSet=new Set(CORE5);
  const fastLiquidItems=topSafe.slice(0,FAST_LIQUID_COUNT);
  const selectedMap=new Map();
  // Her dakika: en likit 10 + CORE5 garantisi + V3.2 radar/watch/discovery focus.
  // Geri kalan yeterli likiditeli BingX perpetual evreni rotating shard ile taranır.
  for(const item of [...fastLiquidItems,...topSafe.filter(x=>coreSet.has(x.symbol)),...topSafe.filter(x=>focusSet.has(x.symbol)),...shardItems])if(item?.symbol)selectedMap.set(item.symbol,item);
  const selected=[...selectedMap.values()],results=[];

  for(let i=0;i<selected.length;i+=2){
    const batch=asArray(selected).slice(i,i+2);
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
        return analyze(item.symbol,h4,h1,m15,btcDir,item.quoteVolume,item.lastPrice,premiumMap.get(item.symbol)||null);
      }catch(e){return {symbol:item.symbol,error:String(e.message||e)};}
    }));
    results.push(...batchResults);
  }

  return {
    mode:"PAPER_SCAN",version:"BINGX_WIDE_V3_2",scannedAt:new Date().toISOString(),btcDirection:btcDir,minScore:CFG.minScore,
    universe:`BingX ${top.length} likit USDT perpetual · min 24s hacim $${MIN_QUOTE_VOLUME_USDT.toLocaleString()}${MAX_TICKER_SPREAD_PCT?` · spread ≤%${MAX_TICKER_SPREAD_PCT}`:""}`,universeCount:top.length,universeMinQuoteVolumeUSDT:MIN_QUOTE_VOLUME_USDT,maxTickerSpreadPct:MAX_TICKER_SPREAD_PCT,shard:shardIndex+1,shardCount,estimatedFullCycleMin:shardCount,
    scannedSymbols:selected.map(x=>x.symbol),focusSymbols:[...focusSet],coreFastSymbols:CORE5.filter(s=>selectedMap.has(s)),fastLiquidSymbols:fastLiquidItems.map(x=>x.symbol),paperBalanceUSDT:CFG.paperBalance,
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
    throw new Error("Teorik margin bu coinde kademeli TP için kontrat minimumunun altında");
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


function openPaperMetrics(trade){
  if(!trade||trade.status!=="OPEN")return null;
  const price=Number(trade.lastPrice);
  const entry=Number(trade.entry);
  const risk=Math.abs(entry-Number(trade.initialStop));
  if(!(price>0)&&!(entry>0))return null;
  if(!(price>0))return {
    currentPrice:null,unrealizedPct:null,unrealizedR:null,gross5xPct:null,pnlUSDT:null
  };
  const signedPct=trade.direction==="LONG"
    ? ((price-entry)/entry)*100
    : ((entry-price)/entry)*100;
  const signedMove=trade.direction==="LONG"
    ? (price-entry)
    : (entry-price);
  const r=risk>0?signedMove/risk:null;
  const gross5xPct=signedPct*CFG.leverage;
  const pnlUSDT=tradePaperMargin(trade)*(gross5xPct/100);
  return {
    currentPrice:+price.toFixed(8),
    unrealizedPct:+signedPct.toFixed(2),
    unrealizedR:r==null?null:+r.toFixed(3),
    gross5xPct:+gross5xPct.toFixed(2),
    pnlUSDT:+pnlUSDT.toFixed(2)
  };
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

  const openMetrics=open.map(t=>openPaperMetrics(t)).filter(Boolean);
  const pricedOpen=openMetrics.filter(x=>x.unrealizedR!=null);
  const openWins=pricedOpen.filter(x=>x.unrealizedR>0.0001).length;
  const openLosses=pricedOpen.filter(x=>x.unrealizedR<-0.0001).length;
  const totalOpenR=pricedOpen.reduce((a,x)=>a+Number(x.unrealizedR||0),0);
  const avgOpenR=pricedOpen.length?totalOpenR/pricedOpen.length:0;
  const totalOpenUSDT=pricedOpen.reduce((a,x)=>a+Number(x.pnlUSDT||0),0);
  const avgOpenUSDT=pricedOpen.length?totalOpenUSDT/pricedOpen.length:0;

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

  const byScoreBand={};
  for(const band of ["7.5-7.9","8.0-8.5","9+"]){
    const arr=closed.filter(t=>String(t.scoreBand||paperScoreBand(t.qualityScore??t.executionScore??t.entryQuality??t.score))===band);
    const w=arr.filter(t=>Number(t.realizedR)>0.0001).length;
    const totalBandR=arr.reduce((a,t)=>a+Number(t.realizedR||0),0);
    byScoreBand[band]={
      count:arr.length,
      wins:w,
      winRatePct:arr.length?+(100*w/arr.length).toFixed(1):0,
      avgR:arr.length?+(totalBandR/arr.length).toFixed(3):0,
      totalR:+totalBandR.toFixed(3)
    };
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
    openPriced:pricedOpen.length,
    openWins,
    openLosses,
    totalOpenR:+totalOpenR.toFixed(3),
    avgOpenR:+avgOpenR.toFixed(3),
    totalOpenUSDT:+totalOpenUSDT.toFixed(2),
    avgOpenUSDT:+avgOpenUSDT.toFixed(2),
    byScore,
    byScoreBand,
    byDirection,
    methodology:"1dk mum; aynı mumda stop+hedef varsa konservatif olarak stop/BE önce; TP1 sonrası BE; TP2 sonrası sabit ATR-oranlı runner trailing; ücret/slippage hariç"
  };
}

class PaperTracker{
  constructor(state,env){
    this.state=state;
    this.env=env;
  }

  async loadTrades(){
    const v=await this.state.storage.get("trades");
    return Array.isArray(v)?v:[];
  }

  async saveTrades(trades){
    trades=asArray(trades);
    const trimmed=trades
      .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
      .slice(0,CFG.paperMaxTrades);
    await this.state.storage.put("trades",trimmed);
    return trimmed;
  }

  async addSignals(trades,signals,scannedAt){
    const now=Date.parse(scannedAt)||Date.now();
    const addedSignals=[];

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

      const qualityScore=paperQuality(s);
      const paperMarginUSDT=paperMarginForQuality(qualityScore);
      if(!(paperMarginUSDT>0))continue;

      trades.push({
        id:`${s.symbol}:${s.direction}:${createdMs}`,
        symbol:s.symbol,
        direction:s.direction,
        score:Number(s.score),
        qualityScore,
        scoreBand:paperScoreBand(qualityScore),
        paperMarginUSDT,
        leverage:CFG.leverage,
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
      addedSignals.push({symbol:s.symbol,direction:s.direction,score:Number(s.score),createdAt:new Date(createdMs).toISOString()});
    }
    return addedSignals;
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
        const latest=rows.at(-1);
        if(latest?.close>0){
          trade.lastPrice=Number(latest.close);
          trade.lastPriceAt=new Date(Number(latest.time)||Date.now()).toISOString();
        }
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
        `Yaklaşık sonuç: ${approxGrossPct>=0?"+":"-"}$${Math.abs(tradePaperMargin(t)*approxGrossPct/100).toFixed(2)}`,
        `Teorik margin: ${tradePaperMargin(t)} USDT · ${t.scoreBand||paperScoreBand(t.qualityScore??t.score)} · ${t.leverage||CFG.leverage}x`,
        `5x brüt: ${approxGrossPct>=0?"+":"-"}%${Math.abs(approxGrossPct).toFixed(2)} · Analiz: ${t.realizedR>=0?"+":""}${Number(t.realizedR).toFixed(2)}R`,
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
      const addedSignals=await this.addSignals(trades,body?.signals,body?.scannedAt||new Date().toISOString());
      const closedNow=await this.trackOpenTrades(trades);
      trades=await this.saveTrades(trades);
      if(closedNow.length)await this.notifyClosed(closedNow);
      return Response.json({
        ok:true,
        added:addedSignals.length,
        addedSignals,
        closedNow:closedNow.map(t=>({symbol:t.symbol,direction:t.direction,status:t.status,realizedR:t.realizedR})),
        stats:paperSummary(trades)
      });
    }

    if(url.pathname==="/stats"){
      const trades=await this.loadTrades();
      const sorted=[...asArray(trades)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      return Response.json({
        ok:true,
        stats:paperSummary(sorted),
        trades:sorted.slice(0,100).map(t=>{
          const openM=openPaperMetrics(t);
          return {
            id:t.id,symbol:t.symbol,direction:t.direction,score:t.score,
            qualityScore:t.qualityScore??t.executionScore??t.entryQuality??t.score,scoreBand:t.scoreBand||paperScoreBand(t.qualityScore??t.executionScore??t.entryQuality??t.score),
            paperMarginUSDT:tradePaperMargin(t),leverage:t.leverage||CFG.leverage,scannerVersion:t.scannerVersion||null,
            setupQuality:t.setupQuality??null,entryQuality:t.entryQuality??null,triggerReadiness:t.triggerReadiness??null,executionScore:t.executionScore??null,publicStatus:t.publicStatus??null,
            entry:t.entry,stop:t.initialStop,tp1:t.tp1,tp2:t.tp2,
            createdAt:t.createdAt,status:t.status,closedAt:t.closedAt||null,
            realizedR:Number(t.realizedR||0),holdMinutes:t.holdMinutes??null,
            tp1Hit:Boolean(t.tp1Hit),tp2Hit:Boolean(t.tp2Hit),
            currentPrice:openM?.currentPrice??null,
            unrealizedPct:openM?.unrealizedPct??null,
            unrealizedR:openM?.unrealizedR??null,
            gross5xPct:openM?.gross5xPct??null,
            pnlUSDT:openM?.pnlUSDT??null,
            lastPriceAt:t.lastPriceAt||null,
            exits:t.exits||[],lastTrackError:t.lastTrackError||null
          };
        })
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
      await sendPrimary(env,`BingX ${x.direction} ${x.score}/10 · V2.17`,message,actionUrl,actionLabel);
    }catch(e){
      console.error("ALERT_ERROR",String(e?.message||e));
    }

    if(data.signals.length>1)await sleep(1200);
  }
}

function page(data,execMode="KAPALI",paper=null){
  const openPaper=(paper?.trades||[]).filter(t=>t.status==="OPEN");
  const openCards=openPaper.length?openPaper.map(t=>{
    const r=t.unrealizedR;
    const pct=t.unrealizedPct;
    const gross=t.gross5xPct;
    const usd=t.pnlUSDT;
    const pnlCls=usd==null?"muted":usd>0?"good":usd<0?"bad":"muted";
    return `<div class="paperCard">
      <div class="row"><b>${t.symbol} · ${t.direction} · ${t.score}/10</b><span class="${pnlCls}">${usd==null?"fiyat bekleniyor":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`}</span></div>
      <div>Giriş: ${t.entry} · Güncel: ${t.currentPrice??"-"}</div>
      <div class="${pnlCls}">Anlık: ${usd==null?"-":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`} · 5x: ${gross==null?"-":`${gross>=0?"+":""}${gross}%`}</div>
      <div>SL: ${t.stop} · TP1: ${t.tp1} ${t.tp1Hit?"✅":""} · TP2: ${t.tp2} ${t.tp2Hit?"✅":""}</div>
    </div>`;
  }).join(""):`<div class="muted">Açık paper işlem yok.</div>`;
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
    <div>Runner: TP2 sonrası ATR trailing · AUTO PAPER'da TP1 sonrası SL girişe taşınır</div>
    <div>5x brüt teorik: TP1 ≈ %${x.grossTp1Pct??"-"} · TP2 ≈ %${x.grossTp2Pct??"-"} <small>(ücret/slippage hariç)</small></div>
    <small>${(x.reasons||[]).join(" · ")||"Teyit yetersiz"}</small>${tradeButton}</div>`;
  }).join("");

  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.head{margin-bottom:14px}.card{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.tradeBtn{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;font-weight:700;font-size:16px}.tradeBtn:disabled{opacity:.55}.notifyBtn{margin:10px 0 4px;padding:10px 14px;border:0;border-radius:10px;font-weight:700}.paperWrap{margin:14px 0;padding:12px;background:#111419;border:1px solid #2a2f37;border-radius:14px}.paperCard{padding:10px 0;border-bottom:1px solid #2a2f37;line-height:1.5}.paperCard:last-child{border-bottom:0}</style>
  <div class="head"><h2>BingX Paper Bot · Top100 V2.17</h2><div>Tarama: PAPER · İşlem köprüsü: ${execMode} · Eşik: ${data.minScore}/10 · BTC: ${data.btcDirection}</div>
  <div>4s + 1s + 15dk · 5x isolated · PAPER margin puana göre 5–15 USDT · LIVE yolu bu pakette TEST kilitli</div>
  <div>${paper?.stats?`AUTO PAPER: ${paper.stats.open} açık · ${paper.stats.closed} kapanan · Win %${paper.stats.winRatePct} · Açık: ${paper.stats.openWins} kâr / ${paper.stats.openLosses} zarar · Açık toplam ${paper.stats.totalOpenUSDT>=0?"+":"-"}$${Math.abs(paper.stats.totalOpenUSDT).toFixed(2)}`:"AUTO PAPER: başlatılıyor..."}</div>
  <button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button>
  ${execMode!=="KAPALI"?`<button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button>`:""}
  <div>Top100 likit evren · Dilim ${data.shard}/${data.shardCount} · Bu tur ${data.all.length} coin</div><small>*15dk mum fiyat-konumu ve hacminden hesaplanan tahmini baskı · Son tarama: ${data.scannedAt}</small></div>
  <div class="paperWrap"><b>AÇIK AUTO PAPER POZİSYONLARI</b>${openCards}</div>${cards}
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

const __base_default = {
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
      const focus=(url.searchParams.get("focus")||"").split(",").map(x=>x.trim()).filter(Boolean).slice(0,10);
      const data=await scan(focus);
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
      version:"V2.17",
      signals:data.signals.map(x=>({symbol:x.symbol,direction:x.direction,score:x.score}))
    }));
    let paperResult=null;
    try{
      paperResult=await paperTick(env,data);
    }catch(e){
      console.error("PAPER_TRACK_ERROR",String(e?.message||e));
    }

    if(data.signals.length){
      const execMode=String(env?.EXECUTION_MODE||"TEST").toUpperCase();
      let alertSignals=data.signals;
      if(execMode!=="LIVE"&&paperResult?.addedSignals){
        const keys=new Set(paperResult.addedSignals.map(s=>`${s.symbol}|${s.direction}`));
        alertSignals=data.signals.filter(s=>keys.has(`${s.symbol}|${s.direction}`));
      }
      if(alertSignals.length){
        ctx.waitUntil(sendSignalAlerts(env,{...data,signals:alertSignals}).catch(e=>console.error("ALERT_ERROR",String(e?.message||e))));
      }
    }
  },
};

return { default: __base_default, PaperTracker };
})();

const { default: baseWorker, PaperTracker: BasePaperTracker } = __base;
const { enrichHybridData, isV300Signal, stageLabel, publicStatusLabel } = __hybrid;

const BASE_URL = "https://bingx-paper-bot.yasinaltas39.workers.dev";
const V219 = {
  version: "V6.0",
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

const V32_RADAR = {
  // Legacy name kept so the proven Durable Object state remains compatible.
  // In V6 this is the universe-wide PRE-RANK layer of the Explosive Move Engine.
  minQuoteVolumeUSDT: 1_500_000,
  maxSpreadPct: 0.45,
  maxLeaders: 24,
  focusCap: 12,
  leaderTtlMs: 18 * 60 * 1000,
  minFlowUsd: 5_000,
  minCandidateScore: 4.25,
  strongScore: 6.0,
  alertScore: 7.0,
};

const V6 = {
  version: "V6.0",
  minPaperScore: 7.5,
  minExpectedMoveR: 1.8,
  minEarlyness: 0.42,
  maxSignalsPerScan: 2,
  oiFocusCap: 12,
  forwardLabelTopN: 8,
  forwardLabelMinScore: 5.5,
  forwardLabelBucketMin: 15,
  horizonsMin: [30,120,360],
  defaultFeeBps: 5,
  defaultSlippageBps: 3,
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
function marginForSignal(x){ return x?.paperEntryType==="EARLY_STARTER"?4:marginForQuality(x?.executionScore??x?.entryQuality??x?.score); }
function errInfo(stage,e){
  const message=String(e?.message||e||"bilinmeyen hata");
  const stack=String(e?.stack||"").split("\n").slice(0,4).join(" | ");
  console.error(`V6.0 ${stage}`,stack||message);
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
  return {...raw,version:"BINGX_V6_PREP",minScore:V6.minPaperScore,signals:[],all};
}

async function scanThroughBase(env,focusSymbols=[],radarLeaders=[]){
  const u=new URL(`${BASE_URL}/json`);
  const focus=(Array.isArray(focusSymbols)?focusSymbols:[]).map(String).filter(Boolean).slice(0,V32_RADAR.focusCap);
  if(focus.length)u.searchParams.set("focus",focus.join(","));
  const res=await baseWorker.fetch(new Request(u),paperEnv(env));
  if(!res.ok)throw new Error(`Tarama HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  const raw=upgradeData(await res.json());
  const radarMap=new Map((Array.isArray(radarLeaders)?radarLeaders:[]).filter(x=>x?.symbol).map(x=>[String(x.symbol),x]));
  raw.all=(raw.all||[]).map(x=>{
    const r=radarMap.get(String(x?.symbol||""));
    return r?{...x,v32RadarScore:r.radarScore,v32FlowPaceX:r.flowPaceX,v32FlowAccelX:r.flowAccelX,v32FlowUsd:r.flowUsd,v32Price1mPct:r.price1mPct,v32Price5mPct:r.price5mPct,v32Price15mPct:r.price15mPct,v32DirectionHint:r.directionHint,v32RadarReason:r.reason,earlyVolumeLead:Number(r.radarScore)>=V32_RADAR.strongScore}:x;
  });
  let data=await enrichHybridData(raw);
  data=await applyV6ExplosionEngine(data,radarLeaders,env);
  data.fastFocusSymbols=focus;
  data.volumeRadar=(Array.isArray(radarLeaders)?radarLeaders:[]);
  data.volumeRadarUniverseCount=Number(raw?.volumeRadarUniverseCount||0)||null;
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

function mergeFocus(radar,watch,discovery){
  const out=[],seen=new Set();
  // V3.2: hacim/anomali radarı ağır analize ilk erişimi alır. Sonra mevcut ARMED ve discovery adayları korunur.
  const buckets=[
    (Array.isArray(radar)?radar:[]).slice(0,V32_RADAR.focusCap),
    (Array.isArray(watch)?watch:[]).slice(0,2),
    (Array.isArray(discovery)?discovery:[]).slice(0,2),
  ];
  for(const bucket of buckets){
    for(const x of bucket){
      const sym=String(x?.symbol||""); if(!sym||seen.has(sym))continue;
      seen.add(sym);out.push(x); if(out.length>=V32_RADAR.focusCap)return out;
    }
  }
  return out;
}

async function getWideTickerSnapshot(){
  const u=new URL("https://open-api.bingx.com/openApi/swap/v2/quote/ticker");
  const res=await fetch(u,{headers:{accept:"application/json"}});
  if(!res.ok)throw new Error(`Radar ticker HTTP ${res.status}`);
  const json=await res.json();
  if(json?.code!=null&&Number(json.code)!==0)throw new Error(`Radar ticker: ${json.msg||json.code}`);
  const rows=Array.isArray(json?.data)?json.data:[];
  return rows.filter(x=>typeof x?.symbol==="string"&&x.symbol.endsWith("-USDT")&&!isSyntheticSymbol(x.symbol)).map(x=>{
    const bid=Number(x.bidPrice??x.bid??x.bestBidPrice),ask=Number(x.askPrice??x.ask??x.bestAskPrice);
    const bidQty=Number(x.bidQty??x.bidQuantity??x.bestBidQty),askQty=Number(x.askQty??x.askQuantity??x.bestAskQty);
    const last=Number(x.lastPrice||0),quoteVolume=Number(x.quoteVolume||0),mid=bid>0&&ask>0?(bid+ask)/2:null;
    const spreadPct=mid?((ask-bid)/mid)*100:null;
    const bookTotal=(bidQty>0?bidQty:0)+(askQty>0?askQty:0);
    const bookBuyPct=bookTotal>0?100*(bidQty>0?bidQty:0)/bookTotal:null;
    return {
      symbol:String(x.symbol),lastPrice:last,quoteVolume,
      bidPrice:Number.isFinite(bid)?bid:null,askPrice:Number.isFinite(ask)?ask:null,
      bidQty:Number.isFinite(bidQty)?bidQty:null,askQty:Number.isFinite(askQty)?askQty:null,
      bookBuyPct:Number.isFinite(bookBuyPct)?+bookBuyPct.toFixed(2):null,
      spreadPct:Number.isFinite(spreadPct)?spreadPct:null
    };
  }).filter(x=>Number.isFinite(x.lastPrice)&&x.lastPrice>0&&Number.isFinite(x.quoteVolume)&&x.quoteVolume>=V32_RADAR.minQuoteVolumeUSDT&&(x.spreadPct==null||x.spreadPct<=V32_RADAR.maxSpreadPct));
}

async function updateVolumeRadar(env,rows,scannedAt=new Date().toISOString()){
  try{
    const res=await trackerStub(env).fetch("https://paper.local/v32-volume-radar",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rows,scannedAt})
    });
    if(!res.ok)return {leaders:[],universeCount:Array.isArray(rows)?rows.length:0,warmed:false};
    return res.json();
  }catch(e){errInfo("V32_RADAR",e);return {leaders:[],universeCount:Array.isArray(rows)?rows.length:0,warmed:false};}
}

async function getVolumeRadar(env){
  try{
    const res=await trackerStub(env).fetch("https://paper.local/v32-volume-radar");
    if(!res.ok)return {leaders:[],universeCount:0,warmed:false};
    return res.json();
  }catch{return {leaders:[],universeCount:0,warmed:false};}
}

async function prepareRadar(env){
  const rows=await getWideTickerSnapshot();
  const state=await updateVolumeRadar(env,rows,new Date().toISOString());
  return {...state,universeCount:rows.length};
}

function clamp01(v){ return Math.max(0,Math.min(1,Number(v)||0)); }
function roundN(v,n=3){ const x=Number(v); if(!Number.isFinite(x))return null; const p=10**n; return Math.round(x*p)/p; }
function signedDir(direction){ return direction==="LONG"?1:direction==="SHORT"?-1:0; }
function directionalPct(direction,pct){ const v=Number(pct); return Number.isFinite(v)?signedDir(direction)*v:null; }
function weighted01(parts){
  let w=0,s=0;
  for(const p of parts){
    if(!p||p.value==null||!Number.isFinite(Number(p.value))||!(Number(p.weight)>0))continue;
    w+=Number(p.weight);s+=Number(p.weight)*clamp01(p.value);
  }
  return w>0?s/w:0;
}
function paceComponent(v,soft=1.3,strong=4){
  v=Number(v); if(!Number.isFinite(v)||v<=0)return null;
  return clamp01((Math.log(Math.max(v,soft))-Math.log(soft))/Math.max(0.001,Math.log(strong)-Math.log(soft)));
}
function absComponent(v,soft,strong){
  v=Math.abs(Number(v)); if(!Number.isFinite(v))return null;
  return clamp01((v-soft)/Math.max(0.001,strong-soft));
}
function directionFromRadar(r,x){
  const d=String(r?.directionHint||"");
  if(["LONG","SHORT"].includes(d))return d;
  return ["LONG","SHORT"].includes(x?.direction)?x.direction:"NEUTRAL";
}
function fundingComponent(direction,rate){
  const r=Number(rate);
  if(!Number.isFinite(r)||!["LONG","SHORT"].includes(direction))return null;
  // Funding is used as squeeze/crowding context, never as a standalone direction call.
  const signed=direction==="LONG"?r:-r;
  if(signed<=-0.0015)return 1;      // move direction is under-owned / squeeze-friendly
  if(signed<=-0.0003)return 0.8;
  if(signed<0.0005)return 0.6;
  if(signed<0.0015)return 0.4;
  if(signed<0.0030)return 0.2;
  return 0.05;                       // crowded in the same direction
}
function regimeComponent(direction,btcDirection){
  if(!["LONG","SHORT"].includes(direction))return null;
  const b=String(btcDirection||"NEUTRAL").toUpperCase();
  if(b===direction)return 1;
  if(!["LONG","SHORT"].includes(b))return 0.6;
  return 0.25;
}
function bookComponent(direction,bookBuyPct){
  const b=Number(bookBuyPct);
  if(!Number.isFinite(b))return null;
  const directional=direction==="LONG"?b:100-b;
  return clamp01((directional-45)/20);
}
function orderFlowComponent(direction,x){
  const p=direction==="LONG"?Number(x?.buyPressurePct):Number(x?.sellPressurePct);
  if(!Number.isFinite(p))return null;
  return clamp01((p-48)/22);
}
function oiComponent(direction,oi5,oi15,p1,p5){
  const d5=Number(oi5),d15=Number(oi15);
  if(!Number.isFinite(d5)&&!Number.isFinite(d15))return null;
  const oi=Number.isFinite(d15)?d15:d5;
  const priceDir=directionalPct(direction,Number.isFinite(Number(p5))?p5:p1);
  const mag=clamp01(Math.abs(oi)/4);
  // Rising OI with price in the move direction = fresh participation.
  if(oi>=0&&Number(priceDir)>=0)return 0.55+0.45*mag;
  // Falling OI with violent directional price can be a squeeze/forced unwind.
  if(oi<0&&Number(priceDir)>=0.25)return 0.45+0.35*mag;
  return 0.2+0.25*mag;
}
function earlynessScore(r,x){
  const p1=Math.abs(Number(r?.price1mPct)||0),p5=Math.abs(Number(r?.price5mPct)||0);
  const hot=Number(r?.hotCount||0),volx=Number(r?.volExpansionX);
  let e=0.72;
  if(hot<=2)e+=0.12; else if(hot>=6)e-=0.18;
  if(p5<=0.8)e+=0.10; else if(p5>=2.5)e-=0.20; else if(p5>=1.6)e-=0.10;
  if(p1>=0.12&&p1<=0.55)e+=0.06; else if(p1>=0.9)e-=0.12;
  if(Number.isFinite(volx)&&volx>=1.8)e+=0.08;
  if(x?.belitExtended||x?.akselFlag?.extended)e-=0.35;
  if(x?.entryStillValid===false)e-=0.30;
  return clamp01(e);
}
function expectedMoveR(x,explosionScore){
  const stop=Math.abs(Number(x?.stopPct));
  if(!(stop>0))return null;
  const tp2=Math.abs(Number(x?.tp2MovePct));
  const atr=Math.abs(Number(x?.atr1hPct));
  const adr=Math.abs(Number(x?.adr20Pct));
  const candidates=[
    Number.isFinite(tp2)?tp2:null,
    Number.isFinite(atr)?atr*(1.3+0.08*Math.max(0,Number(explosionScore)-7)):null,
    Number.isFinite(adr)?adr*0.35:null
  ].filter(Number.isFinite);
  if(!candidates.length)return null;
  return Math.max(...candidates)/stop;
}
function v6Margin(score,moveR,earlyness){
  score=Number(score);moveR=Number(moveR);earlyness=Number(earlyness);
  if(!(score>=V6.minPaperScore&&moveR>=V6.minExpectedMoveR&&earlyness>=V6.minEarlyness))return null;
  if(score>=9&&moveR>=3&&earlyness>=0.60)return 10;
  if(score>=8.4&&moveR>=2.5&&earlyness>=0.52)return 7;
  if(score>=7.9&&moveR>=2.1)return 5;
  return 4;
}
function v6SignalEligible(x){
  return Boolean(
    x?.v6PaperEligible &&
    x?.qualifies &&
    ["LONG","SHORT"].includes(x?.direction) &&
    Number(x?.v6ExplosionScore)>=V6.minPaperScore &&
    Number(x?.v6ExpectedMoveR)>=V6.minExpectedMoveR &&
    Number(x?.v6Earlyness)>=V6.minEarlyness &&
    Number(x?.v6PaperMarginUSDT)>0
  );
}

async function fetchOpenInterest(symbol){
  try{
    const u=new URL("https://open-api.bingx.com/openApi/swap/v2/quote/openInterest");
    u.searchParams.set("symbol",symbol);
    const res=await fetch(u,{headers:{accept:"application/json"}});
    if(!res.ok)return null;
    const j=await res.json();
    if(j?.code!=null&&Number(j.code)!==0)return null;
    const d=j?.data;
    const oi=Number(d?.openInterest);
    return Number.isFinite(oi)&&oi>=0?{symbol,openInterest:oi,time:Number(d?.time)||Date.now()}:null;
  }catch{return null;}
}

async function updateV6OiState(env,rows,scannedAt){
  if(!rows.length)return {};
  try{
    const res=await trackerStub(env).fetch("https://paper.local/v6-oi-state",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({rows,scannedAt})
    });
    if(!res.ok)return {};
    const j=await res.json();
    return j?.metrics&&typeof j.metrics==="object"?j.metrics:{};
  }catch{return {};}
}

async function getV6OiMetrics(env,symbols,scannedAt){
  const unique=[...new Set((Array.isArray(symbols)?symbols:[]).map(String).filter(Boolean))].slice(0,V6.oiFocusCap);
  const rows=(await Promise.all(unique.map(fetchOpenInterest))).filter(Boolean);
  return updateV6OiState(env,rows,scannedAt);
}

async function applyV6ExplosionEngine(data,radarLeaders,env){
  const all=Array.isArray(data?.all)?data.all:[];
  const rmap=new Map((Array.isArray(radarLeaders)?radarLeaders:[]).filter(x=>x?.symbol).map(x=>[String(x.symbol),x]));
  const symbols=all.map(x=>String(x?.symbol||"")).filter(Boolean);
  const oiMap=await getV6OiMetrics(env,symbols,data?.scannedAt||new Date().toISOString());

  const scored=all.map(x=>{
    const r=rmap.get(String(x?.symbol||""))||{};
    const direction=directionFromRadar(r,x);
    const alignedBase=x?.direction===direction;
    const p1=Number(r?.price1mPct),p5=Number(r?.price5mPct);
    const momentum=weighted01([
      {weight:0.45,value:absComponent(p1,0.05,0.65)},
      {weight:0.55,value:absComponent(p5,0.15,1.8)}
    ]);
    const flow=weighted01([
      {weight:0.48,value:paceComponent(r?.flowPaceX,1.15,5)},
      {weight:0.37,value:paceComponent(r?.flowAccelX,1.15,4)},
      {weight:0.15,value:absComponent(r?.flowUsd,5_000,150_000)}
    ]);
    const vol=Number.isFinite(Number(r?.volExpansionX))?clamp01((Number(r.volExpansionX)-0.9)/2.1):null;
    const book=bookComponent(direction,r?.bookBuyPct);
    const orderFlow=orderFlowComponent(direction,x);
    const oi=oiMap?.[x.symbol]||{};
    const oiScore=oiComponent(direction,oi?.change5mPct,oi?.change15mPct,p1,p5);
    const funding=fundingComponent(direction,x?.fundingRate);
    const regime=regimeComponent(direction,data?.btcDirection);
    const technical=Number.isFinite(Number(x?.hybridSetupScore))?clamp01(Number(x.hybridSetupScore)/10):null;

    const raw=10*weighted01([
      {weight:0.23,value:momentum},
      {weight:0.19,value:flow},
      {weight:0.13,value:vol},
      {weight:0.12,value:orderFlow},
      {weight:0.08,value:book},
      {weight:0.12,value:oiScore},
      {weight:0.05,value:funding},
      {weight:0.05,value:regime},
      {weight:0.03,value:technical},
    ]);
    const early=earlynessScore(r,x);
    const score=Math.max(0,Math.min(10,raw*(0.84+0.16*early)));
    const moveR=expectedMoveR(x,score);
    const margin=v6Margin(score,moveR,early);
    const safeRiskPlan=alignedBase && Number(x?.entry)>0 && Number(x?.stop)>0 && Number(x?.tp1)>0 && Number(x?.tp2)>0 &&
      x?.entryStillValid!==false && Boolean(x?.riskOk) && Boolean(x?.rangeOk) && !Boolean(x?.belitExtended);
    const paperEligible=Boolean(
      safeRiskPlan &&
      score>=V6.minPaperScore &&
      Number(moveR)>=V6.minExpectedMoveR &&
      early>=V6.minEarlyness &&
      margin>0
    );

    const proxy=weighted01([
      {weight:0.55,value:oiScore},
      {weight:0.25,value:funding},
      {weight:0.20,value:momentum}
    ]);

    return {
      ...x,
      direction,
      qualifies:paperEligible,
      score:roundN(score,2),
      executionScore:roundN(score,2),
      entryQuality:roundN(score,2),
      setupQuality:roundN(10*weighted01([{weight:.6,value:flow},{weight:.4,value:momentum}]),2),
      publicStatus:paperEligible?"ENTRY":score>=7?"ARMED":score>=5.5?"PREPARING":"WAIT",
      paperEntryType:"V6_EXPLOSIVE",
      scannerVersion:"V6.0",
      v6ExplosionScore:roundN(score,2),
      v6Earlyness:roundN(early,3),
      v6ExpectedMoveR:roundN(moveR,2),
      v6PaperMarginUSDT:margin,
      v6PaperEligible:paperEligible,
      v6DirectionAlignedRiskPlan:alignedBase,
      v6Momentum:roundN(momentum,3),
      v6Flow:roundN(flow,3),
      v6VolatilityExpansion:roundN(vol,3),
      v6OrderFlow:roundN(orderFlow,3),
      v6BookImbalance:roundN(book,3),
      v6OiScore:roundN(oiScore,3),
      v6OiChange5mPct:roundN(oi?.change5mPct,3),
      v6OiChange15mPct:roundN(oi?.change15mPct,3),
      v6FundingPressure:roundN(funding,3),
      v6MarketRegime:roundN(regime,3),
      v6LiquidationPressureProxy:roundN(proxy,3),
      v6TechnicalSupport:roundN(technical,3),
      v6PreRank:Number(r?.radarScore)||null,
      v6PreRankReason:r?.reason||null,
      v6BookBuyPct:r?.bookBuyPct??null,
      v6VolExpansionX:r?.volExpansionX??null,
      reasons:[
        `V6 explosion ${roundN(score,2)}/10 · early ${roundN(early,2)} · exp ${roundN(moveR,2)}R`,
        `Momentum ${roundN(momentum,2)} · flow ${roundN(flow,2)} · vol ${roundN(vol,2)} · OF ${roundN(orderFlow,2)} · OI ${roundN(oiScore,2)}`,
        ...(Array.isArray(x?.reasons)?x.reasons.slice(0,8):[])
      ]
    };
  });

  scored.sort((a,b)=>(Number(b.v6ExplosionScore)||0)-(Number(a.v6ExplosionScore)||0));
  data.all=scored;
  data.signals=scored.filter(v6SignalEligible).slice(0,V6.maxSignalsPerScan);
  data.watch=scored.filter(x=>!x.v6PaperEligible&&Number(x.v6ExplosionScore)>=5.5).slice(0,8);
  data.explosionRanking=scored.map(x=>({
    symbol:x.symbol,direction:x.direction,score:x.v6ExplosionScore,earlyness:x.v6Earlyness,
    expectedMoveR:x.v6ExpectedMoveR,oi5mPct:x.v6OiChange5mPct,oi15mPct:x.v6OiChange15mPct,
    flow:x.v6Flow,momentum:x.v6Momentum,volatility:x.v6VolatilityExpansion,
    orderFlow:x.v6OrderFlow,book:x.v6BookImbalance,fundingPressure:x.v6FundingPressure,
    liquidationPressureProxy:x.v6LiquidationPressureProxy,paperEligible:x.v6PaperEligible
  }));
  data.version="BINGX_V6_EXPLOSIVE_MOVE_ENGINE";
  data.v6={mode:"PAPER_TEST",liveOrders:false,objective:"explosive_move_30m_2h_6h",signals:data.signals.length};
  return data;
}


async function sendAiReviewWebhook(env,candidates,scannedAt){
  const url=String(env?.AI_REVIEW_WEBHOOK_URL||"").trim();
  if(!url||!Array.isArray(candidates)||!candidates.length)return false;
  const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source:"BINGX_V6_EXPLOSIVE",mode:"PAPER_TEST",scannedAt,candidates})});
  if(!res.ok)throw new Error(`AI review webhook HTTP ${res.status}`);
  return true;
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
    `${x.symbol} ${x.direction} · V6 EXPLOSIVE MOVE`,
    `Explosion ${x.v6ExplosionScore??x.score}/10 · Early ${x.v6Earlyness??"-"} · Beklenen hareket ${x.v6ExpectedMoveR??"-"}R`,
    `Momentum ${x.v6Momentum??"-"} · Akış ${x.v6Flow??"-"} · Vol genişleme ${x.v6VolatilityExpansion??"-"}`,
    `Order-flow ${x.v6OrderFlow??"-"} · Book ${x.v6BookImbalance??"-"} · OI ${x.v6OiScore??"-"} · OI 5dk ${x.v6OiChange5mPct??"-"}% · OI 15dk ${x.v6OiChange15mPct??"-"}%`,
    `Funding baskısı ${x.v6FundingPressure??"-"} · Likidasyon/squeeze proxy ${x.v6LiquidationPressureProxy??"-"} · BTC rejim ${x.v6MarketRegime??"-"}`,
    `Giriş: ${x.entry} · SL: ${x.stop??"-"} (${x.stopPct??"-"}%) · TP1: ${x.tp1??"-"} · TP2: ${x.tp2??"-"}`,
    `Teorik margin: ${x.v6PaperMarginUSDT??marginForSignal(x)??"-"} USDT · 5x isolated · PAPER/TEST ONLY`,
    `Not: V6 skoru henüz kalibre edilmiş olasılık değildir. OI/funding gerçek veri; likidasyon alanı global liquidation feed olmadığı için squeeze proxy'dir.`
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
  const fresh=trades.filter(t=>t.scannerVersion==="V6.0");
  const freshOpen=fresh.filter(t=>t.status==="OPEN");
  const freshClosed=fresh.filter(t=>t.status!=="OPEN");
  const freshWins=freshClosed.filter(t=>Number(t.realizedR)>0.0001).length;
  const freshWr=freshClosed.length?100*freshWins/freshClosed.length:0;
  const totalOpen=Number(s.open||0),totalClosed=Number(s.closed||0);
  return `V6 YENİ: <b>${freshOpen.length} açık</b> · ${freshClosed.length} kapanan · Win %${freshWr.toFixed(1)} · <span class="muted">Geçmiş kayıt: ${totalOpen} açık / ${totalClosed} kapanan</span>`;
}

function openPaperHtml(paper){
  const trades=Array.isArray(paper?.trades)?paper.trades.filter(t=>t.status==="OPEN"):[];
  if(!trades.length)return `<div class="muted">Açık paper işlem yok.</div>`;
  return trades.map(t=>{
    const usd=num(t.pnlUSDT), cls=usd>0?"good":usd<0?"bad":"muted";
    const meta=t.scannerVersion==="V6.0"?` · Explosion ${esc(t.v6ExplosionScore??t.executionScore??"-")}/10 · Early ${esc(t.v6Earlyness??"-")} · Exp ${esc(t.v6ExpectedMoveR??"-")}R`:"";
    return `<div class="paperCard"><div class="row"><b>${esc(t.symbol)} · ${esc(t.direction)} · ${esc(t.score)}/10${meta}</b><span class="${cls}">${usd==null?"fiyat bekleniyor":`${usd>=0?"+":"-"}$${Math.abs(usd).toFixed(2)}`}</span></div><div>Giriş: ${esc(t.entry)} · Güncel: ${esc(t.currentPrice??"-")}</div><div>Margin: ${esc(t.paperMarginUSDT??"-")} USDT · ${esc(t.scoreBand??"-")} · ${esc(t.leverage??5)}x</div><div>SL: ${esc(t.stop)} · TP1: ${esc(t.tp1)} ${t.tp1Hit?"✅":""} · TP2: ${esc(t.tp2)} ${t.tp2Hit?"✅":""}</div></div>`;
  }).join("");
}

function scanCards(data){
  return (data.all||[]).map(x=>{
    if(x.error)return `<div class="card"><b>${esc(x.symbol)}</b><div class="bad">${esc(x.error)}</div></div>`;
    const ok=Boolean(x.v6PaperEligible);
    const score=Number(x.v6ExplosionScore||0);
    const cls=ok?"good":score>=7?"warn":"muted";
    const status=ok?"PAPER GİR":score>=7?"ARMED":score>=5.5?"PREPARING":"WAIT";
    return `<div class="card"><div class="row"><b>${esc(x.symbol)} · ${esc(x.direction)}</b><span class="${cls}">${status} · ${esc(x.v6ExplosionScore??"-")}/10</span></div><div><b>Early ${esc(x.v6Earlyness??"-")} · Beklenen ${esc(x.v6ExpectedMoveR??"-")}R · Margin ${esc(x.v6PaperMarginUSDT??"-")} USDT</b></div><div>Momentum ${esc(x.v6Momentum??"-")} · Flow ${esc(x.v6Flow??"-")} · Vol ${esc(x.v6VolatilityExpansion??"-")} · Order-flow ${esc(x.v6OrderFlow??"-")} · Book ${esc(x.v6BookImbalance??"-")}</div><div>OI skor ${esc(x.v6OiScore??"-")} · OI 5dk ${esc(x.v6OiChange5mPct??"-")}% · OI 15dk ${esc(x.v6OiChange15mPct??"-")}% · Funding ${esc(x.v6FundingPressure??"-")} · Squeeze proxy ${esc(x.v6LiquidationPressureProxy??"-")}</div><div>BTC rejim ${esc(x.v6MarketRegime??"-")} · Teknik destek ${esc(x.v6TechnicalSupport??"-")} · Risk-plan yön uyumu ${x.v6DirectionAlignedRiskPlan?"EVET":"HAYIR"}</div><div>Giriş ${esc(x.entry??"-")} · SL ${esc(x.stop??"-")} (${esc(x.stopPct??"-")}%) · TP1 ${esc(x.tp1??"-")} · TP2 ${esc(x.tp2??"-")}</div><small>${ok?"V6 PAPER GİR: explosion + earlyness + expected move/stop birlikte yeterli.":"No-trade/izleme: ana V6 kapısı henüz tamamlanmadı."}</small></div>`;
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

function volumeRadarHtml(data){
  const d=Array.isArray(data.explosionRanking)&&data.explosionRanking.length?data.explosionRanking:(Array.isArray(data.volumeRadar)?data.volumeRadar:[]);
  if(!d.length)return `<div class="muted">V6 evren radarı ısınıyor veya bu dakikada anlamlı hareket adayı yok.</div>`;
  return d.slice(0,16).map(x=>{
    const score=x.score??x.radarScore??"-",dir=x.direction??x.directionHint??"NEUTRAL";
    return `<div class="paperCard"><b>${esc(x.symbol)} · ${esc(dir)} · Explosion ${esc(score)}/10</b><div>Early ${esc(x.earlyness??"-")} · Exp ${esc(x.expectedMoveR??"-")}R · Momentum ${esc(x.momentum??"-")} · Flow ${esc(x.flow??x.flowPaceX??"-")} · Vol ${esc(x.volatility??x.volExpansionX??"-")}</div><div>OF ${esc(x.orderFlow??"-")} · Book ${esc(x.book??x.bookBuyPct??"-")} · OI5 ${esc(x.oi5mPct??"-")}% · OI15 ${esc(x.oi15mPct??"-")}% · Funding ${esc(x.fundingPressure??"-")}</div><small>Likidasyon/squeeze ${esc(x.liquidationPressureProxy??"-")} · ${x.paperEligible?"PAPER GİR ADAYI":"radar/izleme"}</small></div>`;
  }).join("");
}

function page(data,paper,migration){
  const archived=Number(migration?.archivedTrades||0);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX V6 Explosive Move Engine</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:980px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.card,.paperWrap{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.paperWrap{background:#111419}.paperCard{padding:10px 0;border-bottom:1px solid #2a2f37}.paperCard:last-child{border-bottom:0}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.warn{color:#facc15}.bad{color:#fb7185}.muted,small{color:#a1a1aa}.notifyBtn{margin:10px 6px 4px 0;padding:10px 14px;border:0;border-radius:10px;font-weight:700}</style><div class="head"><h2>BingX Paper Bot · V6 · Explosive Move Engine</h2><div><b>PAPER/TEST ONLY</b> · gerçek emir yolu kapalı · BTC rejimi ${esc(data.btcDirection)}</div><div><b>HEDEF:</b> tüm uygun BingX perp evrenini birbirine göre sıralayıp hareket ateşlenirken LONG/SHORT yönünü ve erkenliğini yakalamak.</div><div><b>ANA MOTOR:</b> fiyat ivmesi + hacim/akış ivmesi + volatilite genişlemesi + order-flow + book imbalance + OI değişimi + funding/squeeze baskısı + BTC rejimi. Emre/Aksel/Belit artık ana kapı değil; küçük teknik destek katmanıdır.</div><div><b>ETİKETLEME:</b> radar adaylarında 30dk / 2s / 6s MFE-MAE-yönlü getiri örnekleri Durable Object içinde birikir. <b>/v6-forward-labels</b> ile görülebilir.</div><div><b>NOT:</b> global liquidation feed BingX public market API'de yok; V6 bu alanı funding + OI + momentumdan türetilen <i>liquidation/squeeze proxy</i> olarak işaretler.</div><div>5x isolated · max 5 açık PAPER · aynı yön max 3 · no-trade geçerli karar.</div><div>${paperSummaryHtml(paper)}</div><button class="notifyBtn" onclick="testNotify(this)">BİLDİRİM TESTİ</button><button class="notifyBtn" onclick="testBingx(this)">BINGX BAĞLANTI TESTİ</button><div>Geniş likit evren ${esc(data.universeCount??data.volumeRadarUniverseCount??"-")} coin · ağır analiz ${esc(data.shard)}/${esc(data.shardCount)} · bu tur ${(data.all||[]).length} · V6 PAPER GİR ${(data.signals||[]).length}</div><small>Son tarama ${esc(data.scannedAt)} · Arşiv ${archived}</small></div><div class="paperWrap"><b>V6 EXPLOSION RANKING</b>${volumeRadarHtml(data)}</div><div class="paperWrap"><b>AÇIK AUTO PAPER POZİSYONLARI</b>${openPaperHtml(paper)}</div>${scanCards(data)}<script>async function testNotify(btn){const old=btn.textContent;btn.disabled=true;btn.textContent="Gönderiliyor...";try{const r=await fetch('/notify-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('V6 test bildirimi gönderildi');}catch(e){alert('Bildirim testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}async function testBingx(btn){if(!confirm('BingX API ve TEST emir yolunu kontrol edelim mi? Gerçek pozisyon açılmaz.'))return;const old=btn.textContent;btn.disabled=true;btn.textContent='Kontrol ediliyor...';try{const r=await fetch('/bingx-connection-test',{method:'POST'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'hata');alert('BINGX TEST BAŞARILI — gerçek pozisyon açılmadı.');}catch(e){alert('BingX testi başarısız: '+e.message);}finally{btn.disabled=false;btn.textContent=old;}}</script>`;
}

class PaperTracker extends BasePaperTracker {
  async ensureV219Migration(){
    const marker=await this.state.storage.get("v219_migrated");
    if(marker)return marker;
    const oldTrades=(await this.state.storage.get("trades"))||[];
    const archivedAt=new Date().toISOString();
    const archive={version:"V2.x",archivedAt,trades:oldTrades};
    await this.state.storage.put("archive_v218",archive);
    await this.state.storage.put("trades",[]);
    const m={version:"V6.0-core-migration",archivedAt,archivedTrades:oldTrades.length};
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
    const sorted=(Array.isArray(signals)?signals:[]).filter(v6SignalEligible).sort((a,b)=>(Number(b.v6ExplosionScore)||0)-(Number(a.v6ExplosionScore)||0)||(Number(b.v6ExpectedMoveR)||0)-(Number(a.v6ExpectedMoveR)||0));
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
      t.scannerVersion="V6.0";
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
      t.paperEntryType=s.paperEntryType||"CONFIRMED";
      t.v32RadarScore=s.v32RadarScore??null;
      t.v32FlowPaceX=s.v32FlowPaceX??null;
      t.v32FlowAccelX=s.v32FlowAccelX??null;
      t.v6ExplosionScore=s.v6ExplosionScore??null;
      t.v6Earlyness=s.v6Earlyness??null;
      t.v6ExpectedMoveR=s.v6ExpectedMoveR??null;
      t.v6OiChange5mPct=s.v6OiChange5mPct??null;
      t.v6OiChange15mPct=s.v6OiChange15mPct??null;
      t.v6LiquidationPressureProxy=s.v6LiquidationPressureProxy??null;
      if(Number(s.v6PaperMarginUSDT)>0)t.paperMarginUSDT=Number(s.v6PaperMarginUSDT);
      else if(t.paperEntryType==="EARLY_STARTER")t.paperMarginUSDT=4;
    }
    return added;
  }

  async updateV6ForwardLabels(rows,leaders,ts){
    let samples=(await this.state.storage.get("v6_forward_labels"))||[];
    if(!Array.isArray(samples))samples=[];
    const priceMap=new Map((Array.isArray(rows)?rows:[]).filter(x=>x?.symbol&&Number(x?.lastPrice)>0).map(x=>[String(x.symbol),Number(x.lastPrice)]));
    const pct=(entry,current,direction)=>direction==="LONG"?((current-entry)/entry)*100:((entry-current)/entry)*100;

    for(const s of samples){
      if(s?.done)continue;
      const current=priceMap.get(String(s.symbol));
      if(!(current>0)||!(Number(s.entryPrice)>0))continue;
      const signed=pct(Number(s.entryPrice),current,s.direction);
      s.mfePct=Math.max(Number(s.mfePct||0),signed);
      s.maePct=Math.min(Number(s.maePct||0),signed);
      s.lastPrice=current;s.lastAt=new Date(ts).toISOString();
      const ageMin=(ts-Date.parse(s.startAt))/60000;
      s.horizons=s.horizons||{};
      for(const h of V6.horizonsMin){
        if(ageMin>=h&&!s.horizons[String(h)]){
          s.horizons[String(h)]={
            returnPct:roundN(signed,3),
            mfePct:roundN(s.mfePct,3),
            maePct:roundN(s.maePct,3),
            maxAbsPct:roundN(Math.max(Math.abs(Number(s.mfePct||0)),Math.abs(Number(s.maePct||0))),3),
            completedAt:new Date(ts).toISOString()
          };
        }
      }
      if(ageMin>=Math.max(...V6.horizonsMin))s.done=true;
    }

    const bucket=Math.floor(ts/(V6.forwardLabelBucketMin*60*1000));
    const top=(Array.isArray(leaders)?leaders:[])
      .filter(x=>["LONG","SHORT"].includes(x?.directionHint)&&Number(x?.radarScore)>=V6.forwardLabelMinScore)
      .slice(0,V6.forwardLabelTopN);
    const ids=new Set(samples.map(x=>x.id));
    for(const x of top){
      const id=`${x.symbol}:${x.directionHint}:${bucket}`;
      if(ids.has(id))continue;
      const entry=priceMap.get(String(x.symbol));
      if(!(entry>0))continue;
      samples.push({
        id,symbol:String(x.symbol),direction:x.directionHint,startAt:new Date(ts).toISOString(),
        entryPrice:entry,preRankScore:Number(x.radarScore),flowPaceX:x.flowPaceX,flowAccelX:x.flowAccelX,
        volExpansionX:x.volExpansionX,bookBuyPct:x.bookBuyPct,mfePct:0,maePct:0,horizons:{},done:false
      });
      ids.add(id);
    }
    samples=samples.sort((a,b)=>Date.parse(b.startAt)-Date.parse(a.startAt)).slice(0,600);
    await this.state.storage.put("v6_forward_labels",samples);
    return samples;
  }

  async getV6ForwardLabels(){
    const samples=(await this.state.storage.get("v6_forward_labels"))||[];
    const arr=Array.isArray(samples)?samples:[];
    const completed={30:0,120:0,360:0};
    for(const s of arr)for(const h of Object.keys(completed))if(s?.horizons?.[h])completed[h]++;
    return {ok:true,count:arr.length,completed,samples:arr.slice(0,200)};
  }

  async updateV6OiState(rows,scannedAt){
    const ts=Date.parse(scannedAt)||Date.now();
    let state=(await this.state.storage.get("v6_oi_state"))||{};
    const metrics={};
    const change=(a,b)=>Number(a)>0&&Number.isFinite(Number(b))?100*(Number(b)-Number(a))/Number(a):null;
    for(const r of (Array.isArray(rows)?rows:[])){
      const sym=String(r?.symbol||""),oi=Number(r?.openInterest);
      if(!sym||!(oi>=0))continue;
      const hist=Array.isArray(state[sym]?.history)?state[sym].history:[];
      hist.push({ts,oi});
      const fresh=hist.filter(x=>ts-Number(x.ts)<=25*60*1000).slice(-30);
      const pick=(mins)=>{
        const target=ts-mins*60*1000;
        const older=[...fresh].filter(x=>Number(x.ts)<=target).sort((a,b)=>Math.abs(Number(a.ts)-target)-Math.abs(Number(b.ts)-target))[0];
        return older||fresh[0]||null;
      };
      const p5=pick(5),p15=pick(15);
      const m={openInterest:oi,change5mPct:p5?change(p5.oi,oi):null,change15mPct:p15?change(p15.oi,oi):null,updatedAt:ts};
      state[sym]={history:fresh,...m};metrics[sym]=m;
    }
    for(const [sym,v] of Object.entries(state)){
      if(ts-Number(v?.updatedAt||0)>60*60*1000)delete state[sym];
      else if(!metrics[sym])metrics[sym]={openInterest:v.openInterest,change5mPct:v.change5mPct,change15mPct:v.change15mPct,updatedAt:v.updatedAt};
    }
    await this.state.storage.put("v6_oi_state",state);
    return metrics;
  }

  async notifyClosed(closedNow){
    const feeBps=Math.max(0,Number(this.env?.PAPER_TAKER_FEE_BPS??V6.defaultFeeBps));
    const slippageBps=Math.max(0,Number(this.env?.PAPER_SLIPPAGE_BPS??V6.defaultSlippageBps));
    for(const t of closedNow){
      if(t?.scannerVersion!=="V6.0"){
        await BasePaperTracker.prototype.notifyClosed.call(this,[t]);
        continue;
      }
      const grossR=Number(t.realizedR||0);
      const stopPct=Math.max(0.0001,Math.abs(Number(t.stopPct||0)));
      const roundTripCostPct=2*(feeBps+slippageBps)/100;
      const costR=roundTripCostPct/stopPct;
      const netR=grossR-costR;
      const grossMarginPct=grossR*stopPct*Number(t.leverage||5);
      const netMarginPct=netR*stopPct*Number(t.leverage||5);
      const margin=tradePaperMargin(t);
      const resultLabel=
        t.status==="CLOSED_SL"?"SL":
        t.status==="CLOSED_BE"?"TP1 + BE":
        t.status==="CLOSED_RUNNER"?(t.tp2Hit?"TP1 + TP2 + RUNNER":"RUNNER"):
        t.status;
      t.v6EstimatedCostR=roundN(costR,3);
      t.v6EstimatedNetR=roundN(netR,3);
      const msg=[
        `${t.symbol} ${t.direction} · V6 ${t.v6ExplosionScore??t.score}/10`,
        `Sonuç: ${resultLabel}`,
        `Brüt analiz: ${grossR>=0?"+":""}${grossR.toFixed(2)}R · Maliyet sonrası tahmini: ${netR>=0?"+":""}${netR.toFixed(2)}R`,
        `Yaklaşık net: ${netMarginPct>=0?"+":"-"}$${Math.abs(margin*netMarginPct/100).toFixed(2)} · margin ${margin} USDT · ${t.leverage||5}x`,
        `Brüt margin: ${grossMarginPct>=0?"+":""}%${Math.abs(grossMarginPct).toFixed(2)} · maliyet varsayımı: fee ${feeBps}bps/yan + slip ${slippageBps}bps/yan`,
        `TP1: ${t.tp1Hit?"✅":"—"} · TP2: ${t.tp2Hit?"✅":"—"} · Süre: ${t.holdMinutes??"-"} dk`,
        `PAPER/TEST. Funding maliyeti bu tahmine dahil değildir.`
      ].join("\n");
      await sendPrimary(this.env,"V6 PAPER SONUÇ",msg).catch(()=>{});
      await sleep(500);
    }
  }

  async fetch(request){
    const migration=await this.ensureV219Migration();
    const url=new URL(request.url);
    if(url.pathname==="/v6-forward-labels")return Response.json(await this.getV6ForwardLabels());
    if(url.pathname==="/v6-oi-state"){
      if(request.method!=="POST"){
        const state=(await this.state.storage.get("v6_oi_state"))||{};
        return Response.json({ok:true,state});
      }
      const body=await request.json().catch(()=>({}));
      const metrics=await this.updateV6OiState(body?.rows,body?.scannedAt);
      return Response.json({ok:true,metrics});
    }
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
        if(!v6SignalEligible(s))continue;
        const key=`${s.symbol}:${s.direction}:${s.publicStatus||s.belitStage||"CLASSIC"}`;
        if(now-Number(history[key]||0)<V219.alertCooldownMs)continue;
        history[key]=now;allowed.push(s);
      }
      for(const [k,t] of Object.entries(history))if(now-Number(t)>24*60*60*1000)delete history[k];
      await this.state.storage.put("v219_alerts",history);
      return Response.json({ok:true,signals:allowed});
    }
    if(url.pathname==="/v32-volume-radar"){
      const now=Date.now();
      let market=(await this.state.storage.get("v32_market_state"))||{};
      let leaderState=(await this.state.storage.get("v32_volume_leaders"))||{updatedAt:0,leaders:[],universeCount:0,warmed:false};
      if(request.method==="POST"){
        const body=await request.json().catch(()=>({}));
        const ts=Date.parse(body?.scannedAt)||now;
        const rows=Array.isArray(body?.rows)?body.rows:[];
        const seen=new Set(),leaders=[];
        const pct=(a,b)=>Number.isFinite(a)&&a>0&&Number.isFinite(b)?((b-a)/a)*100:null;
        for(const r of rows){
          const sym=String(r?.symbol||""); const last=Number(r?.lastPrice),qv=Number(r?.quoteVolume),spread=Number(r?.spreadPct);
          if(!sym||!(last>0)||!(qv>=V32_RADAR.minQuoteVolumeUSDT)||(Number.isFinite(spread)&&spread>V32_RADAR.maxSpreadPct))continue;
          seen.add(sym);
          const prev=market[sym]||null;
          const dtMin=prev?Math.max(0.5,Math.min(5,(ts-Number(prev.updatedAt||ts-60000))/60000)):1;
          const raw1=prev?pct(Number(prev.lastPrice),last):null;
          const p1=raw1==null?null:raw1/dtMin;
          const absRet=Math.abs(Number(p1)||0);
          const prevAbsEma=Number(prev?.absRetEma);
          const absRetEma=prev
            ? (Number.isFinite(prevAbsEma)?0.88*prevAbsEma+0.12*absRet:absRet)
            : Math.max(0.03,absRet);
          const volExpansionX=prev&&absRetEma>0?absRet/Math.max(0.02,Number(prevAbsEma)||absRetEma):null;
          const bookBuyPct=Number(r?.bookBuyPct);
          const prevEma5=Number(prev?.ema5)||last,prevEma15=Number(prev?.ema15)||last;
          const alpha5=2/(5+1),alpha15=2/(15+1);
          const ema5=prev?alpha5*last+(1-alpha5)*prevEma5:last;
          const ema15=prev?alpha15*last+(1-alpha15)*prevEma15:last;
          const p5=prev?pct(prevEma5,last):null,p15=prev?pct(prevEma15,last):null;
          const rawDelta=prev?qv-Number(prev.quoteVolume||0):0;
          const flowUsd=Math.max(0,rawDelta);
          const expectedFlow=Math.max(1,(qv/1440)*dtMin);
          const baseline=Math.max(1,Number(prev?.flowEma)||expectedFlow);
          const paceX=flowUsd/expectedFlow,accelX=flowUsd/baseline;
          const nextEma=prev?0.85*baseline+0.15*flowUsd:expectedFlow;
          let score=0;
          if(paceX>=5)score+=3; else if(paceX>=3)score+=2.5; else if(paceX>=2)score+=2; else if(paceX>=1.3)score+=1;
          if(accelX>=4)score+=2; else if(accelX>=2.5)score+=1.5; else if(accelX>=1.6)score+=1;
          if(flowUsd>=100_000)score+=1.25; else if(flowUsd>=50_000)score+=1; else if(flowUsd>=20_000)score+=0.75; else if(flowUsd>=10_000)score+=0.5;
          const a1=Math.abs(Number(p1)||0),a5=Math.abs(Number(p5)||0);
          if(a1>=0.35)score+=1.5; else if(a1>=0.20)score+=1; else if(a1>=0.10)score+=0.5;
          if(a5>=0.80)score+=1.5; else if(a5>=0.45)score+=1; else if(a5>=0.25)score+=0.5;
          if(qv>=20_000_000)score+=0.5; else if(qv>=5_000_000)score+=0.25;
          if(Number.isFinite(spread)&&spread<=0.12)score+=0.25;
          // V6: volatility expansion and top-of-book imbalance enter the universe-wide pre-rank.
          if(Number.isFinite(volExpansionX)){
            if(volExpansionX>=3)score+=1.25; else if(volExpansionX>=2)score+=0.9; else if(volExpansionX>=1.4)score+=0.5;
          }
          if(Number.isFinite(bookBuyPct)){
            const bookSkew=Math.abs(bookBuyPct-50);
            if(bookSkew>=18)score+=0.75; else if(bookSkew>=12)score+=0.5; else if(bookSkew>=7)score+=0.25;
          }
          const prevHot=Number(prev?.hotCount||0);
          const flowCondition=flowUsd>=V32_RADAR.minFlowUsd&&(paceX>=1.5||accelX>=1.75);
          const movementCondition=a1>=0.30||a5>=0.70;
          const candidate=Boolean(prev)&&score>=V32_RADAR.minCandidateScore&&(flowCondition||movementCondition);
          const hotCount=candidate?Math.min(9,prevHot+1):Math.max(0,prevHot-1);
          if(hotCount>=2)score+=0.25;
          score=Math.max(0,Math.min(10,Math.round(score*4)/4));
          let directionHint="NEUTRAL";
          if((Number(p5)||0)>=0.25||(Number(p1)||0)>=0.12)directionHint="LONG";
          else if((Number(p5)||0)<=-0.25||(Number(p1)||0)<=-0.12)directionHint="SHORT";
          const parts=[];
          if(paceX>=1.5)parts.push(`akış temposu ${paceX.toFixed(2)}x`);
          if(accelX>=1.75)parts.push(`kendi bazına göre ${accelX.toFixed(2)}x`);
          if(a1>=0.10)parts.push(`1dk ${p1>=0?"+":""}${p1.toFixed(2)}%`);
          if(a5>=0.25)parts.push(`kısa EMA sapması ${p5>=0?"+":""}${p5.toFixed(2)}%`);
          if(Number.isFinite(volExpansionX)&&volExpansionX>=1.4)parts.push(`vol genişleme ${volExpansionX.toFixed(2)}x`);
          if(Number.isFinite(bookBuyPct)&&Math.abs(bookBuyPct-50)>=7)parts.push(`book ${bookBuyPct.toFixed(1)}% alış`);
          // V6 ranks the whole eligible universe first; only the highest ranks are retained for heavy analysis.
          leaders.push({symbol:sym,radarScore:score,directionHint,candidate,flowUsd:Math.round(flowUsd),flowPaceX:+paceX.toFixed(2),flowAccelX:+accelX.toFixed(2),price1mPct:p1==null?null:+p1.toFixed(2),price5mPct:p5==null?null:+p5.toFixed(2),price15mPct:p15==null?null:+p15.toFixed(2),volExpansionX:Number.isFinite(volExpansionX)?+volExpansionX.toFixed(2):null,bookBuyPct:Number.isFinite(bookBuyPct)?+bookBuyPct.toFixed(2):null,quoteVolume24h:Math.round(qv),spreadPct:Number.isFinite(spread)?+spread.toFixed(3):null,hotCount,reason:parts.join(" · ")||"evren sıralama adayı",updatedAt:ts});
          market[sym]={lastPrice:last,quoteVolume:qv,flowEma:nextEma,hotCount,ema5,ema15,absRetEma,bookBuyPct:Number.isFinite(bookBuyPct)?bookBuyPct:null,updatedAt:ts};
        }
        for(const [sym,v] of Object.entries(market))if(!seen.has(sym)&&ts-Number(v?.updatedAt||0)>60*60*1000)delete market[sym];
        leaders.sort((a,b)=>(Number(b.radarScore)||0)-(Number(a.radarScore)||0)||(Number(b.flowAccelX)||0)-(Number(a.flowAccelX)||0)||(Number(b.flowUsd)||0)-(Number(a.flowUsd)||0));
        await this.updateV6ForwardLabels(rows,leaders,ts);
        leaderState={updatedAt:ts,leaders:leaders.slice(0,V32_RADAR.maxLeaders),universeCount:rows.length,warmed:Boolean(Object.keys(market).length)};
        await this.state.storage.put("v32_market_state",market);
        await this.state.storage.put("v32_volume_leaders",leaderState);
      }
      const fresh=now-Number(leaderState?.updatedAt||0)<=V32_RADAR.leaderTtlMs;
      return Response.json({ok:true,leaders:fresh?(leaderState.leaders||[]):[],universeCount:Number(leaderState?.universeCount||0),warmed:Boolean(leaderState?.warmed),updatedAt:leaderState?.updatedAt||null});
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

const __main_default = {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/notify-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ · V6","Bildirim kanalı çalışıyor. V6 Explosive Move Engine aktiftir. Telegram yalnız gerçek V6 PAPER GİR ve PAPER SONUÇ mesajlarını gönderir; ham patlama adayları panelde kalır. EXECUTION_MODE zorla TEST kilitlidir; gerçek emir açılamaz.");return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/json"){
      try{
        const [watchFocus,discoveryFocus,radarState]=await Promise.all([getFastWatch(env),getDiscoveryFocus(env),getVolumeRadar(env)]);
        const radar=Array.isArray(radarState?.leaders)?radarState.leaders:[];
        const focus=mergeFocus(radar,watchFocus,discoveryFocus);
        const data=await scanThroughBase(env,focus.map(x=>x?.symbol).filter(Boolean),radar);
        data.volumeRadarUniverseCount=radarState?.universeCount??null;
        return Response.json(data,{headers:{"cache-control":"no-store"}});
      }catch(e){const info=errInfo("JSON_SCAN",e);return Response.json({ok:false,error:info.message,stage:info.stage,stack:info.stack},{status:500,headers:{"cache-control":"no-store"}});}
    }
    if(url.pathname==="/paper-stats"){
      try{return Response.json(await paperSnapshot(env),{headers:{"cache-control":"no-store"}});}catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500});}
    }
    if(url.pathname==="/v6-forward-labels")return trackerStub(env).fetch("https://paper.local/v6-forward-labels");
    if(url.pathname==="/v219-migration"||url.pathname==="/v219-archive")return trackerStub(env).fetch(`https://paper.local${url.pathname}`);

    if(url.pathname==="/"||url.pathname===""){
      let focus=[],data=null,paper=null,migration={},scanError=null,paperError=null;
      let radar=[];
      try{const [watchFocus,discoveryFocus,radarState]=await Promise.all([getFastWatch(env),getDiscoveryFocus(env),getVolumeRadar(env)]);radar=Array.isArray(radarState?.leaders)?radarState.leaders:[];focus=mergeFocus(radar,watchFocus,discoveryFocus);}catch(e){errInfo("FAST_FOCUS",e);focus=[];radar=[];}
      try{data=await scanThroughBase(env,(Array.isArray(focus)?focus:[]).map(x=>x?.symbol).filter(Boolean),radar);}
      catch(e){scanError=errInfo("SCAN",e);}
      try{paper=await paperSnapshot(env);}catch(e){paperError=errInfo("PAPER_STATS",e);paper=emptyPaper(String(e?.message||e));}
      try{const migRes=await trackerStub(env).fetch("https://paper.local/v219-migration");migration=migRes.ok?await migRes.json():{};}catch(e){errInfo("MIGRATION",e);migration={};}
      if(!data){
        const detail=scanError?.stack?`<div style="margin-top:12px;color:#666;font-size:13px">Aşama: ${esc(scanError.stage)} · ${esc(scanError.stack)}</div>`:"";
        return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px"><h2>BingX Paper Bot · V6</h2><p><b>Tarama geçici olarak durdu.</b> PAPER/TEST kilidi aktif; gerçek emir açılamaz.</p><p>Hata aşaması: <b>${esc(scanError?.stage||"SCAN")}</b><br>${esc(scanError?.message||"bilinmeyen hata")}</p>${detail}<p>Paper istatistik katmanı: ${paperError?"hata":"çalışıyor"}</p></body>`,{status:500,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      }
      return new Response(page(data,paper||emptyPaper(),migration),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }

    // Trade, signal landing, BingX connection test and other established routes stay on V2.17's proven execution bridge.
    return baseWorker.fetch(request,paperEnv(env));
  },

  async scheduled(controller,env,ctx){
    const [watchFocus,discoveryFocus,radarState]=await Promise.all([getFastWatch(env).catch(()=>[]),getDiscoveryFocus(env).catch(()=>[]),prepareRadar(env).catch(e=>{errInfo("CRON_RADAR",e);return {leaders:[],universeCount:0};})]);
    const radar=Array.isArray(radarState?.leaders)?radarState.leaders:[];
    const focus=mergeFocus(radar,watchFocus,discoveryFocus);
    let data;
    try{data=await scanThroughBase(env,focus.map(x=>x?.symbol).filter(Boolean),radar);data.volumeRadarUniverseCount=radarState?.universeCount??null;}
    catch(e){errInfo("CRON_SCAN",e);return;}
    const paper=await paperTick(env,data).catch(e=>{errInfo("CRON_PAPER",e);return {stats:null};});
    const [fastWatch,fastDiscovery]=await Promise.all([updateFastWatch(env,data),updateDiscoveryFocus(env,data)]);
    // V6: Telegram only gets actual PAPER entries/results. PREPARING/ARMED candidates remain on the dashboard.
    const alerts=await claimAlerts(env,data.signals||[],data.scannedAt);
    const aiReview=(data.signals||[]).filter(x=>Number(x?.v6ExplosionScore)>=8.0);
    if(aiReview.length)ctx.waitUntil(sendAiReviewWebhook(env,aiReview,data.scannedAt).catch(e=>console.error("AI_REVIEW_WEBHOOK",String(e?.message||e))));
    console.log(JSON.stringify({cron:controller.cron,version:"V6.0",scannedAt:data.scannedAt,radarUniverse:radarState?.universeCount||0,radar:radar.map(x=>x.symbol),shard:data.shard,scanned:data.all?.length||0,qualified:data.signals?.length||0,earlyStarters:(data.signals||[]).filter(x=>x.paperEntryType==="EARLY_STARTER").length,watch:data.watch?.length||0,discovery:data.discovery?.length||0,fastWatch:(fastWatch?.watch||watchFocus).map(x=>x.symbol),fastDiscovery:(fastDiscovery?.discovery||discoveryFocus).map(x=>x.symbol),alerts:alerts.length,paper:paper?.stats||null}));
    if(alerts.length){
      ctx.waitUntil((async()=>{
        for(const x of alerts){
          try{await sendPrimary(env,`V6 PAPER GİR · ${x.symbol} ${x.direction} · ${x.v6ExplosionScore??x.score}/10`,signalMessage(x));}catch(e){console.error("ALERT_ERROR",String(e?.message||e));}
          if(alerts.length>1)await sleep(1200);
        }
      })());
    }
  }
};


export { PaperTracker };
export default __main_default;
