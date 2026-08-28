const CFG = {
  symbols: ["ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "BNB-USDT"],
  minScore: 8,
  leverage: 5,
  paperBalance: 200,
  maxMarginPct: 0.10,
};

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
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function normalizeKlines(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.data ?? []);
  return raw.map(r => {
    if (Array.isArray(r)) {
      return { time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] };
    }
    return {
      time: +(r.time ?? r.openTime ?? r.ts ?? 0),
      open: +r.open,
      high: +r.high,
      low: +r.low,
      close: +r.close,
      volume: +(r.volume ?? r.vol ?? 0),
    };
  }).filter(x => Number.isFinite(x.close) && x.close > 0)
    .sort((a, b) => a.time - b.time);
}

async function getKlines(symbol, interval, limit = 120) {
  const u = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("limit", String(limit));
  const res = await fetch(u, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`${symbol} ${interval}: HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code != null && Number(json.code) !== 0) throw new Error(`${symbol} ${interval}: ${json.msg || json.code}`);
  const rows = normalizeKlines(json);
  if (rows.length < 60) throw new Error(`${symbol} ${interval}: yetersiz mum verisi (${rows.length})`);
  return rows;
}

function trend(rows) {
  const closes = rows.map(x => x.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const last = closes.at(-1);
  if (last > e20 && e20 > e50) return "LONG";
  if (last < e20 && e20 < e50) return "SHORT";
  return "NEUTRAL";
}

function analyze(symbol, h1, m15, btcDir) {
  const h1c = h1.map(x => x.close), m15c = m15.map(x => x.close);
  const dir1h = trend(h1);
  const dir15 = trend(m15);
  const direction = dir1h === dir15 && dir1h !== "NEUTRAL" ? dir1h : "NEUTRAL";
  const last = m15.at(-1);
  const rr = rsi(m15c, 14);
  const a = atr(m15, 14);
  const recentVol = avg(m15.slice(-4).map(x => x.volume));
  const baseVol = avg(m15.slice(-24, -4).map(x => x.volume));
  const volRatio = baseVol > 0 ? recentVol / baseVol : 0;
  const prior = m15.slice(-21, -1);
  const prevHigh = Math.max(...prior.map(x => x.high));
  const prevLow = Math.min(...prior.map(x => x.low));
  const breakoutLong = last.close > prevHigh;
  const breakoutShort = last.close < prevLow;
  const atrPct = a ? (a / last.close) * 100 : 99;

  let score = 0;
  const reasons = [];

  if (direction !== "NEUTRAL") { score += 2; reasons.push("1s ve 15dk trend aynı yönde"); }
  if (direction === btcDir && direction !== "NEUTRAL") { score += 1; reasons.push("BTC yönüyle uyumlu"); }
  if (volRatio >= 1.5) { score += 2; reasons.push(`hacim ${volRatio.toFixed(2)}x`); }
  else if (volRatio >= 1.2) { score += 1; reasons.push(`hacim ${volRatio.toFixed(2)}x`); }

  if (direction === "LONG" && breakoutLong) { score += 2; reasons.push("20 mumluk tepe kırılımı"); }
  if (direction === "SHORT" && breakoutShort) { score += 2; reasons.push("20 mumluk dip kırılımı"); }

  if (direction === "LONG" && rr >= 52 && rr <= 72) { score += 1; reasons.push(`RSI ${rr.toFixed(1)}`); }
  if (direction === "SHORT" && rr >= 28 && rr <= 48) { score += 1; reasons.push(`RSI ${rr.toFixed(1)}`); }

  if (atrPct >= 0.35 && atrPct <= 2.5) { score += 2; reasons.push(`ATR ${atrPct.toFixed(2)}%`); }
  else if (atrPct <= 3.5) { score += 1; reasons.push(`ATR ${atrPct.toFixed(2)}%`); }

  let stop = null, tp1 = null, tp2 = null;
  if (direction !== "NEUTRAL" && a) {
    const risk = 1.4 * a;
    if (direction === "LONG") {
      stop = last.close - risk;
      tp1 = last.close + 1.5 * risk;
      tp2 = last.close + 2.5 * risk;
    } else {
      stop = last.close + risk;
      tp1 = last.close - 1.5 * risk;
      tp2 = last.close - 2.5 * risk;
    }
  }

  const margin = +(CFG.paperBalance * CFG.maxMarginPct).toFixed(2);
  return {
    symbol,
    direction,
    score,
    qualifies: score >= CFG.minScore && direction !== "NEUTRAL",
    price: +last.close.toFixed(8),
    rsi: rr == null ? null : +rr.toFixed(1),
    volumeRatio: +volRatio.toFixed(2),
    atrPct: +atrPct.toFixed(2),
    entry: +last.close.toFixed(8),
    stop: stop == null ? null : +stop.toFixed(8),
    tp1: tp1 == null ? null : +tp1.toFixed(8),
    tp2: tp2 == null ? null : +tp2.toFixed(8),
    leverage: CFG.leverage,
    paperMarginUSDT: margin,
    reasons,
  };
}

async function scan() {
  const [btc1h, btc15] = await Promise.all([
    getKlines("BTC-USDT", "1h"),
    getKlines("BTC-USDT", "15m")
  ]);
  const b1 = trend(btc1h), b15 = trend(btc15);
  const btcDir = b1 === b15 ? b1 : "NEUTRAL";

  const results = [];
  for (const symbol of CFG.symbols) {
    try {
      const [h1, m15] = await Promise.all([
        getKlines(symbol, "1h"),
        getKlines(symbol, "15m")
      ]);
      results.push(analyze(symbol, h1, m15, btcDir));
    } catch (e) {
      results.push({ symbol, error: String(e.message || e) });
    }
  }
  return {
    mode: "PAPER_ONLY",
    scannedAt: new Date().toISOString(),
    btcDirection: btcDir,
    minScore: CFG.minScore,
    paperBalanceUSDT: CFG.paperBalance,
    signals: results.filter(x => x.qualifies).sort((a, b) => b.score - a.score),
    all: results.sort((a, b) => (b.score || 0) - (a.score || 0)),
  };
}

function page(data) {
  const cards = data.all.map(x => {
    if (x.error) return `<div class="card"><b>${x.symbol}</b><div class="bad">${x.error}</div></div>`;
    const cls = x.qualifies ? "good" : "muted";
    return `<div class="card"><div class="row"><b>${x.symbol}</b><span class="${cls}">${x.direction} · ${x.score}/10</span></div><div>Fiyat: ${x.price}</div><div>RSI: ${x.rsi} · Hacim: ${x.volumeRatio}x · ATR: ${x.atrPct}%</div><div>Giriş: ${x.entry}</div><div>SL: ${x.stop ?? "-"} · TP1: ${x.tp1 ?? "-"} · TP2: ${x.tp2 ?? "-"}</div><small>${(x.reasons || []).join(" · ") || "Teyit yetersiz"}</small></div>`;
  }).join("");
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BingX Paper Bot</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:auto;padding:18px;background:#0b0d10;color:#f4f4f5}.head{margin-bottom:14px}.card{background:#171a1f;border:1px solid #2a2f37;border-radius:14px;padding:14px;margin:10px 0;line-height:1.55}.row{display:flex;justify-content:space-between;gap:12px}.good{color:#4ade80}.bad{color:#fb7185}.muted,small{color:#a1a1aa}a{color:#93c5fd}</style><div class="head"><h2>BingX Paper Bot</h2><div>Mod: PAPER ONLY · Bakiye: ${data.paperBalanceUSDT} USDT · BTC: ${data.btcDirection}</div><small>Son tarama: ${data.scannedAt}</small></div>${cards}`;
}

export default {
  async fetch(request) {
    try {
      const data = await scan();
      const url = new URL(request.url);
      if (url.pathname === "/json") {
        return Response.json(data, { headers: { "cache-control": "no-store" } });
      }
      return new Response(page(data), { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
    } catch (e) {
      return new Response(`Bot hatası: ${e.message || e}`, { status: 500 });
    }
  },

  async scheduled(controller, env, ctx) {
    const data = await scan();
    console.log(JSON.stringify({ cron: controller.cron, ...data }));
  },
};
