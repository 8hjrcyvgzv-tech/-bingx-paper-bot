// V4 CLEAN CORE — REGIME + EXIT GOVERNOR + ADAPTIVE RISK V2
// RESEARCH / HISTORICAL SIMULATION ONLY
// NO SCANNER / NO PAPER / NO LIVE / NO ORDERS

export const VERSION = "V4_REGIME_EXIT_ADAPTIVE_2";
export const STARTING_EQUITY = 100;
export const FIVE_MIN_MS = 5 * 60 * 1000;

export const POLICY = Object.freeze({
  strongRadarMin: 7.5,
  eligibleStructureStatuses: Object.freeze(["ARMED", "RETEST"]),
  regime: Object.freeze({
    efficiencyLookbackHours: 20,
    minTradeableEfficiency: 0.15,
    maxTradeableEfficiencyExclusive: 0.45,
  }),
  exitGovernor: Object.freeze({
    RETEST: "STRUCTURE_60_30_10",
    ARMED: "FIXED_1_8R",
    default: "FIXED_1_8R",
  }),
  riskTiers: Object.freeze([
    Object.freeze({ name: "STANDARD", minStructureScore: Number.NEGATIVE_INFINITY, riskPctEquity: 0.25 }),
    Object.freeze({ name: "HIGH", minStructureScore: 5.0, riskPctEquity: 0.50 }),
  ]),
  leverageByStopFraction: Object.freeze([
    Object.freeze({ maxExclusive: 0.0075, leverage: 7 }),
    Object.freeze({ maxExclusive: 0.0150, leverage: 5 }),
    Object.freeze({ maxExclusive: Number.POSITIVE_INFINITY, leverage: 3 }),
  ]),
  maxConcurrent: 2,
  onePerSymbol: true,
  maxOpenRiskPctEquity: 1.00,
  maxMarginUtilizationPct: 50,
  minExecutableRiskPctEquity: 0.25,
});

function n(v) {
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

export function policyFingerprint() {
  const serializable = {
    version: VERSION,
    policy: {
      strongRadarMin: POLICY.strongRadarMin,
      eligibleStructureStatuses: [...POLICY.eligibleStructureStatuses],
      regime: { ...POLICY.regime },
      exitGovernor: { ...POLICY.exitGovernor },
      riskTiers: POLICY.riskTiers.map((x) => ({
        name: x.name,
        minStructureScore: Number.isFinite(x.minStructureScore) ? x.minStructureScore : "-INF",
        riskPctEquity: x.riskPctEquity,
      })),
      leverageByStopFraction: POLICY.leverageByStopFraction.map((x) => ({
        maxExclusive: Number.isFinite(x.maxExclusive) ? x.maxExclusive : "+INF",
        leverage: x.leverage,
      })),
      maxConcurrent: POLICY.maxConcurrent,
      onePerSymbol: POLICY.onePerSymbol,
      maxOpenRiskPctEquity: POLICY.maxOpenRiskPctEquity,
      maxMarginUtilizationPct: POLICY.maxMarginUtilizationPct,
      minExecutableRiskPctEquity: POLICY.minExecutableRiskPctEquity,
    },
  };
  return JSON.stringify(serializable);
}

export function riskFraction(event) {
  const entry = n(event?.entry);
  const stop = n(event?.stop);
  if (!(entry > 0) || !(stop > 0)) return null;
  const rf = Math.abs(entry - stop) / entry;
  return rf > 0 ? rf : null;
}

export function desiredTier(event) {
  const score = n(event?.structureScore) ?? Number.NEGATIVE_INFINITY;
  let tier = POLICY.riskTiers[0];
  for (const candidate of POLICY.riskTiers) {
    if (score >= candidate.minStructureScore) tier = candidate;
  }
  return tier;
}

export function leverageForRiskFraction(rf) {
  if (!(rf > 0)) return null;
  for (const row of POLICY.leverageByStopFraction) {
    if (rf < row.maxExclusive) return row.leverage;
  }
  return null;
}

export function scenarioR(event, scenario) {
  return n(event?.governor?.costScenarios?.[scenario]?.netResultR);
}

export function eventCloseTs(event) {
  const start = n(event?.timestampMs);
  const bars = n(event?.governor?.barsHeld);
  if (!Number.isFinite(start)) return null;
  const boundedBars = Number.isFinite(bars) ? Math.max(1, Math.min(288, bars)) : 288;
  return start + boundedBars * FIVE_MIN_MS;
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

  const ids = new Set(due.map((x) => x.id));
  for (const pos of due) {
    state.equity += pos.pnlUsd;
    state.realizedTrades += 1;
    state.equityPoints.push({ ts: pos.closeTs, equity: state.equity });
    if (pos.pnlUsd > 0) state.wins += 1;
    else if (pos.pnlUsd < 0) state.losses += 1;
    state.grossWinUsd += Math.max(0, pos.pnlUsd);
    state.grossLossUsd += Math.max(0, -pos.pnlUsd);
  }
  return active.filter((x) => !ids.has(x.id));
}

function emptyTierStats() {
  return Object.fromEntries(POLICY.riskTiers.map((t) => [t.name, {
    considered: 0,
    taken: 0,
    wins: 0,
    losses: 0,
    pnlUsd: 0,
    riskPctSum: 0,
    leverageSum: 0,
  }]));
}

export function simulateAdaptiveV2(events, scenario) {
  const ordered = [...events]
    .filter((e) => Number.isFinite(n(e?.timestampMs)))
    .sort((a, b) => n(a.timestampMs) - n(b.timestampMs));

  const state = {
    equity: STARTING_EQUITY,
    equityPoints: [{ ts: ordered[0]?.timestampMs ?? 0, equity: STARTING_EQUITY }],
    wins: 0,
    losses: 0,
    realizedTrades: 0,
    grossWinUsd: 0,
    grossLossUsd: 0,
  };

  let active = [];
  let taken = 0;
  let eligible = 0;
  let skipIneligible = 0;
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
  const leverageStats = {};
  const exitPolicyStats = {};

  for (const event of ordered) {
    const ts = n(event.timestampMs);
    active = flushClosed(active, ts, state);

    const tier = desiredTier(event);
    tierStats[tier.name].considered += 1;

    if (event?.regime?.eligible !== true) {
      skipIneligible += 1;
      continue;
    }
    eligible += 1;

    const resultR = scenarioR(event, scenario);
    const rf = riskFraction(event);
    const closeTs = eventCloseTs(event);
    const leverage = leverageForRiskFraction(rf);

    if (!Number.isFinite(resultR) || !(rf > 0) || !Number.isFinite(closeTs) || !(leverage > 0) || !(state.equity > 0)) {
      skipInvalid += 1;
      continue;
    }

    if (POLICY.onePerSymbol && active.some((x) => x.symbol === event.symbol)) {
      skipSameSymbol += 1;
      continue;
    }
    if (active.length >= POLICY.maxConcurrent) {
      skipConcurrent += 1;
      continue;
    }

    const activeRiskUsd = active.reduce((s, x) => s + x.riskUsd, 0);
    const maxOpenRiskUsd = state.equity * (POLICY.maxOpenRiskPctEquity / 100);
    const remainingRiskUsd = Math.max(0, maxOpenRiskUsd - activeRiskUsd);
    const desiredRiskUsd = state.equity * (tier.riskPctEquity / 100);
    const riskUsd = Math.min(desiredRiskUsd, remainingRiskUsd);
    const actualRiskPct = (riskUsd / state.equity) * 100;

    if (!(riskUsd > 0) || actualRiskPct + 1e-12 < POLICY.minExecutableRiskPctEquity) {
      skipRiskCap += 1;
      continue;
    }

    const notionalUsd = riskUsd / rf;
    const marginUsd = notionalUsd / leverage;
    const activeMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    const marginLimitUsd = state.equity * (POLICY.maxMarginUtilizationPct / 100);
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
      leverage,
      actualRiskPct,
      exitPolicy: event?.governor?.selectedExitPolicy ?? "UNKNOWN",
    });
    taken += 1;

    const st = tierStats[tier.name];
    st.taken += 1;
    st.pnlUsd += pnlUsd;
    st.riskPctSum += actualRiskPct;
    st.leverageSum += leverage;
    if (pnlUsd > 0) st.wins += 1;
    else if (pnlUsd < 0) st.losses += 1;

    leverageStats[String(leverage)] = (leverageStats[String(leverage)] ?? 0) + 1;
    const ep = event?.governor?.selectedExitPolicy ?? "UNKNOWN";
    exitPolicyStats[ep] = (exitPolicyStats[ep] ?? 0) + 1;

    const newMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    const newRisk = active.reduce((s, x) => s + x.riskUsd, 0);
    maxMarginUtilizationPct = Math.max(maxMarginUtilizationPct, (newMargin / state.equity) * 100);
    maxOpenRiskPctObserved = Math.max(maxOpenRiskPctObserved, (newRisk / state.equity) * 100);
    maxConcurrentObserved = Math.max(maxConcurrentObserved, active.length);
  }

  active = flushClosed(active, Number.POSITIVE_INFINITY, state);

  const finalizedTierStats = Object.fromEntries(Object.entries(tierStats).map(([name, x]) => [name, {
    considered: x.considered,
    taken: x.taken,
    wins: x.wins,
    losses: x.losses,
    pnlUsd: round(x.pnlUsd, 4),
    avgRiskPct: x.taken ? round(x.riskPctSum / x.taken, 4) : null,
    avgLeverage: x.taken ? round(x.leverageSum / x.taken, 4) : null,
  }]));

  const pf = state.grossLossUsd > 0
    ? state.grossWinUsd / state.grossLossUsd
    : state.grossWinUsd > 0 ? 999 : null;

  return {
    mode: "REGIME_EXIT_ADAPTIVE_V2",
    scenario,
    policyVersion: VERSION,
    startingEquityUsd: STARTING_EQUITY,
    endingEquityUsd: round(state.equity, 4),
    returnPct: round(((state.equity / STARTING_EQUITY) - 1) * 100, 2),
    maxDrawdownPct: round(maxDrawdownPct(state.equityPoints), 2),
    profitFactorUsd: round(pf, 4),
    eventsAvailable: ordered.length,
    eligibleEvents: eligible,
    eligiblePct: round(pct(eligible, ordered.length), 2),
    tradesTaken: taken,
    tradesTakenPctOfEligible: round(pct(taken, eligible), 2),
    wins: state.wins,
    losses: state.losses,
    winRatePct: round(pct(state.wins, state.realizedTrades), 2),
    skipped: {
      ineligible: skipIneligible,
      concurrent: skipConcurrent,
      sameSymbol: skipSameSymbol,
      margin: skipMargin,
      portfolioRiskCap: skipRiskCap,
      invalid: skipInvalid,
    },
    maxConcurrentObserved,
    maxOpenRiskPctObserved: round(maxOpenRiskPctObserved, 2),
    maxMarginUtilizationPct: round(maxMarginUtilizationPct, 2),
    leverageStats,
    exitPolicyStats,
    tierStats: finalizedTierStats,
    endingActivePositions: active.length,
  };
}
