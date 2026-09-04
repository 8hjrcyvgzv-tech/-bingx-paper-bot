// V4 CLEAN CORE — REPLAY RUNNER
// TIBERIUS PERFORMANCE LAB
// HISTORICAL ANALYSIS ONLY
// NO PAPER ORDERS
// NO REAL ORDERS

import {
  runV4CleanCore,
} from "./worker_v4_clean_core.js";

import {
  createHmac,
} from "node:crypto";

import {
  mkdir,
  writeFile,
} from "node:fs/promises";

const VERSION = "V4_REPLAY_RUNNER_1";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const CONFIG = {
  symbols: String(
    process.env.REPLAY_SYMBOLS ||
      "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,ZEC-USDT"
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),

  replayDays: Number(
    process.env.REPLAY_DAYS || 30
  ),

  replayStepMinutes: Number(
    process.env.REPLAY_STEP_MIN || 15
  ),

  outcomeHours: Number(
    process.env.REPLAY_OUTCOME_HOURS || 24
  ),

  signalCooldownHours: Number(
    process.env.REPLAY_SIGNAL_COOLDOWN_HOURS || 6
  ),

  // We deliberately use 5m as the first replay base.
  // XRP/ZEC can later receive a dedicated 1m regression test.
  baseInterval: "5m",
};

const INTERVAL_MS = {
  "5m": 5 * MINUTE,
  "4h": 4 * HOUR,
  "12h": 12 * HOUR,
  "1d": DAY,
};

const BASE_URLS = [
  "https://open-api.bingx.com",
  "https://open-api.bingx.pro",
];

const KLINE_PATH =
  "/openApi/swap/v3/quote/klines";

let lastApiCallAt = 0;

// ---------------------------------------------------------
// BASIC HELPERS
// ---------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 4) {
  if (!Number.isFinite(v)) return null;

  const m = 10 ** digits;

  return Math.round(v * m) / m;
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

function iso(ts) {
  return new Date(ts).toISOString();
}

function median(values) {
  const rows = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!rows.length) return null;

  const mid =
    Math.floor(rows.length / 2);

  if (rows.length % 2) {
    return rows[mid];
  }

  return (
    rows[mid - 1] + rows[mid]
  ) / 2;
}

// ---------------------------------------------------------
// BINGX MARKET DATA — READ ONLY
// ---------------------------------------------------------

function signedQuery(params) {
  const apiKey =
    process.env.BINGX_API_KEY;

  const secret =
    process.env.BINGX_SECRET_KEY;

  if (!apiKey || !secret) {
    return {
      query:
        new URLSearchParams(
          Object.entries(params).map(
            ([k, v]) => [
              k,
              String(v),
            ]
          )
        ).toString(),

      headers: {
        "X-SOURCE-KEY":
          "BX-AI-SKILL",
      },
    };
  }

  const all = {
    ...params,
    timestamp: Date.now(),
  };

  const canonical =
    Object.keys(all)
      .sort()
      .map(
        (key) =>
          `${key}=${all[key]}`
      )
      .join("&");

  const signature =
    createHmac(
      "sha256",
      secret
    )
      .update(canonical)
      .digest("hex");

  const query =
    `${canonical}&signature=${signature}`;

  return {
    query,

    headers: {
      "X-BX-APIKEY": apiKey,
      "X-SOURCE-KEY":
        "BX-AI-SKILL",
    },
  };
}

async function enforceRateLimit() {
  // Conservative replay throttle.
  const elapsed =
    Date.now() - lastApiCallAt;

  const wait =
    Math.max(
      0,
      1050 - elapsed
    );

  if (wait > 0) {
    await sleep(wait);
  }

  lastApiCallAt = Date.now();
}

async function bingxGet(
  path,
  params
) {
  await enforceRateLimit();

  const auth =
    signedQuery(params);

  let lastError = null;

  for (
    const base of BASE_URLS
  ) {
    try {
      const response =
        await fetch(
          `${base}${path}?${auth.query}`,
          {
            method: "GET",
            headers:
              auth.headers,

            signal:
              AbortSignal.timeout(
                15000
              ),
          }
        );

      const text =
        await response.text();

      let json;

      try {
        json =
          JSON.parse(text);
      } catch {
        throw new Error(
          `BingX invalid JSON: ${text.slice(0, 180)}`
        );
      }

      if (
        !response.ok ||
        (
          json?.code !== undefined &&
          Number(json.code) !== 0
        )
      ) {
        throw new Error(
          `BingX ${json?.code ?? response.status}: ${
            json?.msg ??
            json?.message ??
            "request failed"
          }`
        );
      }

      return json?.data ?? json;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ??
    new Error(
      "BingX request failed"
    );
}

function normalizeKline(
  row,
  interval
) {
  const ms =
    INTERVAL_MS[interval];

  if (Array.isArray(row)) {
    const openTime =
      Number(row[0]);

    const volume =
      Number(row[5] ?? 0);

    const close =
      Number(row[4]);

    return {
      openTime,

      closeTime:
        Number(row[6]) ||
        openTime + ms - 1,

      open:
        Number(row[1]),

      high:
        Number(row[2]),

      low:
        Number(row[3]),

      close,

      volume,

      quoteVolume:
        Number(row[7]) ||
        close * volume,
    };
  }

  const openTime =
    Number(
      row?.openTime ??
      row?.time ??
      row?.ts
    );

  const close =
    Number(row?.close);

  const volume =
    Number(row?.volume ?? 0);

  return {
    openTime,

    closeTime:
      Number(row?.closeTime) ||
      openTime + ms - 1,

    open:
      Number(row?.open),

    high:
      Number(row?.high),

    low:
      Number(row?.low),

    close,

    volume,

    quoteVolume:
      Number(
        row?.quoteVolume ??
        row?.quoteAssetVolume
      ) ||
      close * volume,
  };
}

function validKline(row) {
  return (
    Number.isFinite(
      row?.openTime
    ) &&
    Number.isFinite(
      row?.closeTime
    ) &&
    Number.isFinite(
      row?.open
    ) &&
    Number.isFinite(
      row?.high
    ) &&
    Number.isFinite(
      row?.low
    ) &&
    Number.isFinite(
      row?.close
    ) &&
    row.close > 0
  );
}

async function fetchKlines(
  symbol,
  interval,
  startTime,
  endTime
) {
  const intervalMs =
    INTERVAL_MS[interval];

  const maxRows = 1440;

  let cursor =
    startTime;

  const collected = [];

  while (
    cursor <= endTime
  ) {
    const chunkEnd =
      Math.min(
        endTime,
        cursor +
          intervalMs *
            (maxRows - 1)
      );

    console.log(
      `[DATA] ${symbol} ${interval} ${iso(cursor)} -> ${iso(chunkEnd)}`
    );

    const data =
      await bingxGet(
        KLINE_PATH,
        {
          symbol,
          interval,
          startTime:
            Math.floor(cursor),

          endTime:
            Math.floor(chunkEnd),

          limit:
            maxRows,
        }
      );

    const rows =
      (
        Array.isArray(data)
          ? data
          : []
      )
        .map(
          (x) =>
            normalizeKline(
              x,
              interval
            )
        )
        .filter(validKline)
        .filter(
          (x) =>
            x.openTime >=
              startTime &&
            x.openTime <=
              endTime
        )
        .sort(
          (a, b) =>
            a.openTime -
            b.openTime
        );

    collected.push(
      ...rows
    );

    cursor =
      chunkEnd +
      intervalMs;
  }

  const dedupe =
    new Map();

  for (
    const row of collected
  ) {
    dedupe.set(
      row.openTime,
      row
    );
  }

  return [
    ...dedupe.values(),
  ].sort(
    (a, b) =>
      a.openTime -
      b.openTime
  );
}

// ---------------------------------------------------------
// 5M -> 15M / 1H AGGREGATION
// ---------------------------------------------------------

function aggregateCandles(
  rows,
  minutes
) {
  const bucketMs =
    minutes * MINUTE;

  const expected =
    minutes / 5;

  const groups =
    new Map();

  for (const row of rows) {
    const bucket =
      Math.floor(
        row.openTime /
          bucketMs
      ) * bucketMs;

    if (
      !groups.has(bucket)
    ) {
      groups.set(
        bucket,
        []
      );
    }

    groups
      .get(bucket)
      .push(row);
  }

  const output = [];

  for (
    const [
      bucket,
      part,
    ] of groups
  ) {
    part.sort(
      (a, b) =>
        a.openTime -
        b.openTime
    );

    // Avoid using incomplete aggregated candles.
    if (
      part.length < expected
    ) {
      continue;
    }

    const first =
      part[0];

    const last =
      part.at(-1);

    output.push({
      openTime:
        bucket,

      closeTime:
        bucket +
        bucketMs -
        1,

      open:
        first.open,

      high:
        Math.max(
          ...part.map(
            (x) => x.high
          )
        ),

      low:
        Math.min(
          ...part.map(
            (x) => x.low
          )
        ),

      close:
        last.close,

      volume:
        part.reduce(
          (sum, x) =>
            sum +
            (num(x.volume) ?? 0),
          0
        ),

      quoteVolume:
        part.reduce(
          (sum, x) =>
            sum +
            (
              num(
                x.quoteVolume
              ) ?? 0
            ),
          0
        ),
    });
  }

  return output.sort(
    (a, b) =>
      a.openTime -
      b.openTime
  );
}

// ---------------------------------------------------------
// RADAR SNAPSHOT PREPARATION
// ---------------------------------------------------------

function addVolumeState(
  rows
) {
  let cumulative = 0;

  let rolling = 0;
  let left = 0;

  const output = [];

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {
    const row =
      rows[i];

    const q =
      num(
        row.quoteVolume
      ) ?? 0;

    cumulative += q;
    rolling += q;

    const cutoff =
      row.closeTime - DAY;

    while (
      left < i &&
      rows[left].closeTime <
        cutoff
    ) {
      rolling -=
        num(
          rows[left]
            .quoteVolume
        ) ?? 0;

      left++;
    }

    output.push({
      ...row,

      cumulativeQuote:
        cumulative,

      quoteVolume24h:
        Math.max(
          0,
          rolling
        ),
    });
  }

  return output;
}

function upperIndex(
  rows,
  timestamp
) {
  let lo = 0;
  let hi = rows.length;

  while (lo < hi) {
    const mid =
      Math.floor(
        (lo + hi) / 2
      );

    if (
      rows[mid].closeTime <=
      timestamp
    ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

function sliceUntil(
  rows,
  timestamp,
  limit
) {
  const end =
    upperIndex(
      rows,
      timestamp
    );

  return rows.slice(
    Math.max(
      0,
      end - limit
    ),
    end
  );
}

function radarStructureHints(
  candles15m
) {
  if (
    candles15m.length < 22
  ) {
    return {
      compressionRatio:
        null,

      distanceToBreakoutPct:
        null,
    };
  }

  const latest =
    candles15m.at(-1);

  const recent =
    candles15m.slice(
      -6
    );

  const prior =
    candles15m.slice(
      -21,
      -6
    );

  const recentRange =
    Math.max(
      ...recent.map(
        (x) => x.high
      )
    ) -
    Math.min(
      ...recent.map(
        (x) => x.low
      )
    );

  const priorRange =
    Math.max(
      ...prior.map(
        (x) => x.high
      )
    ) -
    Math.min(
      ...prior.map(
        (x) => x.low
      )
    );

  const compressionRatio =
    priorRange > 0
      ? recentRange /
        priorRange
      : null;

  const boundaryRows =
    candles15m.slice(
      -21,
      -1
    );

  const highBoundary =
    Math.max(
      ...boundaryRows.map(
        (x) => x.high
      )
    );

  const lowBoundary =
    Math.min(
      ...boundaryRows.map(
        (x) => x.low
      )
    );

  const momentumRef =
    candles15m.at(-5)
      ?.close;

  const bullish =
    momentumRef > 0
      ? latest.close >=
        momentumRef
      : true;

  const boundary =
    bullish
      ? highBoundary
      : lowBoundary;

  const distance =
    latest.close > 0
      ? (
          Math.abs(
            boundary -
            latest.close
          ) /
          latest.close
        ) * 100
      : null;

  return {
    compressionRatio:
      round(
        compressionRatio,
        4
      ),

    distanceToBreakoutPct:
      round(
        distance,
        4
      ),
  };
}

// ---------------------------------------------------------
// TRADE OUTCOME EVALUATION
// ---------------------------------------------------------

function directionalMove(
  direction,
  from,
  to
) {
  if (
    !(from > 0) ||
    !(to > 0)
  ) {
    return null;
  }

  const raw =
    (
      (to - from) /
      from
    ) * 100;

  return direction === "SHORT"
    ? -raw
    : raw;
}

function priceAfter(
  rows,
  timestamp,
  minutes
) {
  const target =
    timestamp +
    minutes * MINUTE;

  const index =
    upperIndex(
      rows,
      target
    );

  if (index <= 0) {
    return null;
  }

  return rows[
    index - 1
  ]?.close ?? null;
}

function evaluateOutcome(
  signal,
  fiveMinuteRows
) {
  const {
    timestamp,
    direction,
    entry,
    stop,
    tp1,
    tp2,
  } = signal;

  if (
    !(entry > 0) ||
    !(stop > 0)
  ) {
    return {
      outcome:
        "INVALID_RISK",

      resultR:
        null,
    };
  }

  const risk =
    Math.abs(
      entry - stop
    );

  if (!(risk > 0)) {
    return {
      outcome:
        "INVALID_RISK",

      resultR:
        null,
    };
  }

  const endTime =
    timestamp +
    CONFIG.outcomeHours *
      HOUR;

  const startIndex =
    upperIndex(
      fiveMinuteRows,
      timestamp
    );

  let maxFavorable = 0;
  let maxAdverse = 0;

  let firstTouch =
    "TIMEOUT";

  let resultR = null;

  let finalClose =
    entry;

  let tp2Hit = false;

  for (
    let i = startIndex;
    i <
      fiveMinuteRows.length;
    i++
  ) {
    const bar =
      fiveMinuteRows[i];

    if (
      bar.closeTime >
      endTime
    ) {
      break;
    }

    finalClose =
      bar.close;

    let favorable;
    let adverse;

    if (
      direction === "LONG"
    ) {
      favorable =
        bar.high - entry;

      adverse =
        entry - bar.low;
    } else {
      favorable =
        entry - bar.low;

      adverse =
        bar.high - entry;
    }

    maxFavorable =
      Math.max(
        maxFavorable,
        favorable
      );

    maxAdverse =
      Math.max(
        maxAdverse,
        adverse
      );

    const stopHit =
      direction === "LONG"
        ? bar.low <= stop
        : bar.high >= stop;

    const tp1Hit =
      tp1 > 0 &&
      (
        direction === "LONG"
          ? bar.high >= tp1
          : bar.low <= tp1
      );

    const tp2Touched =
      tp2 > 0 &&
      (
        direction === "LONG"
          ? bar.high >= tp2
          : bar.low <= tp2
      );

    if (tp2Touched) {
      tp2Hit = true;
    }

    // Conservative same-candle assumption:
    // stop wins if both levels were touched.
    if (
      firstTouch ===
        "TIMEOUT" &&
      stopHit
    ) {
      firstTouch =
        "STOP";

      resultR = -1;

      break;
    }

    if (
      firstTouch ===
        "TIMEOUT" &&
      tp1Hit
    ) {
      firstTouch =
        "TP1";

      resultR =
        Math.abs(
          tp1 - entry
        ) / risk;

      break;
    }
  }

  if (
    firstTouch ===
    "TIMEOUT"
  ) {
    const signed =
      direction === "LONG"
        ? finalClose -
          entry
        : entry -
          finalClose;

    resultR =
      signed / risk;
  }

  const price15 =
    priceAfter(
      fiveMinuteRows,
      timestamp,
      15
    );

  const price60 =
    priceAfter(
      fiveMinuteRows,
      timestamp,
      60
    );

  const price240 =
    priceAfter(
      fiveMinuteRows,
      timestamp,
      240
    );

  return {
    outcome:
      firstTouch,

    resultR:
      round(
        resultR,
        4
      ),

    mfeR:
      round(
        maxFavorable /
          risk,
        4
      ),

    maeR:
      round(
        maxAdverse /
          risk,
        4
      ),

    tp2Hit,

    after15mPct:
      round(
        directionalMove(
          direction,
          entry,
          price15
        ),
        4
      ),

    after1hPct:
      round(
        directionalMove(
          direction,
          entry,
          price60
        ),
        4
      ),

    after4hPct:
      round(
        directionalMove(
          direction,
          entry,
          price240
        ),
        4
      ),
  };
}

// ---------------------------------------------------------
// PERFORMANCE METRICS
// ---------------------------------------------------------

function maxDrawdownR(
  values
) {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  for (
    const value of values
  ) {
    if (
      !Number.isFinite(value)
    ) {
      continue;
    }

    equity += value;

    peak =
      Math.max(
        peak,
        equity
      );

    maxDD =
      Math.max(
        maxDD,
        peak - equity
      );
  }

  return maxDD;
}

function stats(
  events
) {
  const results =
    events
      .map(
        (x) =>
          x.resultR
      )
      .filter(
        Number.isFinite
      );

  const wins =
    results.filter(
      (x) => x > 0
    );

  const losses =
    results.filter(
      (x) => x < 0
    );

  const grossWin =
    wins.reduce(
      (a, b) => a + b,
      0
    );

  const grossLoss =
    Math.abs(
      losses.reduce(
        (a, b) => a + b,
        0
      )
    );

  const averageR =
    results.length
      ? results.reduce(
          (a, b) => a + b,
          0
        ) /
        results.length
      : null;

  return {
    signals:
      events.length,

    resolved:
      results.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRatePct:
      results.length
        ? round(
            (
              wins.length /
              results.length
            ) * 100,
            2
          )
        : null,

    averageR:
      round(
        averageR,
        4
      ),

    expectancyR:
      round(
        averageR,
        4
      ),

    profitFactor:
      grossLoss > 0
        ? round(
            grossWin /
              grossLoss,
            4
          )
        : grossWin > 0
        ? 999
        : null,

    maxDrawdownR:
      round(
        maxDrawdownR(
          results
        ),
        4
      ),

    medianMfeR:
      round(
        median(
          events.map(
            (x) =>
              x.mfeR
          )
        ),
        4
      ),

    medianMaeR:
      round(
        median(
          events.map(
            (x) =>
              x.maeR
          )
        ),
        4
      ),
  };
}

function csvEscape(v) {
  if (
    v === null ||
    v === undefined
  ) {
    return "";
  }

  const s =
    String(v);

  if (
    /[",\n]/.test(s)
  ) {
    return `"${s.replaceAll(
      '"',
      '""'
    )}"`;
  }

  return s;
}

function toCsv(
  rows
) {
  const headers = [
    "timestamp",
    "symbol",
    "direction",
    "decision",
    "finalScore",

    "radarScore",
    "directionScore",
    "structureScore",
    "flowScore",

    "entry",
    "stop",
    "tp1",
    "tp2",

    "rr1",
    "rr2",

    "structureStatus",

    "hardVeto",
    "hardVetoReasons",

    "outcome",
    "resultR",
    "mfeR",
    "maeR",

    "after15mPct",
    "after1hPct",
    "after4hPct",

    "tp2Hit",
  ];

  const lines = [
    headers.join(","),
  ];

  for (
    const row of rows
  ) {
    lines.push(
      headers
        .map(
          (h) =>
            csvEscape(
              row[h]
            )
        )
        .join(",")
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------
// REPLAY ONE SYMBOL
// ---------------------------------------------------------

async function replaySymbol(
  symbol,
  replayStart,
  replayEnd
) {
  console.log(
    `\n========== ${symbol} ==========\n`
  );

  // 5m needs only a few days of warm-up:
  // radar 24h volume + 1h structure aggregation.
  const fiveStart =
    replayStart -
    3 * DAY;

  // HTF warm-up intentionally predates replay window.
  const fourStart =
    replayStart -
    15 * DAY;

  const twelveStart =
    replayStart -
    25 * DAY;

  const dailyStart =
    replayStart -
    50 * DAY;

  const fiveRaw =
    await fetchKlines(
      symbol,
      "5m",
      fiveStart,
      replayEnd
    );

  const four =
    await fetchKlines(
      symbol,
      "4h",
      fourStart,
      replayEnd
    );

  const twelve =
    await fetchKlines(
      symbol,
      "12h",
      twelveStart,
      replayEnd
    );

  const daily =
    await fetchKlines(
      symbol,
      "1d",
      dailyStart,
      replayEnd
    );

  const five =
    addVolumeState(
      fiveRaw
    );

  const fifteen =
    aggregateCandles(
      five,
      15
    );

  const hourly =
    aggregateCandles(
      five,
      60
    );

  console.log(
    `[READY] ${symbol} 5m=${five.length} 15m=${fifteen.length} 1h=${hourly.length} 4h=${four.length} 12h=${twelve.length} 1d=${daily.length}`
  );

  const replayBars =
    fifteen.filter(
      (x) =>
        x.closeTime >=
          replayStart &&
        x.closeTime <=
          replayEnd
    );

  const events = [];

  const lastSignal =
    new Map();

  let radarCandidateCount =
    0;

  const decisions = {
    PASS: 0,
    WATCH: 0,
    STARTER: 0,
    CONFIRMED: 0,
  };

  for (
    let index = 0;
    index <
      replayBars.length;
    index++
  ) {
    const bar =
      replayBars[index];

    // Replay every requested number of minutes.
    const stepBars =
      Math.max(
        1,
        CONFIG.replayStepMinutes /
          15
      );

    if (
      index %
        stepBars !==
      0
    ) {
      continue;
    }

    const t =
      bar.closeTime;

    const c5 =
      sliceUntil(
        five,
        t,
        320
      );

    const c15 =
      sliceUntil(
        fifteen,
        t,
        140
      );

    const c1h =
      sliceUntil(
        hourly,
        t,
        140
      );

    const c4h =
      sliceUntil(
        four,
        t,
        140
      );

    const c12h =
      sliceUntil(
        twelve,
        t,
        110
      );

    const c1d =
      sliceUntil(
        daily,
        t,
        110
      );

    const latest5 =
      c5.at(-1);

    if (!latest5) {
      continue;
    }

    const hints =
      radarStructureHints(
        c15
      );

    const snapshots =
      c5.map(
        (x) => ({
          ts:
            x.closeTime,

          price:
            x.close,

          // Cumulative counter is used to measure
          // actual incremental 5m/15m flow.
          quoteVolume24h:
            x.cumulativeQuote,
        })
      );

    const result =
      runV4CleanCore({
        symbol,

        nowTs:
          t,

        currentPrice:
          latest5.close,

        snapshots,

        priceSnapshots:
          snapshots,

        quoteVolume24h:
          latest5
            .quoteVolume24h,

        spreadPct:
          null,

        compressionRatio:
          hints
            .compressionRatio,

        distanceToBreakoutPct:
          hints
            .distanceToBreakoutPct,

        candles15m:
          c15,

        candles1h:
          c1h,

        candles4h:
          c4h,

        candles12h:
          c12h,

        candles1d:
          c1d,

        // Historical derivatives data is
        // intentionally NOT fabricated.
        spotCvd: [],
        futuresCvd: [],
        openInterest: [],
        liquidations: [],
        fundingRate:
          null,
      });

    const radar =
      result?.pipeline?.radar ??
      {};

    const direction =
      result?.pipeline?.direction ??
      {};

    const structure =
      result?.pipeline?.structure ??
      {};

    const flow =
      result?.pipeline?.flow ??
      {};

    const execution =
      result?.pipeline?.execution ??
      {};

    const decision =
      String(
        execution?.decision ??
        "PASS"
      );

    if (
      decisions[decision] !==
      undefined
    ) {
      decisions[
        decision
      ]++;
    }

    if (
      Number(
        radar?.score
      ) >= 5.5
    ) {
      radarCandidateCount++;
    }

    if (
      decision !==
        "STARTER" &&
      decision !==
        "CONFIRMED"
    ) {
      continue;
    }

    const tradeDirection =
      String(
        execution?.direction ??
        result
          ?.selectedDirection ??
        "NEUTRAL"
      );

    if (
      tradeDirection !==
        "LONG" &&
      tradeDirection !==
        "SHORT"
    ) {
      continue;
    }

    const key =
      `${symbol}:${tradeDirection}`;

    const previous =
      lastSignal.get(key);

    if (
      previous &&
      t -
        previous <
        CONFIG
          .signalCooldownHours *
          HOUR
    ) {
      continue;
    }

    lastSignal.set(
      key,
      t
    );

    const event = {
      timestamp:
        iso(t),

      timestampMs:
        t,

      symbol,

      direction:
        tradeDirection,

      decision,

      finalScore:
        round(
          execution
            ?.finalScore,
          4
        ),

      radarScore:
        round(
          radar?.score,
          4
        ),

      directionScore:
        round(
          direction?.score,
          4
        ),

      structureScore:
        round(
          structure?.score,
          4
        ),

      flowScore:
        round(
          flow?.score,
          4
        ),

      entry:
        num(
          execution?.entry
        ),

      stop:
        num(
          execution?.stop
        ),

      tp1:
        num(
          execution?.tp1
        ),

      tp2:
        num(
          execution?.tp2
        ),

      rr1:
        num(
          execution?.rr
            ?.tp1
        ),

      rr2:
        num(
          execution?.rr
            ?.tp2
        ),

      structureStatus:
        structure?.status ??
        null,

      hardVeto:
        execution
          ?.hardVeto ===
        true,

      hardVetoReasons:
        (
          execution
            ?.hardVetoReasons ??
          []
        ).join("|"),
    };

    const outcome =
      evaluateOutcome(
        event,
        five
      );

    Object.assign(
      event,
      outcome
    );

    events.push(
      event
    );

    console.log(
      `[SIGNAL] ${event.timestamp} ${symbol} ${tradeDirection} ${decision} score=${event.finalScore} R=${event.resultR}`
    );
  }

  return {
    symbol,

    data: {
      bars5m:
        five.length,

      bars15m:
        fifteen.length,

      bars1h:
        hourly.length,

      bars4h:
        four.length,

      bars12h:
        twelve.length,

      bars1d:
        daily.length,
    },

    funnel: {
      replayPoints:
        replayBars.length,

      radarCandidates:
        radarCandidateCount,

      decisions,
    },

    events,

    stats:
      stats(events),
  };
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------

async function main() {
  console.log(
    "=========================================="
  );

  console.log(
    "V4 CLEAN CORE — TIBERIUS REPLAY LAB"
  );

  console.log(
    "HISTORICAL ONLY — NO ORDER EXECUTION"
  );

  console.log(
    "=========================================="
  );

  const now =
    Date.now();

  // Avoid the currently forming market candle.
  const replayEnd =
    now -
    20 * MINUTE;

  const replayStart =
    replayEnd -
    CONFIG.replayDays *
      DAY;

  console.log(
    `Version: ${VERSION}`
  );

  console.log(
    `Symbols: ${CONFIG.symbols.join(", ")}`
  );

  console.log(
    `Replay: ${iso(replayStart)} -> ${iso(replayEnd)}`
  );

  console.log(
    `Step: ${CONFIG.replayStepMinutes}m`
  );

  console.log(
    `Outcome horizon: ${CONFIG.outcomeHours}h`
  );

  const symbolResults =
    [];

  for (
    const symbol of
      CONFIG.symbols
  ) {
    try {
      const result =
        await replaySymbol(
          symbol,
          replayStart,
          replayEnd
        );

      symbolResults.push(
        result
      );
    } catch (error) {
      console.error(
        `[FAILED] ${symbol}:`,
        error
      );

      symbolResults.push({
        symbol,

        error:
          String(
            error?.message ??
            error
          ),

        events: [],

        stats:
          stats([]),
      });
    }
  }

  const allEvents =
    symbolResults
      .flatMap(
        (x) =>
          x.events ?? []
      )
      .sort(
        (a, b) =>
          a.timestampMs -
          b.timestampMs
      );

  const summary = {
    version:
      VERSION,

    generatedAt:
      new Date()
        .toISOString(),

    mode:
      "HISTORICAL_REPLAY_ONLY",

    safety: {
      scannerEnabled:
        false,

      paperOrdersEnabled:
        false,

      realOrdersEnabled:
        false,

      orderEndpointsUsed:
        false,
    },

    config:
      CONFIG,

    replayWindow: {
      start:
        iso(
          replayStart
        ),

      end:
        iso(
          replayEnd
        ),
    },

    limitations: [
      "Initial replay uses 5m base data; dedicated XRP/ZEC 1m regression comes later.",
      "Historical Spot CVD, Futures CVD, OI, funding and liquidation series are not fabricated; FLOW therefore remains neutral/partial when unavailable.",
      "Outcome uses conservative same-candle ordering: if stop and target are both touched, stop is counted first.",
      "Replay performance is backtest/replay evidence, not live or PAPER profit.",
    ],

    total:
      stats(
        allEvents
      ),

    bySymbol:
      Object.fromEntries(
        symbolResults.map(
          (x) => [
            x.symbol,
            {
              stats:
                x.stats,

              funnel:
                x.funnel ??
                null,

              data:
                x.data ??
                null,

              error:
                x.error ??
                null,
            },
          ]
        )
      ),
  };

  await mkdir(
    "artifacts",
    {
      recursive: true,
    }
  );

  await writeFile(
    "artifacts/v4_replay_summary.json",
    JSON.stringify(
      summary,
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    "artifacts/v4_replay_signals.json",
    JSON.stringify(
      allEvents,
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    "artifacts/v4_replay_signals.csv",
    toCsv(
      allEvents
    ),
    "utf8"
  );

  console.log(
    "\n=========================================="
  );

  console.log(
    "V4 REPLAY COMPLETE"
  );

  console.log(
    JSON.stringify(
      summary.total,
      null,
      2
    )
  );

  console.log(
    "Artifacts:"
  );

  console.log(
    "- artifacts/v4_replay_summary.json"
  );

  console.log(
    "- artifacts/v4_replay_signals.json"
  );

  console.log(
    "- artifacts/v4_replay_signals.csv"
  );

  console.log(
    "==========================================\n"
  );
}

main().catch(
  (error) => {
    console.error(
      "V4 REPLAY FATAL:",
      error
    );

    process.exitCode = 1;
  }
);
