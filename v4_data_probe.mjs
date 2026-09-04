// V4 CLEAN CORE — BINGX HISTORICAL DATA PROBE
// READ-ONLY TEST. NO PAPER / NO REAL ORDERS.

import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const VERSION = "V4_DATA_PROBE_1";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS = 5 * MINUTE;
const BASE_URLS = ["https://open-api.bingx.com", "https://open-api.bingx.pro"];
const KLINE_PATH = "/openApi/swap/v3/quote/klines";

const CONFIG = {
  symbols: String(process.env.PROBE_SYMBOLS || "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,ZEC-USDT")
    .split(",").map(x => x.trim().toUpperCase()).filter(Boolean),
  lookbacksDays: String(process.env.PROBE_LOOKBACKS_DAYS || "5,30,45,60,75,90,100")
    .split(",").map(Number).filter(x => Number.isFinite(x) && x > 0),
  windowHours: Number(process.env.PROBE_WINDOW_HOURS || 24),
  stressHours: String(process.env.PROBE_STRESS_HOURS || "6,12,24,36,48")
    .split(",").map(Number).filter(x => Number.isFinite(x) && x > 0),
  stressLookbackDays: Number(process.env.PROBE_STRESS_LOOKBACK_DAYS || 90),
  requestLimit: Number(process.env.PROBE_REQUEST_LIMIT || 1440),
  minCoverage: Number(process.env.PROBE_MIN_COVERAGE || 0.97),
  maxGapBars: Number(process.env.PROBE_MAX_GAP_BARS || 2),
  delayMs: Number(process.env.PROBE_DELAY_MS || 700),
};

let lastCallAt = 0;
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const round = (v, d = 4) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = ts => new Date(ts).toISOString();
const floorUtcDay = ts => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

function signedQuery(params) {
  const apiKey = process.env.BINGX_API_KEY;
  const secret = process.env.BINGX_SECRET_KEY;
  if (!apiKey || !secret) {
    return {
      query: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
      headers: { "X-SOURCE-KEY": "BX-AI-SKILL" },
    };
  }
  const all = { ...params, timestamp: Date.now() };
  const canonical = Object.keys(all).sort().map(k => `${k}=${all[k]}`).join("&");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    query: `${canonical}&signature=${signature}`,
    headers: { "X-BX-APIKEY": apiKey, "X-SOURCE-KEY": "BX-AI-SKILL" },
  };
}

async function bingxGet(path, params) {
  const wait = Math.max(0, CONFIG.delayMs - (Date.now() - lastCallAt));
  if (wait) await sleep(wait);
  lastCallAt = Date.now();
  const auth = signedQuery(params);
  let lastError = null;
  for (const base of BASE_URLS) {
    try {
      const res = await fetch(`${base}${path}?${auth.query}`, {
        method: "GET",
        headers: auth.headers,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0, 160)}`); }
      if (!res.ok || (json?.code !== undefined && Number(json.code) !== 0)) {
        throw new Error(`BingX ${json?.code ?? res.status}: ${json?.msg ?? json?.message ?? "request failed"}`);
      }
      return json?.data ?? json;
    } catch (e) { lastError = e; }
  }
  throw lastError ?? new Error("BingX request failed");
}

function normalize(row) {
  if (Array.isArray(row)) {
    return { openTime: num(row[0]), open: num(row[1]), high: num(row[2]), low: num(row[3]), close: num(row[4]) };
  }
  return {
    openTime: num(row?.openTime ?? row?.time ?? row?.ts),
    open: num(row?.open), high: num(row?.high), low: num(row?.low), close: num(row?.close),
  };
}

function evaluate(rawRows, startTime, endTime) {
  const map = new Map();
  for (const x of (Array.isArray(rawRows) ? rawRows : []).map(normalize)) {
    if ([x.openTime, x.open, x.high, x.low, x.close].every(Number.isFinite) && x.close > 0 && x.openTime >= startTime && x.openTime <= endTime) {
      map.set(x.openTime, x);
    }
  }
  const rows = [...map.values()].sort((a, b) => a.openTime - b.openTime);
  const expected = Math.floor((endTime - startTime) / INTERVAL_MS) + 1;
  const coverage = expected > 0 ? rows.length / expected : 0;
  let maxGapMs = 0;
  let gapCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].openTime - rows[i - 1].openTime;
    maxGapMs = Math.max(maxGapMs, gap);
    if (gap > INTERVAL_MS) gapCount++;
  }
  const maxGapBars = maxGapMs ? maxGapMs / INTERVAL_MS : 0;
  return {
    rows: rows.length,
    expected,
    coveragePct: round(coverage * 100, 2),
    maxGapMinutes: round(maxGapMs / MINUTE, 2),
    gapCount,
    complete: coverage >= CONFIG.minCoverage && (rows.length < 2 || maxGapBars <= CONFIG.maxGapBars),
  };
}

async function probe(symbol, startTime, endTime) {
  const data = await bingxGet(KLINE_PATH, {
    symbol, interval: "5m", startTime: Math.floor(startTime), endTime: Math.floor(endTime), limit: CONFIG.requestLimit,
  });
  return evaluate(data, startTime, endTime);
}

const statusOf = row => row.error ? "ERROR" : row.complete ? "FULL" : (row.coveragePct ?? 0) >= 80 ? "PARTIAL" : "FAIL";
const csvEscape = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);

async function main() {
  console.log("==========================================");
  console.log("V4 CLEAN CORE — BINGX DATA PROBE");
  console.log("READ ONLY — NO PAPER / NO REAL ORDERS");
  console.log("==========================================");

  await mkdir("artifacts", { recursive: true });
  const anchor = floorUtcDay(Date.now());
  const checks = [];

  for (const symbol of CONFIG.symbols) {
    for (const lookbackDays of CONFIG.lookbacksDays) {
      const startTime = anchor - lookbackDays * DAY;
      const endTime = startTime + CONFIG.windowHours * HOUR - INTERVAL_MS;
      const row = { kind: "AGE", symbol, lookbackDays, windowHours: CONFIG.windowHours, start: iso(startTime), end: iso(endTime) };
      try { Object.assign(row, await probe(symbol, startTime, endTime)); }
      catch (e) { row.error = String(e?.message ?? e); }
      row.status = statusOf(row);
      checks.push(row);
      console.log(`[AGE] ${symbol} ${lookbackDays}d ${row.status} coverage=${row.coveragePct ?? "ERR"}% rows=${row.rows ?? 0}/${row.expected ?? 0} maxGap=${row.maxGapMinutes ?? "ERR"}m`);
    }
  }

  const stress = [];
  const stressSymbol = CONFIG.symbols[0] || "BTC-USDT";
  const stressStart = anchor - CONFIG.stressLookbackDays * DAY;
  for (const windowHours of CONFIG.stressHours) {
    const endTime = stressStart + windowHours * HOUR - INTERVAL_MS;
    const row = { kind: "RANGE_STRESS", symbol: stressSymbol, lookbackDays: CONFIG.stressLookbackDays, windowHours, start: iso(stressStart), end: iso(endTime) };
    try { Object.assign(row, await probe(stressSymbol, stressStart, endTime)); }
    catch (e) { row.error = String(e?.message ?? e); }
    row.status = statusOf(row);
    stress.push(row);
    console.log(`[STRESS] ${stressSymbol} ${windowHours}h ${row.status} coverage=${row.coveragePct ?? "ERR"}% rows=${row.rows ?? 0}/${row.expected ?? 0} maxGap=${row.maxGapMinutes ?? "ERR"}m`);
  }

  const fullAge = checks.filter(x => x.status === "FULL").length;
  const allAgeFull = checks.length > 0 && fullAge === checks.length;
  const safeStress = stress.filter(x => x.status === "FULL").map(x => x.windowHours).sort((a, b) => a - b);
  const largestSafeStressWindowHours = safeStress.length ? safeStress.at(-1) : null;
  const recommendedNextAction = allAgeFull
    ? "USE_24H_BINGX_PAGINATION_AND_RERUN_CORE6_100D"
    : largestSafeStressWindowHours
      ? `TEST_${largestSafeStressWindowHours}H_PAGINATION_ACROSS_ALL_CORE6`
      : "BINGX_5M_HISTORY_NOT_RELIABLE_ENOUGH_USE_ALTERNATE_SOURCE";

  const summary = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    mode: "DATA_PROBE_ONLY",
    safety: { strategyModulesImported: false, scannerEnabled: false, paperOrdersEnabled: false, realOrdersEnabled: false, orderEndpointsUsed: false },
    config: CONFIG,
    summary: { checks: checks.length, fullAge, allAgeFull, largestSafeStressWindowHours, recommendedNextAction },
    checks,
    stress,
  };

  await writeFile("artifacts/v4_data_probe_summary.json", JSON.stringify(summary, null, 2), "utf8");
  const headers = ["kind","symbol","lookbackDays","windowHours","start","end","rows","expected","coveragePct","maxGapMinutes","gapCount","status","error"];
  const lines = [headers.join(","), ...[...checks, ...stress].map(r => headers.map(h => csvEscape(r[h])).join(","))];
  await writeFile("artifacts/v4_data_probe_checks.csv", lines.join("\n"), "utf8");

  console.log("==========================================");
  console.log("V4 DATA PROBE COMPLETE");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log("==========================================");
}

await main();
