export const V221_BELIT = {
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
  // Discovery'de hacim şart değildir; yalnız çok güçlü hazırlık hafif bonus alır.
  if(num(x?.volumeRatio)>=1.2)score+=0.25;
  score=clamp(Math.round(score*4)/4,0,10);
  return {direction,score,boundary:boundary.level,boundaryTests:boundary.tests,distPct,compression:Boolean(comp.ok),squeeze,staircase,sma:smas.label,smaScore:smas.score,spanDays:round2(spanDays)};
}
export function analyzeDiscovery(rows,x){
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

export function stageLabel(stage){
  return ({PRE_BREAKOUT:"HAZIRLANIYOR",BREAKOUT_CONFIRMED:"BREAKOUT TEYİTLİ",INTRADAY_BREAKOUT_CONFIRMED:"15DK BREAKOUT TEYİTLİ",INTRADAY_RETEST:"15DK RETEST",RETEST:"RETEST",CONTINUATION_PREP:"CONTINUATION HAZIRLIK",CONTINUATION_BREAKOUT:"CONTINUATION BREAKOUT",EXTENDED:"KAÇMIŞ",NONE:"KLASİK"})[stage]||stage;
}

export function publicStatusLabel(status){
  return ({PREPARING:"HAZIRLANIYOR",ARMED:"ARMED",TRIGGERED:"TETİKLENDİ",RETEST:"RETEST",MISSED:"KAÇTI / KOVALAMA",WAIT:"BEKLE/PAS"})[status]||status||"BEKLE/PAS";
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

export function fastIntradayTrigger(level,direction,x){
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

export function analyzeBelitDaily(rows,x){
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

export function isV223Signal(x){
  const stage=String(x?.belitStage||"");
  const realTrigger=["BREAKOUT_CONFIRMED","INTRADAY_BREAKOUT_CONFIRMED","INTRADAY_RETEST","RETEST","CONTINUATION_BREAKOUT"].includes(stage);
  return Boolean(x?.v219Qualifies)&&realTrigger&&!Boolean(x?.belitExtended)&&Boolean(x?.entryStillValid!==false)&&num(x?.executionScore)!=null&&Number(x.executionScore)>=V221_BELIT.minExecutionQuality;
}

export const isV221Signal=isV223Signal;
export const isV220Signal=isV223Signal;

export async function enrichBelitData(raw){
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
  return {...raw,version:"BINGX_WIDE_V3_1_DISCOVERY",signals,watch,discovery,all};
}
