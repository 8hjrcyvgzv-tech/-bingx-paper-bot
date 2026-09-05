// V4 CLEAN CORE — ADAPTIVE RISK + LEVERAGE ENGINE V1
// RESEARCH / HISTORICAL SIMULATION ONLY
// NO SCANNER / NO PAPER / NO LIVE / NO ORDERS

export const VERSION = "V4_ADAPTIVE_RISK_LEVERAGE_1";
export const STARTING_EQUITY = 100;
export const FIVE_MIN_MS = 5 * 60 * 1000;

export const ADAPTIVE_POLICY = Object.freeze({
  strongRadarMin: 7.0,
  tiers: Object.freeze([
    Object.freeze({ name: "NORMAL", minQuality: 0, riskPctEquity: 0.25, leverage: 3 }),
    Object.freeze({ name: "STRONG", minQuality: 2, riskPctEquity: 0.50, leverage: 5 }),
    Object.freeze({ name: "VERY_STRONG", minQuality: 4, riskPctEquity: 0.75, leverage: 7 }),
    Object.freeze({ name: "ELITE", minQuality: 5, riskPctEquity: 1.00, leverage: 10 }),
  ]),
  maxConcurrent: 2,
  onePerSymbol: true,
  maxOpenRiskPctEquity: 1.50,
  maxMarginUtilizationPct: 70,
  minExecutableRiskPctEquity: 0.25,
});

export const FIXED_REFERENCE = Object.freeze({
  riskPctEquity: 0.50,
  leverage: 5,
  maxConcurrent: 2,
  onePerSymbol: true,
  maxMarginUtilizationPct: 100,
});

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function pct(a, b) {
  return b > 0 ? (a / b) * 100 : null;
}

export function riskFraction(event) {
  const entry = num(event?.entry);
  const stop = num(event?.stop);
  if (!(entry > 0) || !(stop > 0)) return null;
  const x = Math.abs(entry - stop) / entry;
  return x > 0 ? x : null;
}

export function scenarioR(event, scenario) {
  return num(event?.model?.costScenarios?.[scenario]?.netResultR);
}

export function eventCloseTs(event) {
  const start = num(event?.timestampMs);
  const bars = num(event?.model?.barsHeld);
  if (!Number.isFinite(start)) return null;
  const boundedBars = Number.isFinite(bars) ? Math.max(1, Math.min(288, bars)) : 288;
  return start + boundedBars * FIVE_MIN_MS;
}

export function qualityBreakdown(event) {
  const radarScore = num(event?.radarScore) ?? 0;
  const status = String(event?.structureStatus || "UNKNOWN").toUpperCase();
  const targetSource = event?.structurePlan?.targetSource || {};

  let radarPoints = 0;
  if (radarScore >= 8.0) radarPoints = 2;
  else if (radarScore >= 7.5) radarPoints = 1;

  const structureTargetPoints =
    (String(targetSource?.tp1 || "") === "STRUCTURE" ? 1 : 0) +
    (String(targetSource?.tp2 || "") === "STRUCTURE" ? 1 : 0);

  const matureStatuses = new Set(["ARMED", "BREAKOUT", "RETEST"]);
  const structureStatePoints = matureStatuses.has(status) ? 1 : 0;

  return {
    radarScore,
    radarPoints,
    structureStatus: status,
    structureTargetPoints,
    structureStatePoints,
    quality: radarPoints + structureTargetPoints + structureStatePoints,
  };
}

export function desiredTier(event) {
  const q = qualityBreakdown(event);
  let tier = ADAPTIVE_POLICY.tiers[0];
  for (const candidate of ADAPTIVE_POLICY.tiers) {
    if (q.quality >= candidate.minQuality) tier = candidate;
  }
  return { ...tier, quality: q };
}

function maxDrawdownPct(points) {
  let peak = STARTING_EQUITY;
  let maxDd = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - point.equity) / peak) * 100);
  }
  return maxDd;
}

function flushClosed(active, untilTs, state) {
  const due = active
    .filter((x) => x.closeTs <= untilTs)
    .sort((a, b) => a.closeTs - b.closeTs || a.seq - b.seq);
  if (!due.length) return active;

  const dueIds = new Set(due.map((x) => x.id));
  for (const pos of due) {
    state.equity += pos.pnlUsd;
    state.realizedTrades += 1;
    state.equityPoints.push({ ts: pos.closeTs, equity: state.equity });
    if (pos.pnlUsd > 0) state.wins += 1;
    else if (pos.pnlUsd < 0) state.losses += 1;
  }
  return active.filter((x) => !dueIds.has(x.id));
}

function emptyTierStats() {
  return Object.fromEntries(ADAPTIVE_POLICY.tiers.map((t) => [t.name, {
    considered: 0,
    taken: 0,
    wins: 0,
    losses: 0,
    pnlUsd: 0,
    actualRiskPctSum: 0,
    leverageSum: 0,
  }]));
}

export function simulateAdaptive(events, scenario) {
  const ordered = [...events]
    .filter((e) => Number.isFinite(num(e?.timestampMs)))
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  const state = {
    equity: STARTING_EQUITY,
    equityPoints: [{ ts: ordered[0]?.timestampMs ?? 0, equity: STARTING_EQUITY }],
    wins: 0,
    losses: 0,
    realizedTrades: 0,
  };

  let active = [];
  let taken = 0;
  let skipConcurrent = 0;
  let skipSameSymbol = 0;
  let skipMargin = 0;
  let skipRiskCap = 0;
  let skipInvalid = 0;
  let maxMarginUtilizationPct = 0;
  let maxOpenRiskPctObserved = 0;
  let maxConcurrentObserved = 0;
  let seq = 0;
  const tierStats = emptyTierStats();

  for (const event of ordered) {
    const ts = num(event.timestampMs);
    active = flushClosed(active, ts, state);

    const resultR = scenarioR(event, scenario);
    const rf = riskFraction(event);
    const closeTs = eventCloseTs(event);
    const tier = desiredTier(event);
    tierStats[tier.name].considered += 1;

    if (!Number.isFinite(resultR) || !(rf > 0) || !Number.isFinite(closeTs) || !(state.equity > 0)) {
      skipInvalid += 1;
      continue;
    }

    if (ADAPTIVE_POLICY.onePerSymbol && active.some((x) => x.symbol === event.symbol)) {
      skipSameSymbol += 1;
      continue;
    }
    if (active.length >= ADAPTIVE_POLICY.maxConcurrent) {
      skipConcurrent += 1;
      continue;
    }

    const activeRiskUsd = active.reduce((s, x) => s + x.riskUsd, 0);
    const maxOpenRiskUsd = state.equity * (ADAPTIVE_POLICY.maxOpenRiskPctEquity / 100);
    const remainingRiskUsd = Math.max(0, maxOpenRiskUsd - activeRiskUsd);
    const desiredRiskUsd = state.equity * (tier.riskPctEquity / 100);
    const riskUsd = Math.min(desiredRiskUsd, remainingRiskUsd);
    const actualRiskPct = (riskUsd / state.equity) * 100;

    if (!(riskUsd > 0) || actualRiskPct + 1e-12 < ADAPTIVE_POLICY.minExecutableRiskPctEquity) {
      skipRiskCap += 1;
      continue;
    }

    const notionalUsd = riskUsd / rf;
    const marginUsd = notionalUsd / tier.leverage;
    const activeMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    const marginLimitUsd = state.equity * (ADAPTIVE_POLICY.maxMarginUtilizationPct / 100);
    if (!(marginUsd > 0) || activeMargin + marginUsd > marginLimitUsd) {
      skipMargin += 1;
      continue;
    }

    const pnlUsd = resultR * riskUsd;
    seq += 1;
    active.push({
      id: `${event.symbol}-${ts}-${seq}`,
      seq,
      symbol: event.symbol,
      closeTs,
      marginUsd,
      riskUsd,
      pnlUsd,
      tier: tier.name,
      leverage: tier.leverage,
      actualRiskPct,
    });
    taken += 1;

    const st = tierStats[tier.name];
    st.taken += 1;
    st.pnlUsd += pnlUsd;
    st.actualRiskPctSum += actualRiskPct;
    st.leverageSum += tier.leverage;
    if (pnlUsd > 0) st.wins += 1;
    else if (pnlUsd < 0) st.losses += 1;

    const newMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    const newRisk = active.reduce((s, x) => s + x.riskUsd, 0);
    maxMarginUtilizationPct = Math.max(maxMarginUtilizationPct, (newMargin / state.equity) * 100);
    maxOpenRiskPctObserved = Math.max(maxOpenRiskPctObserved, (newRisk / state.equity) * 100);
    maxConcurrentObserved = Math.max(maxConcurrentObserved, active.length);
  }

  active = flushClosed(active, Number.POSITIVE_INFINITY, state);

  const finalizedTierStats = Object.fromEntries(Object.entries(tierStats).map(([name, x]) => [name, {
    ...x,
    pnlUsd: round(x.pnlUsd, 4),
    avgActualRiskPct: x.taken ? round(x.actualRiskPctSum / x.taken, 4) : null,
    avgLeverage: x.taken ? round(x.leverageSum / x.taken, 4) : null,
  }]));

  const used = Object.values(finalizedTierStats).filter((x) => x.taken > 0);
  const weightedRisk = used.reduce((s, x) => s + x.avgActualRiskPct * x.taken, 0);
  const weightedLev = used.reduce((s, x) => s + x.avgLeverage * x.taken, 0);
  const total = ordered.length;

  return {
    mode: "ADAPTIVE",
    scenario,
    policyVersion: VERSION,
    startingEquityUsd: STARTING_EQUITY,
    endingEquityUsd: round(state.equity, 4),
    returnPct: round(((state.equity / STARTING_EQUITY) - 1) * 100, 2),
    maxDrawdownPct: round(maxDrawdownPct(state.equityPoints), 2),
    tradesAvailable: total,
    tradesTaken: taken,
    tradesTakenPct: round(pct(taken, total), 2),
    wins: state.wins,
    losses: state.losses,
    winRatePct: round(pct(state.wins, state.realizedTrades), 2),
    skipped: { concurrent: skipConcurrent, sameSymbol: skipSameSymbol, margin: skipMargin, portfolioRiskCap: skipRiskCap, invalid: skipInvalid },
    avgActualRiskPct: taken ? round(weightedRisk / taken, 4) : null,
    avgLeverage: taken ? round(weightedLev / taken, 4) : null,
    distinctRiskTiersUsed: used.length,
    distinctLeverageTiersUsed: used.length,
    maxConcurrentObserved,
    maxOpenRiskPctObserved: round(maxOpenRiskPctObserved, 2),
    maxMarginUtilizationPct: round(maxMarginUtilizationPct, 2),
    tierStats: finalizedTierStats,
    endingActivePositions: active.length,
  };
}

export function simulateFixedReference(events, scenario) {
  const ordered = [...events]
    .filter((e) => Number.isFinite(num(e?.timestampMs)))
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  const state = {
    equity: STARTING_EQUITY,
    equityPoints: [{ ts: ordered[0]?.timestampMs ?? 0, equity: STARTING_EQUITY }],
    wins: 0,
    losses: 0,
    realizedTrades: 0,
  };

  let active = [];
  let taken = 0;
  let skipConcurrent = 0;
  let skipSameSymbol = 0;
  let skipMargin = 0;
  let skipInvalid = 0;
  let maxMarginUtilizationPct = 0;
  let seq = 0;

  for (const event of ordered) {
    const ts = num(event.timestampMs);
    active = flushClosed(active, ts, state);
    const resultR = scenarioR(event, scenario);
    const rf = riskFraction(event);
    const closeTs = eventCloseTs(event);

    if (!Number.isFinite(resultR) || !(rf > 0) || !Number.isFinite(closeTs) || !(state.equity > 0)) {
      skipInvalid += 1;
      continue;
    }
    if (FIXED_REFERENCE.onePerSymbol && active.some((x) => x.symbol === event.symbol)) {
      skipSameSymbol += 1;
      continue;
    }
    if (active.length >= FIXED_REFERENCE.maxConcurrent) {
      skipConcurrent += 1;
      continue;
    }

    const riskUsd = state.equity * (FIXED_REFERENCE.riskPctEquity / 100);
    const notionalUsd = riskUsd / rf;
    const marginUsd = notionalUsd / FIXED_REFERENCE.leverage;
    const activeMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    const marginLimitUsd = state.equity * (FIXED_REFERENCE.maxMarginUtilizationPct / 100);
    if (!(marginUsd > 0) || activeMargin + marginUsd > marginLimitUsd) {
      skipMargin += 1;
      continue;
    }

    const pnlUsd = resultR * riskUsd;
    seq += 1;
    active.push({ id: `${event.symbol}-${ts}-${seq}`, seq, symbol: event.symbol, closeTs, marginUsd, riskUsd, pnlUsd });
    taken += 1;
    const newMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    maxMarginUtilizationPct = Math.max(maxMarginUtilizationPct, (newMargin / state.equity) * 100);
  }

  active = flushClosed(active, Number.POSITIVE_INFINITY, state);
  const total = ordered.length;
  return {
    mode: "FIXED_REFERENCE",
    scenario,
    config: FIXED_REFERENCE,
    startingEquityUsd: STARTING_EQUITY,
    endingEquityUsd: round(state.equity, 4),
    returnPct: round(((state.equity / STARTING_EQUITY) - 1) * 100, 2),
    maxDrawdownPct: round(maxDrawdownPct(state.equityPoints), 2),
    tradesAvailable: total,
    tradesTaken: taken,
    tradesTakenPct: round(pct(taken, total), 2),
    wins: state.wins,
    losses: state.losses,
    winRatePct: round(pct(state.wins, state.realizedTrades), 2),
    skipped: { concurrent: skipConcurrent, sameSymbol: skipSameSymbol, margin: skipMargin, invalid: skipInvalid },
    maxMarginUtilizationPct: round(maxMarginUtilizationPct, 2),
    endingActivePositions: active.length,
  };
}

export function policyFingerprint() {
  return JSON.stringify({ version: VERSION, policy: ADAPTIVE_POLICY, fixedReference: FIXED_REFERENCE });
}
