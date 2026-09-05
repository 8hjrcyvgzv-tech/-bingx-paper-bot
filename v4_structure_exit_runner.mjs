// V4 STRUCTURE-BASED EXIT + RUNNER
// RESEARCH / REPLAY ONLY
// NO PAPER ORDERS / NO LIVE ORDERS
//
// Purpose:
// - TP1 = first meaningful structure level in trade direction
// - TP2 = next meaningful structure level
// - Default position split = 60% / 30% / 10% runner
// - After TP1, remaining stop moves to breakeven (entry)
// - Runner has no fixed TP; it exits only on structure/trailing invalidation
//
// IMPORTANT:
// This module is intentionally pure. It does not place or modify exchange orders.

export const V4_STRUCTURE_EXIT_RUNNER_VERSION =
  "V4_STRUCTURE_EXIT_RUNNER_1";

export const V4_STRUCTURE_EXIT_RUNNER_CFG = {
  tp1Share: 0.60,
  tp2Share: 0.30,
  runnerShare: 0.10,

  // Ignore tiny/noisy structure levels.
  minTp1R: 1.00,

  // Swing detection.
  swingWing1h: 2,
  swingWing4h: 2,

  // Levels closer than this ATR fraction are grouped.
  levelClusterATR: 0.35,

  // Prefer levels that were tested more than once,
  // or any confirmed 4H swing level.
  min1hTouches: 2,

  // Runner trailing buffer.
  runnerAtrBuffer: 0.20,

  // Fallbacks only when valid structure targets are not available.
  fallbackTP1R: 1.80,
  fallbackTP2R: 2.80,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      time: Number(x?.time ?? x?.openTime ?? x?.ts ?? 0),
      open: Number(x?.open),
      high: Number(x?.high),
      low: Number(x?.low),
      close: Number(x?.close),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close) &&
        x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function trueRange(rows, i) {
  const r = rows[i];
  if (i === 0) return r.high - r.low;
  const pc = rows[i - 1].close;
  return Math.max(
    r.high - r.low,
    Math.abs(r.high - pc),
    Math.abs(r.low - pc)
  );
}

function atr(rows, period = 14) {
  const c = normalizeCandles(rows);
  if (c.length <= period) return null;

  const start = Math.max(1, c.length - period);
  const values = [];

  for (let i = start; i < c.length; i++) {
    values.push(trueRange(c, i));
  }

  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function swingPoints(rows, kind, wing = 2) {
  const c = normalizeCandles(rows);
  const out = [];

  for (let i = wing; i < c.length - wing; i++) {
    const value = kind === "HIGH" ? c[i].high : c[i].low;
    let ok = true;

    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      const other = kind === "HIGH" ? c[j].high : c[j].low;

      if (kind === "HIGH" ? other > value : other < value) {
        ok = false;
        break;
      }
    }

    if (ok) {
      out.push({
        time: c[i].time,
        price: value,
      });
    }
  }

  return out;
}

function clusterLevels(points, tolerance) {
  const sorted = [...points]
    .filter((x) => Number.isFinite(x?.price))
    .sort((a, b) => a.price - b.price);

  const clusters = [];

  for (const p of sorted) {
    const last = clusters.at(-1);

    if (
      last &&
      Math.abs(p.price - last.price) <= tolerance
    ) {
      last.members.push(p);
      last.price =
        last.members.reduce((s, x) => s + x.price, 0) /
        last.members.length;
      last.touches = last.members.length;
      last.time = Math.max(last.time, p.time);
    } else {
      clusters.push({
        price: p.price,
        touches: 1,
        time: p.time,
        members: [p],
      });
    }
  }

  return clusters;
}

function directionalR(direction, entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  const reward =
    direction === "LONG"
      ? target - entry
      : entry - target;

  return reward / risk;
}

function fallbackTarget(direction, entry, risk, multiple) {
  return direction === "LONG"
    ? entry + risk * multiple
    : entry - risk * multiple;
}

function collectMeaningfulLevels({
  direction,
  entry,
  candles1h,
  candles4h,
}) {
  const rows1h = normalizeCandles(candles1h);
  const rows4h = normalizeCandles(candles4h);

  const a1h =
    atr(rows1h, 14) ??
    atr(rows4h, 14) ??
    entry * 0.01;

  const tolerance =
    Math.max(
      a1h * V4_STRUCTURE_EXIT_RUNNER_CFG.levelClusterATR,
      entry * 0.001
    );

  const kind =
    direction === "LONG"
      ? "HIGH"
      : "LOW";

  const p1 = swingPoints(
    rows1h,
    kind,
    V4_STRUCTURE_EXIT_RUNNER_CFG.swingWing1h
  ).map((x) => ({ ...x, timeframe: "1H" }));

  const p4 = swingPoints(
    rows4h,
    kind,
    V4_STRUCTURE_EXIT_RUNNER_CFG.swingWing4h
  ).map((x) => ({ ...x, timeframe: "4H" }));

  const clusters = clusterLevels(
    [...p1, ...p4],
    tolerance
  );

  const meaningful = clusters.filter((c) => {
    const has4h =
      c.members.some((x) => x.timeframe === "4H");

    const oneHourTouches =
      c.members.filter((x) => x.timeframe === "1H").length;

    return (
      has4h ||
      oneHourTouches >=
        V4_STRUCTURE_EXIT_RUNNER_CFG.min1hTouches
    );
  });

  return meaningful
    .filter((x) =>
      direction === "LONG"
        ? x.price > entry
        : x.price < entry
    )
    .sort((a, b) =>
      direction === "LONG"
        ? a.price - b.price
        : b.price - a.price
    );
}

export function resolveStructureExitPlan(input = {}) {
  const direction = String(
    input?.direction || ""
  ).toUpperCase();

  const entry = num(input?.entry);
  const stop = num(input?.stop);

  if (
    !["LONG", "SHORT"].includes(direction) ||
    !(entry > 0) ||
    !(stop > 0)
  ) {
    return {
      valid: false,
      reason: "INVALID_DIRECTION_ENTRY_OR_STOP",
    };
  }

  const risk = Math.abs(entry - stop);

  if (!(risk > 0)) {
    return {
      valid: false,
      reason: "INVALID_RISK_DISTANCE",
    };
  }

  const levels = collectMeaningfulLevels({
    direction,
    entry,
    candles1h: input?.candles1h,
    candles4h: input?.candles4h,
  });

  const validLevels =
    levels.filter((x) => {
      const r = directionalR(
        direction,
        entry,
        stop,
        x.price
      );

      return (
        Number.isFinite(r) &&
        r >= V4_STRUCTURE_EXIT_RUNNER_CFG.minTp1R
      );
    });

  const tp1 =
    validLevels[0]?.price ??
    fallbackTarget(
      direction,
      entry,
      risk,
      V4_STRUCTURE_EXIT_RUNNER_CFG.fallbackTP1R
    );

  const tp2 =
    validLevels.find((x) =>
      direction === "LONG"
        ? x.price > tp1
        : x.price < tp1
    )?.price ??
    fallbackTarget(
      direction,
      entry,
      risk,
      V4_STRUCTURE_EXIT_RUNNER_CFG.fallbackTP2R
    );

  return {
    valid: true,
    version: V4_STRUCTURE_EXIT_RUNNER_VERSION,
    mode: "RESEARCH_REPLAY_ONLY",

    direction,
    entry: round(entry),
    initialStop: round(stop),

    tp1: round(tp1),
    tp2: round(tp2),

    rr1: round(
      directionalR(direction, entry, stop, tp1),
      4
    ),
    rr2: round(
      directionalR(direction, entry, stop, tp2),
      4
    ),

    allocation: {
      tp1: V4_STRUCTURE_EXIT_RUNNER_CFG.tp1Share,
      tp2: V4_STRUCTURE_EXIT_RUNNER_CFG.tp2Share,
      runner: V4_STRUCTURE_EXIT_RUNNER_CFG.runnerShare,
    },

    afterTp1: {
      remainingStop: round(entry),
      stopMode: "BREAKEVEN_ENTRY",
    },

    runner: {
      fixedTakeProfit: null,
      mode: "STRUCTURE_TRAIL",
      description:
        "No fixed TP. Trail behind confirmed structure; exit when structure/trend invalidates.",
    },

    targetSource: {
      tp1:
        validLevels[0]
          ? "STRUCTURE"
          : "R_FALLBACK",
      tp2:
        validLevels.find((x) =>
          direction === "LONG"
            ? x.price > tp1
            : x.price < tp1
        )
          ? "STRUCTURE"
          : "R_FALLBACK",
    },

    detectedLevels:
      validLevels.slice(0, 8).map((x) => ({
        price: round(x.price),
        touches: x.touches,
        time: x.time,
        timeframes: [
          ...new Set(
            x.members.map((m) => m.timeframe)
          ),
        ],
      })),

    safety: {
      placesOrders: false,
      modifiesOrders: false,
      paperEnabled: false,
      liveEnabled: false,
    },
  };
}

export function resolveRunnerTrailingStop(input = {}) {
  const direction = String(
    input?.direction || ""
  ).toUpperCase();

  const entry = num(input?.entry);
  const currentStop = num(input?.currentStop);
  const candles15m = normalizeCandles(
    input?.candles15m
  );

  if (
    !["LONG", "SHORT"].includes(direction) ||
    !(entry > 0) ||
    !candles15m.length
  ) {
    return currentStop ?? entry ?? null;
  }

  const a =
    atr(candles15m, 14) ??
    entry * 0.005;

  const buffer =
    a *
    V4_STRUCTURE_EXIT_RUNNER_CFG.runnerAtrBuffer;

  const sample = candles15m.slice(-12);

  let candidate;

  if (direction === "LONG") {
    const lows =
      swingPoints(sample, "LOW", 2);

    candidate =
      (lows.at(-1)?.price ??
        Math.min(...sample.map((x) => x.low))) -
      buffer;

    // Never move a LONG runner stop backwards.
    return round(
      Math.max(
        entry,
        currentStop ?? entry,
        candidate
      )
    );
  }

  const highs =
    swingPoints(sample, "HIGH", 2);

  candidate =
    (highs.at(-1)?.price ??
      Math.max(...sample.map((x) => x.high))) +
    buffer;

  // Never move a SHORT runner stop backwards.
  return round(
    Math.min(
      entry,
      currentStop ?? entry,
      candidate
    )
  );
}
