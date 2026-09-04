// BingX V4 Clean Core — DIRECTION
// Role owner: EMRE / HTF DIRECTION
// Pure scoring module: same logic for LIVE SCAN + REPLAY.
// TEST / PAPER ONLY.
//
// Purpose:
// 1D + 12H + 4H trend/structure/momentum/Fib context
// Most disagreement = SCORE PENALTY.
// Only clear HTF structural invalidation = HARD VETO.

export const V4_DIRECTION_VERSION = "V4_DIRECTION_1";

export const V4_DIRECTION_CFG = {
  minCandles4h: 60,
  minCandles12h: 45,
  minCandles1d: 45,

  strongDirectionScore: 7.0,
  usableDirectionScore: 5.5,

  // Fib is context, not a standalone signal.
  fibIdealMin: 0.382,
  fibIdealMax: 0.786,

  // Hard veto requires genuine HTF contradiction,
  // not merely one weak indicator.
  hardVetoOppositeScore: 7.5,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Number.isFinite(v)
    ? Math.round(v * 100) / 100
    : null;
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      time: Number(
        x?.time ??
        x?.openTime ??
        x?.ts ??
        0
      ),
      open: Number(x?.open),
      high: Number(x?.high),
      low: Number(x?.low),
      close: Number(x?.close),
      volume: Number(x?.volume ?? 0),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.time) &&
        x.time > 0 &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close) &&
        x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  const rows = Array.isArray(values)
    ? values.filter(Number.isFinite)
    : [];

  if (rows.length < period) return null;

  const k = 2 / (period + 1);
  let out =
    rows.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < rows.length; i++) {
    out = rows[i] * k + out * (1 - k);
  }

  return out;
}

function rsi(values, period = 14) {
  const rows = Array.isArray(values)
    ? values.filter(Number.isFinite)
    : [];

  if (rows.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = rows[i] - rows[i - 1];

    if (d >= 0) gain += d;
    else loss -= d;
  }

  gain /= period;
  loss /= period;

  for (let i = period + 1; i < rows.length; i++) {
    const d = rows[i] - rows[i - 1];

    gain =
      (gain * (period - 1) + Math.max(d, 0)) /
      period;

    loss =
      (loss * (period - 1) + Math.max(-d, 0)) /
      period;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;

  return 100 - 100 / (1 + rs);
}

function trueRange(rows, index) {
  const row = rows[index];

  if (index === 0) {
    return row.high - row.low;
  }

  const prevClose = rows[index - 1].close;

  return Math.max(
    row.high - row.low,
    Math.abs(row.high - prevClose),
    Math.abs(row.low - prevClose)
  );
}

function atr(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) {
    return null;
  }

  const values = [];

  for (
    let i = rows.length - period;
    i < rows.length;
    i++
  ) {
    values.push(trueRange(rows, i));
  }

  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  );
}

function swingPoints(rows, kind, wing = 2) {
  const out = [];

  for (
    let i = wing;
    i < rows.length - wing;
    i++
  ) {
    const value =
      kind === "HIGH"
        ? rows[i].high
        : rows[i].low;

    let valid = true;

    for (
      let j = i - wing;
      j <= i + wing;
      j++
    ) {
      if (j === i) continue;

      const other =
        kind === "HIGH"
          ? rows[j].high
          : rows[j].low;

      if (
        kind === "HIGH"
          ? other > value
          : other < value
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      out.push({
        index: i,
        price: value,
        time: rows[i].time,
      });
    }
  }

  return out;
}

function structureState(rows) {
  const sample = rows.slice(-80);

  const highs = swingPoints(
    sample,
    "HIGH",
    2
  ).slice(-3);

  const lows = swingPoints(
    sample,
    "LOW",
    2
  ).slice(-3);

  let longScore = 0;
  let shortScore = 0;

  const reasonsLong = [];
  const reasonsShort = [];

  if (highs.length >= 2) {
    const a = highs.at(-2).price;
    const b = highs.at(-1).price;

    if (b > a) {
      longScore += 1;
      reasonsLong.push("higher swing high");
    }

    if (b < a) {
      shortScore += 1;
      reasonsShort.push("lower swing high");
    }
  }

  if (lows.length >= 2) {
    const a = lows.at(-2).price;
    const b = lows.at(-1).price;

    if (b > a) {
      longScore += 1;
      reasonsLong.push("higher swing low");
    }

    if (b < a) {
      shortScore += 1;
      reasonsShort.push("lower swing low");
    }
  }

  return {
    longScore,
    shortScore,
    reasonsLong,
    reasonsShort,
    lastSwingHigh:
      highs.at(-1)?.price ?? null,
    lastSwingLow:
      lows.at(-1)?.price ?? null,
  };
}

function trendState(rows) {
  const closes = rows.map((x) => x.close);
  const last = closes.at(-1);

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);

  let longScore = 0;
  let shortScore = 0;

  const reasonsLong = [];
  const reasonsShort = [];

  if (
    last !== null &&
    e20 !== null &&
    last > e20
  ) {
    longScore += 0.75;
    reasonsLong.push("price > EMA20");
  }

  if (
    last !== null &&
    e20 !== null &&
    last < e20
  ) {
    shortScore += 0.75;
    reasonsShort.push("price < EMA20");
  }

  if (
    e20 !== null &&
    e50 !== null &&
    e20 > e50
  ) {
    longScore += 0.75;
    reasonsLong.push("EMA20 > EMA50");
  }

  if (
    e20 !== null &&
    e50 !== null &&
    e20 < e50
  ) {
    shortScore += 0.75;
    reasonsShort.push("EMA20 < EMA50");
  }

  if (
    e50 !== null &&
    e100 !== null &&
    e50 > e100
  ) {
    longScore += 0.50;
    reasonsLong.push("EMA50 > EMA100");
  }

  if (
    e50 !== null &&
    e100 !== null &&
    e50 < e100
  ) {
    shortScore += 0.50;
    reasonsShort.push("EMA50 < EMA100");
  }

  return {
    longScore,
    shortScore,
    reasonsLong,
    reasonsShort,
    ema20: round2(e20),
    ema50: round2(e50),
    ema100: round2(e100),
  };
}

function momentumState(rows) {
  const closes = rows.map((x) => x.close);
  const value = rsi(closes, 14);

  let longScore = 0;
  let shortScore = 0;

  const reasonsLong = [];
  const reasonsShort = [];

  if (value !== null) {
    // Healthy momentum, not overbought chasing.
    if (value >= 50 && value <= 72) {
      longScore += 0.75;
      reasonsLong.push(`RSI ${round2(value)}`);
    }

    if (value >= 28 && value <= 50) {
      shortScore += 0.75;
      reasonsShort.push(`RSI ${round2(value)}`);
    }

    if (value > 72) {
      longScore -= 0.20;
    }

    if (value < 28) {
      shortScore -= 0.20;
    }
  }

  return {
    longScore,
    shortScore,
    reasonsLong,
    reasonsShort,
    rsi: round2(value),
  };
}

function fibContext(rows, direction) {
  const sample = rows.slice(-60);

  if (sample.length < 20) {
    return {
      valid: false,
      score: 0,
      retracement: null,
      label: "NO_FIB_CONTEXT",
    };
  }

  const current = sample.at(-1).close;

  let highIndex = 0;
  let lowIndex = 0;

  for (let i = 1; i < sample.length; i++) {
    if (sample[i].high > sample[highIndex].high) {
      highIndex = i;
    }

    if (sample[i].low < sample[lowIndex].low) {
      lowIndex = i;
    }
  }

  const high = sample[highIndex].high;
  const low = sample[lowIndex].low;

  const range = high - low;

  if (!(range > 0)) {
    return {
      valid: false,
      score: 0,
      retracement: null,
      label: "NO_RANGE",
    };
  }

  let retracement = null;

  if (
    direction === "LONG" &&
    lowIndex < highIndex
  ) {
    retracement =
      (high - current) / range;
  }

  if (
    direction === "SHORT" &&
    highIndex < lowIndex
  ) {
    retracement =
      (current - low) / range;
  }

  if (
    retracement === null ||
    !Number.isFinite(retracement)
  ) {
    return {
      valid: false,
      score: 0,
      retracement: null,
      label: "NO_CLEAR_IMPULSE",
    };
  }

  let score = 0;
  let label = "OUTSIDE_IDEAL";

  if (
    retracement >=
      V4_DIRECTION_CFG.fibIdealMin &&
    retracement <=
      V4_DIRECTION_CFG.fibIdealMax
  ) {
    score = 1;
    label = "FIB_VALUE_ZONE";
  } else if (
    retracement >= 0.236 &&
    retracement <= 0.886
  ) {
    score = 0.5;
    label = "FIB_CONTEXT_OK";
  }

  return {
    valid: true,
    score,
    retracement: round2(retracement),
    label,
    impulseHigh: round2(high),
    impulseLow: round2(low),
  };
}

function timeframeScore(rows, weight = 1) {
  if (!rows.length) {
    return {
      longScore: 0,
      shortScore: 0,
      longReasons: [],
      shortReasons: [],
    };
  }

  const trend = trendState(rows);
  const structure = structureState(rows);
  const momentum = momentumState(rows);

  const rawLong =
    trend.longScore +
    structure.longScore +
    momentum.longScore;

  const rawShort =
    trend.shortScore +
    structure.shortScore +
    momentum.shortScore;

  return {
    longScore: rawLong * weight,
    shortScore: rawShort * weight,

    longReasons: [
      ...trend.reasonsLong,
      ...structure.reasonsLong,
      ...momentum.reasonsLong,
    ],

    shortReasons: [
      ...trend.reasonsShort,
      ...structure.reasonsShort,
      ...momentum.reasonsShort,
    ],

    rsi: momentum.rsi,
    atr: round2(atr(rows, 14)),
    lastSwingHigh: structure.lastSwingHigh,
    lastSwingLow: structure.lastSwingLow,
  };
}

function structuralInvalidation(
  direction,
  daily,
  h12
) {
  const lastDaily = daily.at(-1)?.close;
  const last12 = h12.at(-1)?.close;

  const d = structureState(daily);
  const h = structureState(h12);

  if (direction === "LONG") {
    const dailyBroken =
      lastDaily !== undefined &&
      d.lastSwingLow !== null &&
      lastDaily < d.lastSwingLow;

    const h12Broken =
      last12 !== undefined &&
      h.lastSwingLow !== null &&
      last12 < h.lastSwingLow;

    return dailyBroken && h12Broken;
  }

  if (direction === "SHORT") {
    const dailyBroken =
      lastDaily !== undefined &&
      d.lastSwingHigh !== null &&
      lastDaily > d.lastSwingHigh;

    const h12Broken =
      last12 !== undefined &&
      h.lastSwingHigh !== null &&
      last12 > h.lastSwingHigh;

    return dailyBroken && h12Broken;
  }

  return false;
}

export function analyzeV4Direction(input = {}) {
  const symbol = String(
    input?.symbol || ""
  ).toUpperCase();

  const h4 = normalizeCandles(
    input?.candles4h
  );

  const h12 = normalizeCandles(
    input?.candles12h
  );

  const d1 = normalizeCandles(
    input?.candles1d
  );

  const radarDirection = String(
    input?.radarDirection || "NEUTRAL"
  ).toUpperCase();

  const enoughData =
    h4.length >=
      V4_DIRECTION_CFG.minCandles4h &&
    h12.length >=
      V4_DIRECTION_CFG.minCandles12h &&
    d1.length >=
      V4_DIRECTION_CFG.minCandles1d;

  if (!enoughData) {
    return {
      version: V4_DIRECTION_VERSION,
      symbol,
      status: "INSUFFICIENT_DATA",
      direction: "NEUTRAL",
      score: 0,
      hardVeto: false,
      hardVetoReason: null,
      tradePermission: false,
    };
  }

  // Higher timeframe gets more influence.
  const daily = timeframeScore(d1, 1.45);
  const twelve = timeframeScore(h12, 1.20);
  const four = timeframeScore(h4, 0.85);

  let longScore =
    daily.longScore +
    twelve.longScore +
    four.longScore;

  let shortScore =
    daily.shortScore +
    twelve.shortScore +
    four.shortScore;

  const longFib = fibContext(h4, "LONG");
  const shortFib = fibContext(h4, "SHORT");

  longScore += longFib.score;
  shortScore += shortFib.score;

  // Normalize to 0-10 rather than allowing
  // an ever-growing indicator stack.
  longScore = clamp(
    (longScore / 9.0) * 10,
    0,
    10
  );

  shortScore = clamp(
    (shortScore / 9.0) * 10,
    0,
    10
  );

  let direction = "NEUTRAL";

  if (longScore >= shortScore + 0.75) {
    direction = "LONG";
  } else if (
    shortScore >= longScore + 0.75
  ) {
    direction = "SHORT";
  }

  const chosenScore =
    direction === "LONG"
      ? longScore
      : direction === "SHORT"
      ? shortScore
      : Math.max(longScore, shortScore);

  const oppositeScore =
    direction === "LONG"
      ? shortScore
      : direction === "SHORT"
      ? longScore
      : Math.max(longScore, shortScore);

  let hardVeto = false;
  let hardVetoReason = null;

  // Hard veto is only for a proposed radar direction
  // that is clearly broken on BOTH 1D and 12H structure.
  if (
    radarDirection === "LONG" ||
    radarDirection === "SHORT"
  ) {
    const radarInvalid =
      structuralInvalidation(
        radarDirection,
        d1,
        h12
      );

    const radarOppositeScore =
      radarDirection === "LONG"
        ? shortScore
        : longScore;

    if (
      radarInvalid &&
      radarOppositeScore >=
        V4_DIRECTION_CFG.hardVetoOppositeScore
    ) {
      hardVeto = true;
      hardVetoReason =
        "HTF_STRUCTURAL_INVALIDATION";
    }
  }

  let status = "MIXED";

  if (hardVeto) {
    status = "HTF_INVALID";
  } else if (
    chosenScore >=
    V4_DIRECTION_CFG.strongDirectionScore
  ) {
    status = "STRONG_DIRECTION";
  } else if (
    chosenScore >=
    V4_DIRECTION_CFG.usableDirectionScore
  ) {
    status = "USABLE_DIRECTION";
  }

  const radarAligned =
    radarDirection === "NEUTRAL" ||
    direction === "NEUTRAL" ||
    radarDirection === direction;

  const reasons =
    direction === "LONG"
      ? [
          ...daily.longReasons.slice(0, 3),
          ...twelve.longReasons.slice(0, 3),
          ...four.longReasons.slice(0, 2),
          longFib.label,
        ]
      : direction === "SHORT"
      ? [
          ...daily.shortReasons.slice(0, 3),
          ...twelve.shortReasons.slice(0, 3),
          ...four.shortReasons.slice(0, 2),
          shortFib.label,
        ]
      : ["HTF mixed / no clear edge"];

  return {
    version: V4_DIRECTION_VERSION,
    symbol,

    direction,
    score: round2(chosenScore),

    longScore: round2(longScore),
    shortScore: round2(shortScore),
    oppositeScore: round2(oppositeScore),

    status,

    radarDirection,
    radarAligned,

    hardVeto,
    hardVetoReason,

    timeframes: {
      d1: {
        longScore: round2(daily.longScore),
        shortScore: round2(daily.shortScore),
        rsi: daily.rsi,
      },

      h12: {
        longScore: round2(twelve.longScore),
        shortScore: round2(twelve.shortScore),
        rsi: twelve.rsi,
      },

      h4: {
        longScore: round2(four.longScore),
        shortScore: round2(four.shortScore),
        rsi: four.rsi,
      },
    },

    fib: {
      long: longFib,
      short: shortFib,
    },

    reasons: [...new Set(reasons)],

    // Direction is context, never permission to trade.
    tradePermission: false,
  };
}
