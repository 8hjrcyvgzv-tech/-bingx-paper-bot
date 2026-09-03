import { enrichBelitData, stageLabel as belitStageLabel, publicStatusLabel } from "./belit_daily_v300.js";

export { publicStatusLabel };
export function stageLabel(stage){ return belitStageLabel(stage); }

const CORE5=new Set(["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","DOGE-USDT"]);
const CFG={minHybridSetup:7.5,minExecution:7.5,minEmre:6,minAksel:6.5,minBelit:6.25,maxSignals:2,maxWatch:5};
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round2=v=>Number.isFinite(v)?Math.round(v*100)/100:null;
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

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
  const rows=(x?.recent4hBars||[]).slice(-54); const dir=x?.direction;
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
  const dir=x?.direction; if(!["LONG","SHORT"].includes(dir))return {score:0,invalid:true,label:"YÖN YOK",fib:impulseFib(x)};
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
  const dir=x?.direction,rows=(x?.recent4hBars||[]).slice(-40); if(rows.length<28||!["LONG","SHORT"].includes(dir))return {candidate:false,armed:false,confirmed:false,retest:false,extended:false};
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
  const a15=num(x?.atr15),last=num(x?.lastPrice)||px,mark=num(x?.markPrice),bars=(x?.recent15mBars||[]).slice(-8);
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
  const setup=flag?0.30*emre.score+0.40*aksel.score+0.30*belit.score:0.25*emre.score+0.35*aksel.score+0.40*belit.score;
  const status=mergeStatus(x,aksel,setup);
  const realTrigger=["TRIGGERED","RETEST"].includes(status);
  let exec=realTrigger?(flag?0.30*emre.score+0.40*aksel.score+0.30*belit.score:0.25*emre.score+0.35*aksel.score+0.40*belit.score):null;
  if(exec!=null&&num(x?.volumeRatio)>=1.2)exec+=0.25;
  if(exec!=null&&x?.entryStillValid===false)exec=Math.min(exec,5.5);
  if(exec!=null&&(x?.belitExtended||aksel.flag.extended))exec=Math.min(exec,5.5);
  exec=exec==null?null:round2(clamp(exec,0,10));
  const fundingOk=num(x?.fundingRate)==null||Math.abs(Number(x.fundingRate))<0.003;
  const qualifies=realTrigger&&!emre.invalid&&emre.score>=CFG.minEmre&&aksel.score>=CFG.minAksel&&belit.score>=CFG.minBelit&&exec>=CFG.minExecution&&x?.entryStillValid!==false&&fundingOk&&Boolean(x?.riskOk)&&Boolean(x?.rangeOk)&&!Boolean(x?.belitExtended)&&!Boolean(aksel.flag.extended);
  const watch=!qualifies&&["PREPARING","ARMED"].includes(status)&&setup>=CFG.minHybridSetup&&!emre.invalid&&emre.score>=5.5&&aksel.score>=6&&belit.score>=5.75;
  return {...x,
    emreScore:emre.score,emreFibRetracement:emre.fib.retracement,emreFibLabel:emre.fib.label,emreImpulsePct:emre.fib.impulsePct,emreInvalid:emre.invalid,
    akselScore:aksel.score,patternType:aksel.pattern,flagBoundary:aksel.flag.boundary??null,flagDistanceATR:aksel.flag.distATR??null,flagCandidate:Boolean(aksel.flag.candidate),flagConfirmed:Boolean(aksel.flag.confirmed),flagRetest:Boolean(aksel.flag.retest),
    belitScore:belit.score,belitSetupQuality:x?.setupQuality??null,belitExecutionScore:x?.executionScore??null,
    hybridSetupScore:round2(setup),hybridExecutionScore:exec,setupQuality:round2(setup),executionScore:exec,entryQuality:exec??round2(setup),triggerReadiness:exec??round2(setup),
    publicStatus:status,hybridQualifies:qualifies,v300Qualifies:qualifies,qualifies,belitWatchCandidate:watch,hybridWatchCandidate:watch,
    hybridReasons:[...emre.reasons.slice(0,2),...aksel.reasons.slice(0,2),`Belit ${belit.score}/10`]
  };
}
export function isV300Signal(x){ return Boolean(x?.v300Qualifies)&&Number(x?.hybridExecutionScore??x?.executionScore)>=CFG.minExecution; }
export async function enrichHybridData(raw){
  const b=await enrichBelitData(raw); const all=(b.all||[]).map(hybridOne);
  const signals=all.filter(isV300Signal).sort((a,b)=>(Number(b.hybridExecutionScore)||0)-(Number(a.hybridExecutionScore)||0)||(Number(b.hybridSetupScore)||0)-(Number(a.hybridSetupScore)||0)).slice(0,CFG.maxSignals);
  const ss=new Set(signals.map(x=>x.symbol));
  const watch=all.filter(x=>x.hybridWatchCandidate&&!ss.has(x.symbol)).sort((a,b)=>(b.publicStatus==="ARMED")-(a.publicStatus==="ARMED")||(Number(b.hybridSetupScore)||0)-(Number(a.hybridSetupScore)||0)).slice(0,CFG.maxWatch);
  return {...b,version:"TOP100_V3_0_HYBRID",signals,watch,all};
}
