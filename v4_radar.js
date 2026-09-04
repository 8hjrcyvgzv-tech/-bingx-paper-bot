// BingX V4 Clean Core — RADAR
// Role owner: BELIT / EARLY MOVE
// Pure scoring module: same logic for LIVE SCAN + REPLAY.
// TEST / PAPER ONLY.

export const V4_RADAR_VERSION = "V4_RADAR_1";

export const V4_RADAR_CFG = {
  // These are bootstrap values.
  // They must be calibrated by Replay Lab, not by hindsight.
  minQuoteVolumeUSDT: 1_500_000,
  maxSpreadPct: 0.45,

  candidateScore: 5.5,
  strongScore: 7.0,
  eliteScore: 8.25,

  breakoutNearPct: 2.0,
  breakoutVeryNearPct: 1.0,

  // Persistent move horizons
  horizonsMin: [1, 5, 15, 60],
};

const CORE5 = new Set([
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function pct(from, to) {
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

function sortSnapshots(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      ts: Number(x?.ts ?? x?.time ?? 0),
      price: Number(x?.price ?? x?.lastPrice ?? 0),
      quoteVolume24h: Number(
        x?.quoteVolume24h ?? x?.quoteVolume ?? 0
      ),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.ts > 0 &&
        Number.isFinite(x.price) &&
        x.price > 0
    )
    .sort((a, b) => a.ts - b.ts);
}

function nearestBefore(rows, targetTs) {
  let out = null;

  for (const row of rows) {
    if (row.ts <= targetTs) out = row;
    else break;
  }

  return out;
}

function horizonReturn(rows, nowTs, minutes) {
  const latest = rows.at(-1);
  if (!latest) return null;

  const past = nearestBefore(
    rows,
    nowTs - minutes * 60 * 1000
  );

  if (!past) return null;

  return pct(past.price, latest.price);
}

function volumeFlow(rows, nowTs, minutes) {
  const latest = rows.at(-1);
  if (!latest || !(latest.quoteVolume24h >= 0)) return null;

  const past = nearestBefore(
    rows,
    nowTs - minutes * 60 * 1000
  );

  if (!past || !(past.quoteVolume24h >= 0)) return null;

  // 24h rolling quote volume can occasionally decrease.
  // Negative flow is therefore treated as unknown/zero, not selling.
  return Math.max(
    0,
    latest.quoteVolume24h - past.quoteVolume24h
  );
}

function momentumDirection(r1, r5, r15, r60) {
  const weighted =
    (num(r1) ?? 0) * 0.10 +
    (num(r5) ?? 0) * 0.20 +
    (num(r15) ?? 0) * 0.30 +
    (num(r60) ?? 0) * 0.40;

  if (weighted >= 0.10) return "LONG";
  if (weighted <= -0.10) return "SHORT";
  return "NEUTRAL";
}

function signAligned(value, direction) {
  if (!Number.isFinite(value)) return false;
  if (direction === "LONG") return value > 0;
  if (direction === "SHORT") return value < 0;
  return false;
}

function persistentMomentumScore(
  direction,
  r1,
  r5,
  r15,
  r60
) {
  if (direction === "NEUTRAL") {
    return { score: 0, alignedCount: 0 };
  }

  const values = [r1, r5, r15, r60];
  const alignedCount = values.filter((v) =>
    signAligned(v, direction)
  ).length;

  let score = 0;

  // Consistency matters more than a single violent 1m candle.
  if (alignedCount === 4) score += 2.0;
  else if (alignedCount === 3) score += 1.4;
  else if (alignedCount === 2) score += 0.7;

  const a5 = Math.abs(num(r5) ?? 0);
  const a15 = Math.abs(num(r15) ?? 0);
  const a60 = Math.abs(num(r60) ?? 0);

  if (a5 >= 0.25) score += 0.35;
  if (a5 >= 0.60) score += 0.35;

  if (a15 >= 0.50) score += 0.45;
  if (a15 >= 1.00) score += 0.45;

  if (a60 >= 1.00) score += 0.40;
  if (a60 >= 2.00) score += 0.40;

  return {
    score: clamp(score, 0, 4),
    alignedCount,
  };
}

function flowScore(flow5m, flow15m) {
  if (!(flow5m >= 0) || !(flow15m >= 0)) {
    return {
      score: 0,
      acceleration: null,
      recentPerMin: null,
      baselinePerMin: null,
    };
  }

  const recentPerMin = flow5m / 5;

  const prior10mFlow = Math.max(0, flow15m - flow5m);
  const baselinePerMin = prior10mFlow / 10;

  const acceleration =
    baselinePerMin > 0
      ? recentPerMin / baselinePerMin
      : recentPerMin > 0
      ? 2
      : 0;

  let score = 0;

  if (acceleration >= 1.25) score += 0.5;
  if (acceleration >= 1.75) score += 0.5;
  if (acceleration >= 2.5) score += 0.5;

  if (flow5m >= 25_000) score += 0.35;
  if (flow5m >= 75_000) score += 0.35;
  if (flow5m >= 200_000) score += 0.30;

  return {
    score: clamp(score, 0, 2.5),
    acceleration: round2(acceleration),
    recentPerMin: Math.round(recentPerMin),
    baselinePerMin: Math.round(baselinePerMin),
  };
}

function structureReadinessScore(input) {
  let score = 0;
  const reasons = [];

  const compressionRatio = num(input?.compressionRatio);
  const distancePct = Math.abs(
    num(input?.distanceToBreakoutPct) ?? 999
  );

  if (
    compressionRatio !== null &&
    compressionRatio <= 0.85
  ) {
    score += 0.75;
    reasons.push("compression");
  }

  if (
    compressionRatio !== null &&
    compressionRatio <= 0.70
  ) {
    score += 0.25;
  }

  if (distancePct <= V4_RADAR_CFG.breakoutNearPct) {
    score += 0.5;
    reasons.push("near boundary");
  }

  if (distancePct <= V4_RADAR_CFG.breakoutVeryNearPct) {
    score += 0.5;
    reasons.push("very near boundary");
  }

  return {
    score: clamp(score, 0, 2),
    reasons,
  };
}

function liquidityScore(input) {
  const qv = num(input?.quoteVolume24h) ?? 0;
  const spread = num(input?.spreadPct);

  let score = 0;

  if (qv >= 5_000_000) score += 0.25;
  if (qv >= 20_000_000) score += 0.25;

  if (spread !== null && spread <= 0.20) score += 0.25;
  if (spread !== null && spread <= 0.10) score += 0.25;

  return clamp(score, 0, 1);
}

export function analyzeV4Radar(input = {}) {
  const symbol = String(input?.symbol || "").toUpperCase();
  const rows = sortSnapshots(input?.snapshots);

  const latest = rows.at(-1);
  const nowTs =
    Number(input?.nowTs) ||
    latest?.ts ||
    Date.now();

  const qv =
    num(input?.quoteVolume24h) ??
    latest?.quoteVolume24h ??
    0;

  const spreadPct = num(input?.spreadPct);

  // Eligibility is not a trade veto.
  // It only protects the scanner from unusable markets.
  const eligible =
    symbol.endsWith("-USDT") &&
    qv >= V4_RADAR_CFG.minQuoteVolumeUSDT &&
    (spreadPct === null ||
      spreadPct <= V4_RADAR_CFG.maxSpreadPct);

  const r1 = horizonReturn(rows, nowTs, 1);
  const r5 = horizonReturn(rows, nowTs, 5);
  const r15 = horizonReturn(rows, nowTs, 15);
  const r60 = horizonReturn(rows, nowTs, 60);

  const direction = momentumDirection(
    r1,
    r5,
    r15,
    r60
  );

  const momentum = persistentMomentumScore(
    direction,
    r1,
    r5,
    r15,
    r60
  );

  const flow5m = volumeFlow(rows, nowTs, 5);
  const flow15m = volumeFlow(rows, nowTs, 15);
  const flow = flowScore(flow5m, flow15m);

  const structure = structureReadinessScore(input);
  const liquidity = liquidityScore({
    quoteVolume24h: qv,
    spreadPct,
  });

  let score =
    momentum.score +
    flow.score +
    structure.score +
    liquidity;

  // CORE5 gets visibility priority, not permission to trade.
  const isCore5 = CORE5.has(symbol);
  if (isCore5 && score >= 4) score += 0.25;

  score = round2(clamp(score, 0, 10));

  let status = "QUIET";

  if (eligible && score >= V4_RADAR_CFG.eliteScore) {
    status = "ELITE_RADAR";
  } else if (
    eligible &&
    score >= V4_RADAR_CFG.strongScore
  ) {
    status = "STRONG_RADAR";
  } else if (
    eligible &&
    score >= V4_RADAR_CFG.candidateScore
  ) {
    status = "RADAR_CANDIDATE";
  }

  const reasons = [];

  if (momentum.alignedCount >= 3) {
    reasons.push(
      `persistent ${direction.toLowerCase()} momentum`
    );
  }

  if (
    flow.acceleration !== null &&
    flow.acceleration >= 1.75
  ) {
    reasons.push(
      `volume acceleration ${flow.acceleration}x`
    );
  }

  reasons.push(...structure.reasons);

  if (isCore5) reasons.push("CORE5");

  return {
    version: V4_RADAR_VERSION,

    symbol,
    eligible,
    isCore5,

    direction,
    score,
    status,

    returns: {
      m1: round2(r1),
      m5: round2(r5),
      m15: round2(r15),
      m60: round2(r60),
    },

    momentum: {
      score: round2(momentum.score),
      alignedCount: momentum.alignedCount,
    },

    flow: {
      score: round2(flow.score),
      flow5mUsd:
        flow5m === null ? null : Math.round(flow5m),
      flow15mUsd:
        flow15m === null ? null : Math.round(flow15m),
      acceleration: flow.acceleration,
      recentPerMinUsd: flow.recentPerMin,
      baselinePerMinUsd: flow.baselinePerMin,
    },

    structureReadiness: {
      score: round2(structure.score),
      compressionRatio:
        num(input?.compressionRatio),
      distanceToBreakoutPct:
        num(input?.distanceToBreakoutPct),
    },

    liquidity: {
      score: round2(liquidity),
      quoteVolume24h: Math.round(qv),
      spreadPct,
    },

    reasons,

    // Radar is never permission to trade.
    tradePermission: false,
  };
}
