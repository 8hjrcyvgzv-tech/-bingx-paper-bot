import baseWorker from "./worker_top100_v27_ntfy_retry.js";

const BASE_URL = "https://bingx-paper-bot.yasinaltas39.workers.dev";

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }


async function telegramLatestChat(env){
  const token=String(env?.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token)throw new Error("TELEGRAM_BOT_TOKEN eksik");
  const res=await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  if(!res.ok)throw new Error(`Telegram getUpdates HTTP ${res.status}`);
  const json=await res.json();
  const updates=Array.isArray(json?.result)?json.result:[];
  for(let i=updates.length-1;i>=0;i--){
    const chat=updates[i]?.message?.chat||updates[i]?.edited_message?.chat||updates[i]?.callback_query?.message?.chat;
    if(chat?.id!=null)return {id:String(chat.id),type:chat.type,first_name:chat.first_name||"",username:chat.username||""};
  }
  throw new Error("Henüz Telegram mesajı bulunamadı. Bota /start gönderip tekrar dene.");
}

async function telegramSend(env,title,message){
  const token=String(env?.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token)return false;

  let chatId=String(env?.TELEGRAM_CHAT_ID||"").trim();
  if(!chatId){
    const chat=await telegramLatestChat(env);
    chatId=String(chat.id);
    console.log("TELEGRAM_CHAT_AUTO",chatId);
  }

  const res=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      chat_id:chatId,
      text:`📈 ${title}\n\n${message}`,
      disable_web_page_preview:true,
      reply_markup:{inline_keyboard:[[{text:"Bot sitesini aç",url:BASE_URL}]]}
    })
  });
  if(!res.ok){
    let detail="";
    try{detail=(await res.text()).slice(0,180);}catch(_){}
    throw new Error(`Telegram HTTP ${res.status}${detail?` · ${detail}`:""}`);
  }
  return true;
}

async function ntfyFallback(env,title,message){
  const topic=String(env?.NTFY_TOPIC||"").trim();
  if(!topic)return false;
  let last=0;
  for(let attempt=0;attempt<4;attempt++){
    const res=await fetch("https://ntfy.sh",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        topic,
        title,
        message,
        priority:4,
        tags:["chart_with_upwards_trend"]
      })
    });
    if(res.ok)return true;
    last=res.status;
    if(res.status!==429&&res.status<500)break;
    if(attempt<3)await sleep(6000*(2**attempt));
  }
  throw new Error(`ntfy HTTP ${last}`);
}

async function sendPrimary(env,title,message){
  try{
    if(await telegramSend(env,title,message)){
      console.log("TELEGRAM_SENT",title);
      return "telegram";
    }
  }catch(e){
    console.error("TELEGRAM_ERROR",String(e?.message||e));
  }

  try{
    if(await ntfyFallback(env,title,message))return "ntfy";
  }catch(e){
    console.error("NTFY_ERROR",String(e?.message||e));
  }
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
    `Hacim: ${x.volumeRatio??"-"}x | Alış: ${x.buyPressurePct??"-"}% | Satış: ${x.sellPressurePct??"-"}%`,
    `${(x.reasons||[]).join(" · ")}`
  ].join("\n");
}

async function scanThroughBase(env){
  const res=await baseWorker.fetch(new Request(`${BASE_URL}/json`),env);
  if(!res.ok)throw new Error(`Tarama HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  return await res.json();
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);


    if(url.pathname==="/telegram-chat-id"){
      try{
        const chat=await telegramLatestChat(env);
        return Response.json({ok:true,chat_id:chat.id,type:chat.type,first_name:chat.first_name,username:chat.username},{headers:{"cache-control":"no-store"}});
      }catch(e){
        return Response.json({ok:false,error:String(e?.message||e)},{status:400,headers:{"cache-control":"no-store"}});
      }
    }

    if(url.pathname==="/notify-test"){
      if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
      try{
        const channel=await sendPrimary(env,"BingX BİLDİRİM TESTİ","Bildirim kanalı çalışıyor. 7/10+ sinyaller otomatik gönderilecek.");
        return Response.json({ok:true,channel},{headers:{"cache-control":"no-store"}});
      }catch(e){
        return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{"cache-control":"no-store"}});
      }
    }

    const res=await baseWorker.fetch(request,env);
    const ct=res.headers.get("content-type")||"";

    if(url.pathname==="/json"&&ct.includes("application/json")){
      const data=await res.json();
      data.version="TOP100_V2_8";
      return Response.json(data,{status:res.status,headers:{"cache-control":"no-store"}});
    }

    if(ct.includes("text/html")){
      const html=(await res.text()).replaceAll("V2.7","V2.9");
      return new Response(html,{status:res.status,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }

    return res;
  },

  async scheduled(controller,env,ctx){
    const data=await scanThroughBase(env);
    console.log(JSON.stringify({
      cron:controller.cron,
      scannedAt:data.scannedAt,
      shard:data.shard,
      shardCount:data.shardCount,
      scanned:data.all?.length||0,
      version:"V2.9",
      signals:(data.signals||[]).map(x=>({symbol:x.symbol,direction:x.direction,score:x.score}))
    }));

    if(data.signals?.length){
      ctx.waitUntil((async()=>{
        for(const x of data.signals){
          try{
            await sendPrimary(env,`BingX ${x.direction} ${x.score}/10 · V2.9`,signalMessage(x));
          }catch(e){
            console.error("ALERT_ERROR",String(e?.message||e));
          }
          if(data.signals.length>1)await sleep(1200);
        }
      })());
    }
  }
};
