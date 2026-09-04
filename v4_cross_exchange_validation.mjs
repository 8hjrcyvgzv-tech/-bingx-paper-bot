// V4 CLEAN CORE — CROSS-EXCHANGE HISTORICAL VALIDATION
// TEST / READ-ONLY ONLY — NO ORDERS
//
// Purpose:
// Compare the same recent 5m window on BingX Perpetual vs Binance USD-M Futures.
// We use the recent BingX window as the reference and test whether Binance can
// act as a historical proxy for PRICE/STRUCTURE and (separately) VOLUME dynamics.
//
// This file:
// - does NOT import V4 strategy modules
// - does NOT enable scanner/PAPER/LIVE
// - does NOT call any order endpoint
// - only reads public market-data endpoints
// - writes diagnostics to ./artifacts

import { mkdir, writeFile } from "node:fs/promises";

const VERSION = "V4_CROSS_EXCHANGE_VALIDATION_1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS = 5 * MINUTE;

const BINGX_BASES = [
  "https://open-api.bingx.com",
  "https://open-api.bingx.pro",
];

const BINGX_KLINE_PATH = "/openApi/swap/v3/quote/klines";
const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_KLINE_PATH = "/fapi/v1/klines";

const CONFIG = {
  symbols: String(
    process.env.VAL_SYMBOLS ||
      "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,ZEC-USDT"
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),

  days: Number(process.env.VAL_DAYS || 30),

  bingxChunkHours: Number(
    process.env.VAL_BINGX_CHUNK_HOURS || 12
  ),

  bingxLimit: Number(
    process.env.VAL_BINGX_LIMIT || 500
  ),

  binanceLimit: Number(
    process.env.VAL_BINANCE_LIMIT || 1000
  ),

  delayMs: Number(
    process.env.VAL_DELAY_MS || 350
  ),

  minCoverage: Number(
    process.env.VAL_MIN_COVERAGE || 0.985
  ),

  thresholds: {
    returnCorrelation: Number(
      process.env.VAL_RETURN_CORR_MIN || 0.98
    ),

    directionMatchPct: Number(
      process.env.VAL_DIRECTION_MATCH_MIN || 75
    ),

    medianAbsReturnDiffBps: Number(
      process.env.VAL_MEDIAN_RETURN_DIFF_BPS_MAX || 5
    ),

    rangeCorrelation: Number(
      process.env.VAL_RANGE_CORR_MIN || 0.90
    ),

    volumeLogCorrelation: Number(
      process.env.VAL_VOLUME_LOG_CORR_MIN || 0.50
    ),

    volumeSpikeJaccard: Number(
      process.env.VAL_VOLUME_SPIKE_JACCARD_MIN || 0.30
    ),
  },
};

let lastCallAt = 0;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (v, d = 4) => {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function iso(ts) {
  return new Date(ts).toISOString();
}

function floor5m(ts) {
  return Math.floor(ts / INTERVAL_MS) * INTERVAL_MS;
}

function toBinanceSymbol(bingxSymbol) {
  return bingxSymbol.replace("-", "");
}

async function rateLimit() {
  const elapsed = Date.now() - lastCallAt;
  const wait = Math.max(0, CONFIG.delayMs - elapsed);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function getJson(url) {
  await rateLimit();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-SOURCE-KEY": "BX-AI-SKILL",
      "User-Agent": "V4-Cross-Exchange-Validation/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON HTTP ${response.status}: ${text.slice(0, 180)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${json?.msg ?? json?.message ?? text.slice(0, 160)}`
    );
  }

  if (
    json?.code !== undefined &&
    !Array.isArray(json) &&
    Number(json.code) !== 0
  ) {
    throw new Error(
      `API ${json.code}: ${json?.msg ?? json?.message ?? "request failed"}`
    );
  }

  return json?.data ?? json;
}

async function bingxGet(params) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

  let lastError = null;

  for (const base of BINGX_BASES) {
    try {
      return await getJson(`${base}${BINGX_KLINE_PATH}?${query}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("BingX request failed");
}

async function binanceGet(params) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

  return await getJson(
    `${BINANCE_BASE}${BINANCE_KLINE_PATH}?${query}`
  );
}

function normalizeBingx(row) {
  if (Array.isArray(row)) {
    return {
      openTime: num(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]) ?? 0,
      quoteVolume:
        num(row[7]) ??
        ((num(row[4]) ?? 0) * (num(row[5]) ?? 0)),
    };
  }

  const close = num(row?.close);
  const volume = num(row?.volume) ?? 0;

  return {
    openTime: num(row?.openTime ?? row?.time ?? row?.ts),
    open: num(row?.open),
    high: num(row?.high),
    low: num(row?.low),
    close,
    volume,
    quoteVolume:
      num(row?.quoteVolume ?? row?.quoteAssetVolume) ??
      ((close ?? 0) * volume),
  };
}

function normalizeBinance(row) {
  if (!Array.isArray(row)) return null;

  return {
    openTime: num(row[0]),
    open: num(row[1]),
    high: num(row[2]),
    low: num(row[3]),
    close: num(row[4]),
    volume: num(row[5]) ?? 0,
    quoteVolume: num(row[7]) ?? 0,
  };
}

function valid(row) {
  return (
    row &&
    Number.isFinite(row.openTime) &&
    Number.isFinite(row.open) &&
    Number.isFinite(row.high) &&
    Number.isFinite(row.low) &&
    Number.isFinite(row.close) &&
    row.close > 0
  );
}

function dedupeSort(rows) {
  const map = new Map();

  for (const row of rows) {
    if (valid(row)) map.set(row.openTime, row);
  }

  return [...map.values()].sort(
    (a, b) => a.openTime - b.openTime
  );
}

function expectedBars(startTime, endTime) {
  return Math.floor((endTime - startTime) / INTERVAL_MS) + 1;
}

function coverageStats(rows, startTime, endTime) {
  const filtered = dedupeSort(rows).filter(
    (x) =>
      x.openTime >= startTime &&
      x.openTime <= endTime
  );

  const expected = expectedBars(startTime, endTime);
  const coverage = expected > 0 ? filtered.length / expected : 0;

  let maxGapMs = 0;
  let gapCount = 0;

  for (let i = 1; i < filtered.length; i++) {
    const gap =
      filtered[i].openTime - filtered[i - 1].openTime;

    maxGapMs = Math.max(maxGapMs, gap);

    if (gap > INTERVAL_MS) gapCount++;
  }

  return {
    rows: filtered,
    count: filtered.length,
    expected,
    coveragePct: round(coverage * 100, 3),
    maxGapMinutes: round(maxGapMs / MINUTE, 2),
    gapCount,
    complete:
      coverage >= CONFIG.minCoverage &&
      (filtered.length < 2 || maxGapMs <= INTERVAL_MS * 2),
  };
}

async function fetchBingxRange(symbol, startTime, endTime) {
  const all = [];
  const chunkMs = CONFIG.bingxChunkHours * HOUR;

  for (
    let cursor = startTime;
    cursor <= endTime;
    cursor += chunkMs
  ) {
    const chunkEnd = Math.min(
      endTime,
      cursor + chunkMs - INTERVAL_MS
    );

    const data = await bingxGet({
      symbol,
      interval: "5m",
      startTime: cursor,
      endTime: chunkEnd,
      limit: CONFIG.bingxLimit,
    });

    if (Array.isArray(data)) {
      all.push(...data.map(normalizeBingx));
    }

    console.log(
      `[BINGX] ${symbol} ${iso(cursor)} -> ${iso(chunkEnd)} raw=${Array.isArray(data) ? data.length : 0}`
    );
  }

  return coverageStats(all, startTime, endTime);
}

async function fetchBinanceRange(symbol, startTime, endTime) {
  const all = [];
  const apiSymbol = toBinanceSymbol(symbol);

  let cursor = startTime;
  let guard = 0;

  while (cursor <= endTime) {
    guard++;
    if (guard > 100) {
      throw new Error(
        `Binance pagination guard tripped for ${symbol}`
      );
    }

    const data = await binanceGet({
      symbol: apiSymbol,
      interval: "5m",
      startTime: cursor,
      endTime,
      limit: CONFIG.binanceLimit,
    });

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    const normalized =
      data.map(normalizeBinance).filter(valid);

    if (normalized.length === 0) break;

    all.push(...normalized);

    const lastOpenTime =
      normalized[normalized.length - 1].openTime;

    const next = lastOpenTime + INTERVAL_MS;

    if (next <= cursor) {
      throw new Error(
        `Binance pagination did not advance for ${symbol}`
      );
    }

    cursor = next;

    console.log(
      `[BINANCE] ${symbol} page=${guard} rows=${normalized.length} last=${iso(lastOpenTime)}`
    );

    if (normalized.length < CONFIG.binanceLimit) break;
  }

  return coverageStats(all, startTime, endTime);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pearson(xs, ys) {
  if (
    xs.length !== ys.length ||
    xs.length < 3
  ) {
    return null;
  }

  const mx = mean(xs);
  const my = mean(ys);

  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;

  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;

    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denominator = Math.sqrt(dx2 * dy2);

  return denominator > 0
    ? numerator / denominator
    : null;
}

function logReturn(prev, curr) {
  if (
    !Number.isFinite(prev) ||
    !Number.isFinite(curr) ||
    prev <= 0 ||
    curr <= 0
  ) {
    return null;
  }

  return Math.log(curr / prev);
}

function rangePct(row) {
  const mid = (row.high + row.low) / 2;

  if (!Number.isFinite(mid) || mid <= 0) return null;

  return (row.high - row.low) / mid;
}

function safeLog1p(value) {
  return Math.log1p(Math.max(0, value ?? 0));
}

function rollingMedian(values, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);
  const slice = values.slice(start, endIndex);
  return median(slice.filter(Number.isFinite));
}

function buildAlignedPairs(
  bingxRows,
  binanceRows
) {
  const a = new Map(
    bingxRows.map((x) => [x.openTime, x])
  );

  const b = new Map(
    binanceRows.map((x) => [x.openTime, x])
  );

  const times = [...a.keys()]
    .filter((t) => b.has(t))
    .sort((x, y) => x - y);

  return times.map((t) => ({
    openTime: t,
    bingx: a.get(t),
    binance: b.get(t),
  }));
}

function compareSeries(
  bingxRows,
  binanceRows,
  startTime,
  endTime
) {
  const pairs = buildAlignedPairs(
    bingxRows,
    binanceRows
  );

  const expected = expectedBars(startTime, endTime);
  const overlapCoverage =
    expected > 0 ? pairs.length / expected : 0;

  const bingxReturns = [];
  const binanceReturns = [];
  const absReturnDiffBps = [];
  const directionMatches = [];

  const bingxRanges = [];
  const binanceRanges = [];

  const bingxLogVol = [];
  const binanceLogVol = [];

  const bingxVolumes = pairs.map(
    (p) => p.bingx.quoteVolume ?? p.bingx.volume ?? 0
  );

  const binanceVolumes = pairs.map(
    (p) => p.binance.quoteVolume ?? p.binance.volume ?? 0
  );

  const bingxSpike = new Set();
  const binanceSpike = new Set();

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];

    const ra = rangePct(p.bingx);
    const rb = rangePct(p.binance);

    if (
      Number.isFinite(ra) &&
      Number.isFinite(rb)
    ) {
      bingxRanges.push(ra);
      binanceRanges.push(rb);
    }

    bingxLogVol.push(
      safeLog1p(bingxVolumes[i])
    );

    binanceLogVol.push(
      safeLog1p(binanceVolumes[i])
    );

    if (i > 0) {
      const prev = pairs[i - 1];

      const retA = logReturn(
        prev.bingx.close,
        p.bingx.close
      );

      const retB = logReturn(
        prev.binance.close,
        p.binance.close
      );

      if (
        Number.isFinite(retA) &&
        Number.isFinite(retB)
      ) {
        bingxReturns.push(retA);
        binanceReturns.push(retB);

        absReturnDiffBps.push(
          Math.abs(retA - retB) * 10_000
        );

        const signA =
          retA > 0 ? 1 : retA < 0 ? -1 : 0;

        const signB =
          retB > 0 ? 1 : retB < 0 ? -1 : 0;

        directionMatches.push(
          signA === signB ? 1 : 0
        );
      }
    }

    if (i >= 288) {
      const medA = rollingMedian(
        bingxVolumes,
        i,
        288
      );

      const medB = rollingMedian(
        binanceVolumes,
        i,
        288
      );

      if (
        Number.isFinite(medA) &&
        medA > 0 &&
        bingxVolumes[i] >= medA * 2
      ) {
        bingxSpike.add(p.openTime);
      }

      if (
        Number.isFinite(medB) &&
        medB > 0 &&
        binanceVolumes[i] >= medB * 2
      ) {
        binanceSpike.add(p.openTime);
      }
    }
  }

  const spikeUnion = new Set([
    ...bingxSpike,
    ...binanceSpike,
  ]);

  let spikeIntersection = 0;

  for (const t of bingxSpike) {
    if (binanceSpike.has(t)) spikeIntersection++;
  }

  const spikeJaccard =
    spikeUnion.size > 0
      ? spikeIntersection / spikeUnion.size
      : null;

  const metrics = {
    overlapRows: pairs.length,
    expectedRows: expected,
    overlapCoveragePct: round(
      overlapCoverage * 100,
      3
    ),

    returnCorrelation: round(
      pearson(
        bingxReturns,
        binanceReturns
      ),
      6
    ),

    directionMatchPct: round(
      (mean(directionMatches) ?? 0) * 100,
      3
    ),

    medianAbsReturnDiffBps: round(
      median(absReturnDiffBps),
      4
    ),

    p95AbsReturnDiffBps: round(
      (() => {
        if (!absReturnDiffBps.length) return null;
        const s = [...absReturnDiffBps].sort(
          (a, b) => a - b
        );
        return s[
          Math.min(
            s.length - 1,
            Math.floor(s.length * 0.95)
          )
        ];
      })(),
      4
    ),

    rangeCorrelation: round(
      pearson(
        bingxRanges,
        binanceRanges
      ),
      6
    ),

    volumeLogCorrelation: round(
      pearson(
        bingxLogVol,
        binanceLogVol
      ),
      6
    ),

    bingxVolumeSpikeCount:
      bingxSpike.size,

    binanceVolumeSpikeCount:
      binanceSpike.size,

    volumeSpikeIntersection:
      spikeIntersection,

    volumeSpikeJaccard: round(
      spikeJaccard,
      6
    ),
  };

  const pricePass =
    metrics.overlapCoveragePct >=
      CONFIG.minCoverage * 100 &&
    (metrics.returnCorrelation ?? -1) >=
      CONFIG.thresholds.returnCorrelation &&
    (metrics.directionMatchPct ?? 0) >=
      CONFIG.thresholds.directionMatchPct &&
    (metrics.medianAbsReturnDiffBps ?? Infinity) <=
      CONFIG.thresholds.medianAbsReturnDiffBps &&
    (metrics.rangeCorrelation ?? -1) >=
      CONFIG.thresholds.rangeCorrelation;

  const volumePass =
    (metrics.volumeLogCorrelation ?? -1) >=
      CONFIG.thresholds.volumeLogCorrelation &&
    (
      metrics.volumeSpikeJaccard === null ||
      metrics.volumeSpikeJaccard >=
        CONFIG.thresholds.volumeSpikeJaccard
    );

  return {
    ...metrics,
    pricePass,
    volumePass,

    fullProxyPass:
      pricePass && volumePass,

    notes: [
      "PRICE_PASS tests 5m return/range structure similarity.",
      "VOLUME_PASS uses normalized/log-volume behavior and 2x rolling-median spike overlap; absolute exchange volume is intentionally not compared.",
      "A FULL_PROXY_PASS is only a preliminary proxy verdict. It does not prove historical FLOW/CVD/OI/news equivalence.",
    ],
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";

  const s =
    typeof v === "object"
      ? JSON.stringify(v)
      : String(v);

  if (/[",\n]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }

  return s;
}

function toCsv(rows) {
  const headers = [
    "symbol",
    "bingxCoveragePct",
    "binanceCoveragePct",
    "overlapCoveragePct",
    "returnCorrelation",
    "directionMatchPct",
    "medianAbsReturnDiffBps",
    "p95AbsReturnDiffBps",
    "rangeCorrelation",
    "volumeLogCorrelation",
    "bingxVolumeSpikeCount",
    "binanceVolumeSpikeCount",
    "volumeSpikeIntersection",
    "volumeSpikeJaccard",
    "pricePass",
    "volumePass",
    "fullProxyPass",
    "error",
  ];

  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) => csvEscape(row[h]))
        .join(",")
    ),
  ].join("\n");
}

async function main() {
  console.log(
    "================================================"
  );
  console.log(
    "V4 CLEAN CORE — CROSS-EXCHANGE VALIDATION"
  );
  console.log(
    "BingX reference vs Binance USD-M Futures"
  );
  console.log(
    "READ ONLY — NO PAPER / NO LIVE / NO ORDERS"
  );
  console.log(
    "================================================"
  );

  await mkdir("artifacts", {
    recursive: true,
  });

  const endTime =
    floor5m(Date.now()) -
    INTERVAL_MS;

  const startTime =
    endTime -
    CONFIG.days * DAY +
    INTERVAL_MS;

  console.log(
    `Window: ${iso(startTime)} -> ${iso(endTime)}`
  );

  const results = [];

  for (const symbol of CONFIG.symbols) {
    console.log(
      `\n========== ${symbol} ==========`
    );

    const row = {
      symbol,
    };

    try {
      const bingx = await fetchBingxRange(
        symbol,
        startTime,
        endTime
      );

      row.bingxCoveragePct =
        bingx.coveragePct;
      row.bingxRows =
        bingx.count;
      row.bingxExpected =
        bingx.expected;
      row.bingxGapCount =
        bingx.gapCount;
      row.bingxMaxGapMinutes =
        bingx.maxGapMinutes;

      if (!bingx.complete) {
        throw new Error(
          `BingX reference incomplete: ${bingx.coveragePct}% (${bingx.count}/${bingx.expected})`
        );
      }

      const binance = await fetchBinanceRange(
        symbol,
        startTime,
        endTime
      );

      row.binanceCoveragePct =
        binance.coveragePct;
      row.binanceRows =
        binance.count;
      row.binanceExpected =
        binance.expected;
      row.binanceGapCount =
        binance.gapCount;
      row.binanceMaxGapMinutes =
        binance.maxGapMinutes;

      if (!binance.complete) {
        throw new Error(
          `Binance candidate incomplete: ${binance.coveragePct}% (${binance.count}/${binance.expected})`
        );
      }

      Object.assign(
        row,
        compareSeries(
          bingx.rows,
          binance.rows,
          startTime,
          endTime
        )
      );

      console.log(
        `[COMPARE] ${symbol} pricePass=${row.pricePass} volumePass=${row.volumePass} fullProxyPass=${row.fullProxyPass}`
      );

      console.log(
        `[METRICS] corr=${row.returnCorrelation} dir=${row.directionMatchPct}% medDiff=${row.medianAbsReturnDiffBps}bps rangeCorr=${row.rangeCorrelation} volCorr=${row.volumeLogCorrelation} spikeJ=${row.volumeSpikeJaccard}`
      );
    } catch (error) {
      row.error = String(
        error?.message ?? error
      );

      row.pricePass = false;
      row.volumePass = false;
      row.fullProxyPass = false;

      console.log(
        `[FAILED] ${symbol}: ${row.error}`
      );
    }

    results.push(row);
  }

  const clean = results.filter(
    (x) => !x.error
  );

  const pricePassCount =
    clean.filter(
      (x) => x.pricePass
    ).length;

  const volumePassCount =
    clean.filter(
      (x) => x.volumePass
    ).length;

  const fullProxyPassCount =
    clean.filter(
      (x) => x.fullProxyPass
    ).length;

  let verdict =
    "REJECT_BINANCE_AS_FULL_V4_PROXY";

  if (
    clean.length === CONFIG.symbols.length &&
    fullProxyPassCount === CONFIG.symbols.length
  ) {
    verdict =
      "BINANCE_PROXY_CANDIDATE_PASS_BUILD_100D_FROZEN_DATASET";
  } else if (
    clean.length === CONFIG.symbols.length &&
    pricePassCount === CONFIG.symbols.length
  ) {
    verdict =
      "PRICE_STRUCTURE_PROXY_PASS_VOLUME_PROXY_NOT_PROVEN";
  } else if (
    clean.length > 0 &&
    pricePassCount >=
      Math.ceil(clean.length * 0.8)
  ) {
    verdict =
      "PARTIAL_PRICE_PROXY_NEEDS_SYMBOL_LEVEL_REVIEW";
  }

  const summary = {
    version: VERSION,
    generatedAt:
      new Date().toISOString(),
    mode:
      "CROSS_EXCHANGE_VALIDATION_ONLY",

    safety: {
      strategyModulesImported: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
      orderEndpointsUsed: false,
    },

    config: CONFIG,

    window: {
      start: iso(startTime),
      end: iso(endTime),
      days: CONFIG.days,
      interval: "5m",
    },

    aggregate: {
      symbolsRequested:
        CONFIG.symbols.length,
      symbolsCompared:
        clean.length,
      pricePassCount,
      volumePassCount,
      fullProxyPassCount,
      verdict,
    },

    limitations: [
      "This validates recent 5m price/range/volume-proxy behavior only.",
      "It does not validate historical BingX-specific CVD, OI, funding, liquidations or news.",
      "Exchange absolute volume is not expected to match; normalized volume behavior is compared instead.",
      "A pass permits building a frozen 100d candidate dataset for replay validation; it does not authorize PAPER or LIVE trading.",
    ],

    results,
  };

  await writeFile(
    "artifacts/v4_cross_exchange_validation_summary.json",
    JSON.stringify(
      summary,
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    "artifacts/v4_cross_exchange_validation.csv",
    toCsv(results),
    "utf8"
  );

  console.log(
    "\n================================================"
  );
  console.log(
    "V4 CROSS-EXCHANGE VALIDATION COMPLETE"
  );
  console.log(
    JSON.stringify(
      summary.aggregate,
      null,
      2
    )
  );
  console.log(
    "Artifacts:"
  );
  console.log(
    "- artifacts/v4_cross_exchange_validation_summary.json"
  );
  console.log(
    "- artifacts/v4_cross_exchange_validation.csv"
  );
  console.log(
    "================================================"
  );

  if (clean.length === 0) {
    process.exitCode = 2;
  }
}

await main();
