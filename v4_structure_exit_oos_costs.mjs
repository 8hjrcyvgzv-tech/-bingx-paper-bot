// V4 STRUCTURE EXIT — INDEPENDENT OOS + COST STRESS REPLAY
// RESEARCH / HISTORICAL REPLAY ONLY
// NO PAPER ORDERS / NO LIVE ORDERS
//
// Locked candidate: Strong Radar >= 7.0 + Structure Exit A (60/30/10).
// This runner is intentionally generic: it does NOT assume the 892/180
// in-sample population. It consumes whatever independent frozen dataset
// the workflow builds, then applies pre-registered cost stress scenarios.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadFrozenFiveMinuteRows } from "./v4_frozen_data_provider.mjs";
import {
  resolveStructureExitPlan,
  V4_STRUCTURE_EXIT_RUNNER_VERSION,
} from "./v4_structure_exit_runner.mjs";

const VERSION = "V4_STRUCTURE_EXIT_OOS_COSTS_1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_MINUTES = 5 * 60 * 1000;

const CFG = {
  strongRadarScore: 7.0,
  outcomeHours: 24,
  oneHourLookback: 120,
  fourHourLookback: 60,
  allocation: { tp1: 0.60, tp2: 0.30, runner: 0.10 },
  costScenarios: {
    BASE: {
      feeBpsPerFill: 5.0,
      slippageBpsPerFill: 1.0,
      fundingStressBpsPer8h: 0.5,
    },
    STRESS: {
      feeBpsPerFill: 5.0,
      slippageBpsPerFill: 3.0,
      fundingStressBpsPer8h: 1.0,
    },
  },
  preregisteredGate: {
    promote: {
      baseExpectancyRAbove: 0,
      baseProfitFactorAtLeast: 1.10,
      stressExpectancyRAtLeast: 0,
      maxDrawdownRAtMost: 15,
    },
    reject: {
      baseExpectancyRAtMost: 0,
      baseProfitFactorAtMost: 1.0,
    },
  },
};

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function aggregateCandles(rows, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const expected = minutes / 5;
  const groups = new Map();

  for (const row of rows) {
    const bucket = Math.floor(row.openTime / bucketMs) * bucketMs;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(row);
  }

  const out = [];
  for (const [bucket, part] of groups) {
    part.sort((a, b) => a.openTime - b.openTime);
    if (part.length < expected) continue;
    const first = part[0];
    const last = part.at(-1);
    out.push({
      time: bucket,
      openTime: bucket,
      closeTime: bucket + bucketMs - 1,
      open: first.open,
      high: Math.max(...part.map((x) => x.high)),
      low: Math.min(...part.map((x) => x.low)),
      close: last.close,
      volume: part.reduce((s, x) => s + (num(x.volume) ?? 0), 0),
      quoteVolume: part.reduce((s, x) => s + (num(x.quoteVolume) ?? 0), 0),
    });
  }

  return out.sort((a, b) => a.openTime - b.openTime);
}

function upperIndex(rows, timestamp, key = "closeTime") {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid][key] <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sliceCompleted(rows, timestamp, limit) {
  const end = upperIndex(rows, timestamp, "closeTime");
  return rows.slice(Math.max(0, end - limit), end);
}

function lowerOpenIndex(rows, timestamp) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid].openTime <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function targetTouched(direction, bar, level) {
  return direction === "LONG" ? bar.high >= level : bar.low <= level;
}

function stopTouched(direction, bar, level) {
  return direction === "LONG" ? bar.low <= level : bar.high >= level;
}

function directionalR(direction, entry, stop, price) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return direction === "LONG"
    ? (price - entry) / risk
    : (entry - price) / risk;
}

function costRForFill({ share, price, entry, riskFraction, feeBps, slippageBps }) {
  if (!(share > 0) || !(price > 0) || !(entry > 0) || !(riskFraction > 0)) return 0;
  const notionalFactor = price / entry;
  const costFraction = share * notionalFactor * ((feeBps + slippageBps) / 10_000);
  return costFraction / riskFraction;
}

function fundingStressR({ share, minutes, riskFraction, fundingBpsPer8h }) {
  if (!(share > 0) || !(minutes > 0) || !(riskFraction > 0) || !(fundingBpsPer8h > 0)) return 0;
  const costFraction = share * (fundingBpsPer8h / 10_000) * (minutes / (8 * 60));
  return costFraction / riskFraction;
}

function simulateEvent(signal, plan, fiveMinuteRows) {
  const direction = String(signal.direction).toUpperCase();
  const entry = num(signal.entry);
  const stop = num(signal.stop);
  const tp1 = num(plan.tp1);
  const tp2 = num(plan.tp2);
  const rr1 = num(plan.rr1);
  const rr2 = num(plan.rr2);
  const ts = num(signal.timestampMs);

  if (
    !["LONG", "SHORT"].includes(direction) ||
    !(entry > 0) || !(stop > 0) || !(tp1 > 0) || !(tp2 > 0) ||
    !Number.isFinite(rr1) || !Number.isFinite(rr2) || !Number.isFinite(ts)
  ) {
    return { valid: false, reason: "INVALID_SIMULATION_INPUT" };
  }

  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) {
    return { valid: false, reason: "INVALID_RISK" };
  }

  const endTs = ts + CFG.outcomeHours * HOUR;
  const startIndex = lowerOpenIndex(fiveMinuteRows, ts);
  const endIndex = lowerOpenIndex(fiveMinuteRows, endTs);
  const rows = fiveMinuteRows.slice(startIndex, endIndex);
  if (!rows.length) return { valid: false, reason: "NO_OUTCOME_ROWS" };

  const shares = CFG.allocation;
  const contribution = { tp1: 0, tp2: 0, runner: 0 };
  const exitFills = [];
  let tp1Hit = false;
  let tp2Hit = false;
  let stage = 0; // 0=before TP1, 1=after TP1, 2=after TP2, 3=closed
  let exitReason = "HORIZON";
  let runnerExitReason = "HORIZON";
  let runnerExitR = null;
  let maxFavorable = 0;
  let maxAdverse = 0;
  let finalClose = entry;
  let remainingShare = 1.0;
  let fundingShareMinutes = 0;
  let barsHeld = 0;

  for (const bar of rows) {
    finalClose = bar.close;
    barsHeld += 1;
    fundingShareMinutes += remainingShare * 5;

    const favorable = direction === "LONG" ? bar.high - entry : entry - bar.low;
    const adverse = direction === "LONG" ? entry - bar.low : bar.high - entry;
    maxFavorable = Math.max(maxFavorable, favorable);
    maxAdverse = Math.max(maxAdverse, adverse);

    if (stage === 0) {
      // Conservative same-candle convention: initial stop has priority.
      if (stopTouched(direction, bar, stop)) {
        contribution.tp1 = -shares.tp1;
        contribution.tp2 = -shares.tp2;
        contribution.runner = -shares.runner;
        exitFills.push({ share: remainingShare, price: stop, reason: "INITIAL_STOP" });
        remainingShare = 0;
        runnerExitR = -1;
        runnerExitReason = "INITIAL_STOP";
        exitReason = "INITIAL_STOP";
        stage = 3;
        break;
      }

      if (targetTouched(direction, bar, tp1)) {
        tp1Hit = true;
        contribution.tp1 = shares.tp1 * rr1;
        exitFills.push({ share: shares.tp1, price: tp1, reason: "TP1" });
        remainingShare -= shares.tp1;
        stage = 1;

        // TP2 may be credited on the TP1 candle; BE starts next 5m bar.
        if (targetTouched(direction, bar, tp2)) {
          tp2Hit = true;
          contribution.tp2 = shares.tp2 * rr2;
          exitFills.push({ share: shares.tp2, price: tp2, reason: "TP2_SAME_BAR" });
          remainingShare -= shares.tp2;
          stage = 2;
        }
        continue;
      }
    } else if (stage === 1) {
      if (stopTouched(direction, bar, entry)) {
        contribution.tp2 = 0;
        contribution.runner = 0;
        exitFills.push({ share: remainingShare, price: entry, reason: "BREAKEVEN_AFTER_TP1" });
        remainingShare = 0;
        runnerExitR = 0;
        runnerExitReason = "BREAKEVEN";
        exitReason = "BREAKEVEN_AFTER_TP1";
        stage = 3;
        break;
      }

      if (targetTouched(direction, bar, tp2)) {
        tp2Hit = true;
        contribution.tp2 = shares.tp2 * rr2;
        exitFills.push({ share: shares.tp2, price: tp2, reason: "TP2" });
        remainingShare -= shares.tp2;
        stage = 2;
        continue;
      }
    } else if (stage === 2) {
      if (stopTouched(direction, bar, entry)) {
        contribution.runner = 0;
        exitFills.push({ share: remainingShare, price: entry, reason: "RUNNER_BREAKEVEN" });
        remainingShare = 0;
        runnerExitR = 0;
        runnerExitReason = "BREAKEVEN";
        exitReason = "RUNNER_BREAKEVEN";
        stage = 3;
        break;
      }
    }
  }

  if (stage !== 3) {
    const horizonR = directionalR(direction, entry, stop, finalClose);
    if (!Number.isFinite(horizonR)) {
      return { valid: false, reason: "INVALID_HORIZON_R" };
    }

    if (stage === 0) {
      contribution.tp1 = shares.tp1 * horizonR;
      contribution.tp2 = shares.tp2 * horizonR;
      contribution.runner = shares.runner * horizonR;
      runnerExitR = horizonR;
    } else if (stage === 1) {
      contribution.tp2 = shares.tp2 * horizonR;
      contribution.runner = shares.runner * horizonR;
      runnerExitR = horizonR;
    } else if (stage === 2) {
      contribution.runner = shares.runner * horizonR;
      runnerExitR = horizonR;
    }

    if (remainingShare > 0) {
      exitFills.push({ share: remainingShare, price: finalClose, reason: "HORIZON" });
      remainingShare = 0;
    }
    runnerExitReason = "HORIZON";
    exitReason = "HORIZON";
  }

  const grossResultR = contribution.tp1 + contribution.tp2 + contribution.runner;
  const scenarioResults = {};

  for (const [name, cost] of Object.entries(CFG.costScenarios)) {
    let tradingCostR = costRForFill({
      share: 1,
      price: entry,
      entry,
      riskFraction,
      feeBps: cost.feeBpsPerFill,
      slippageBps: cost.slippageBpsPerFill,
    });

    for (const fill of exitFills) {
      tradingCostR += costRForFill({
        share: fill.share,
        price: fill.price,
        entry,
        riskFraction,
        feeBps: cost.feeBpsPerFill,
        slippageBps: cost.slippageBpsPerFill,
      });
    }

    const fundingCostR = fundingStressR({
      share: 1,
      minutes: fundingShareMinutes,
      riskFraction,
      fundingBpsPer8h: cost.fundingStressBpsPer8h,
    });

    const netResultR = grossResultR - tradingCostR - fundingCostR;
    scenarioResults[name] = {
      netResultR: round(netResultR, 6),
      tradingCostR: round(tradingCostR, 6),
      fundingStressR: round(fundingCostR, 6),
      totalCostR: round(tradingCostR + fundingCostR, 6),
    };
  }

  const riskPct = riskFraction * 100;
  const mfePct = (maxFavorable / entry) * 100;
  const maePct = (maxAdverse / entry) * 100;
  const grossWeightedMovePct = grossResultR * riskPct;

  return {
    valid: true,
    grossResultR: round(grossResultR, 6),
    contributionR: {
      tp1: round(contribution.tp1, 6),
      tp2: round(contribution.tp2, 6),
      runner: round(contribution.runner, 6),
    },
    costScenarios: scenarioResults,
    tp1Hit,
    tp2Hit,
    exitReason,
    runnerExitReason,
    runnerExitR: round(runnerExitR, 6),
    riskPct: round(riskPct, 6),
    mfePct: round(mfePct, 6),
    maePct: round(maePct, 6),
    holdingMinutesWeighted: round(fundingShareMinutes, 2),
    barsHeld,
    exitFillCount: exitFills.length,
    grossCapturePctOfMfe:
      mfePct > 0 ? round((grossWeightedMovePct / mfePct) * 100, 2) : null,
  };
}

function maxDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

function stats(rows, selector) {
  const values = rows.map(selector).filter(Number.isFinite);
  const wins = values.filter((x) => x > 0);
  const losses = values.filter((x) => x < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const total = values.reduce((a, b) => a + b, 0);
  return {
    setups: values.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: values.length ? round((wins.length / values.length) * 100, 2) : null,
    expectancyR: values.length ? round(total / values.length, 4) : null,
    cumulativeR: round(total, 4),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : null,
    maxDrawdownR: round(maxDrawdown(values), 4),
  };
}

function groupStats(rows, key, selector) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key] ?? "UNKNOWN";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, part]) => [k, stats(part, selector)])
  );
}

function gateDecision(base, stress) {
  const p = CFG.preregisteredGate.promote;
  const r = CFG.preregisteredGate.reject;

  if (
    Number.isFinite(base.expectancyR) && base.expectancyR <= r.baseExpectancyRAtMost ||
    Number.isFinite(base.profitFactor) && base.profitFactor <= r.baseProfitFactorAtMost
  ) {
    return "REJECT";
  }

  if (
    Number.isFinite(base.expectancyR) && base.expectancyR > p.baseExpectancyRAbove &&
    Number.isFinite(base.profitFactor) && base.profitFactor >= p.baseProfitFactorAtLeast &&
    Number.isFinite(stress.expectancyR) && stress.expectancyR >= p.stressExpectancyRAtLeast &&
    Number.isFinite(base.maxDrawdownR) && base.maxDrawdownR <= p.maxDrawdownRAtMost
  ) {
    return "PROMOTE_TO_NEXT_RESEARCH_GATE";
  }

  return "HOLD_RESEARCH_ONLY";
}

async function main() {
  await mkdir("artifacts/oos_costs", { recursive: true });

  const signals = JSON.parse(await readFile("artifacts/v4_replay_signals.json", "utf8"));
  const replaySummary = JSON.parse(await readFile("artifacts/v4_replay_summary.json", "utf8"));

  if (!Array.isArray(signals) || signals.length < 1) {
    throw new Error("OOS replay produced no signals");
  }

  const strong = signals
    .filter((x) => num(x.radarScore) >= CFG.strongRadarScore)
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  if (strong.length < 1) {
    throw new Error("OOS replay produced no Strong Radar signals");
  }

  const symbols = [...new Set(strong.map((x) => x.symbol))];
  const cache = new Map();
  for (const symbol of symbols) {
    const five = await loadFrozenFiveMinuteRows(symbol);
    cache.set(symbol, {
      five,
      oneHour: aggregateCandles(five, 60),
      fourHour: aggregateCandles(five, 240),
    });
  }

  const events = [];

  for (const signal of strong) {
    const data = cache.get(signal.symbol);
    const ts = num(signal.timestampMs);
    const candles1h = sliceCompleted(data.oneHour, ts, CFG.oneHourLookback);
    const candles4h = sliceCompleted(data.fourHour, ts, CFG.fourHourLookback);

    const plan = resolveStructureExitPlan({
      direction: signal.direction,
      entry: signal.entry,
      stop: signal.stop,
      candles1h,
      candles4h,
    });

    if (plan?.valid !== true) {
      throw new Error(`Invalid structure exit plan for ${signal.symbol} ${signal.timestamp}`);
    }

    const model = simulateEvent(signal, plan, data.five);
    if (model?.valid !== true) {
      throw new Error(`Invalid OOS simulation for ${signal.symbol} ${signal.timestamp}: ${model?.reason}`);
    }

    events.push({
      timestamp: signal.timestamp,
      timestampMs: signal.timestampMs,
      symbol: signal.symbol,
      direction: signal.direction,
      structureStatus: signal.structureStatus,
      radarScore: signal.radarScore,
      baselineResultR: signal.resultR,
      entry: signal.entry,
      stop: signal.stop,
      structurePlan: {
        tp1: plan.tp1,
        tp2: plan.tp2,
        rr1: plan.rr1,
        rr2: plan.rr2,
        targetSource: plan.targetSource,
      },
      model,
    });
  }

  const selectors = {
    gross: (x) => num(x.model?.grossResultR),
    baseNet: (x) => num(x.model?.costScenarios?.BASE?.netResultR),
    stressNet: (x) => num(x.model?.costScenarios?.STRESS?.netResultR),
  };

  const overall = {
    baselineStrong: stats(events, (x) => num(x.baselineResultR)),
    grossA_60_30_10: stats(events, selectors.gross),
    netBASE: stats(events, selectors.baseNet),
    netSTRESS: stats(events, selectors.stressNet),
  };

  const structureCoverage = {
    tp1Structure: events.filter((x) => x.structurePlan?.targetSource?.tp1 === "STRUCTURE").length,
    tp2Structure: events.filter((x) => x.structurePlan?.targetSource?.tp2 === "STRUCTURE").length,
    tp1Fallback: events.filter((x) => x.structurePlan?.targetSource?.tp1 === "R_FALLBACK").length,
    tp2Fallback: events.filter((x) => x.structurePlan?.targetSource?.tp2 === "R_FALLBACK").length,
  };

  const costTotals = {};
  for (const scenario of Object.keys(CFG.costScenarios)) {
    const totalTrading = events.reduce((s, x) => s + (num(x.model?.costScenarios?.[scenario]?.tradingCostR) ?? 0), 0);
    const totalFunding = events.reduce((s, x) => s + (num(x.model?.costScenarios?.[scenario]?.fundingStressR) ?? 0), 0);
    costTotals[scenario] = {
      tradingCostR: round(totalTrading, 4),
      fundingStressR: round(totalFunding, 4),
      totalCostR: round(totalTrading + totalFunding, 4),
      avgCostRPerSetup: round((totalTrading + totalFunding) / events.length, 4),
    };
  }

  const bySymbol = {
    baseline: groupStats(events, "symbol", (x) => num(x.baselineResultR)),
    gross: groupStats(events, "symbol", selectors.gross),
    baseNet: groupStats(events, "symbol", selectors.baseNet),
    stressNet: groupStats(events, "symbol", selectors.stressNet),
  };

  const byDirection = {
    gross: groupStats(events, "direction", selectors.gross),
    baseNet: groupStats(events, "direction", selectors.baseNet),
    stressNet: groupStats(events, "direction", selectors.stressNet),
  };

  const byStructure = {
    gross: groupStats(events, "structureStatus", selectors.gross),
    baseNet: groupStats(events, "structureStatus", selectors.baseNet),
    stressNet: groupStats(events, "structureStatus", selectors.stressNet),
  };

  const decision = gateDecision(overall.netBASE, overall.netSTRESS);

  const output = {
    version: VERSION,
    mode: "INDEPENDENT_HISTORICAL_OOS_REPLAY_ONLY",
    moduleVersion: V4_STRUCTURE_EXIT_RUNNER_VERSION,
    dataset: replaySummary?.dataset ?? null,
    replayWindow: replaySummary?.replayWindow ?? null,
    candidateLockedBeforeRun: {
      strongRadarThreshold: CFG.strongRadarScore,
      allocation: CFG.allocation,
      tp1: "First meaningful point-in-time structure level at least 1R away; fallback 1.8R.",
      tp2: "Next meaningful point-in-time structure level; fallback 2.8R.",
      afterTp1Stop: "BREAKEVEN_FROM_NEXT_5M_BAR",
      runner: "NO_FIXED_TP; 24H OOS HORIZON FOR THIS GATE",
    },
    population: {
      frozenSignals: signals.length,
      strongRadarSignals: strong.length,
      strongRadarRetentionPct: round((strong.length / signals.length) * 100, 2),
    },
    costModel: {
      interpretation: "Conservative synthetic cost stress, not venue-native realized funding history.",
      scenarios: CFG.costScenarios,
      costTotals,
    },
    structureCoverage,
    overall,
    bySymbol,
    byDirection,
    byStructure,
    preregisteredGate: CFG.preregisteredGate,
    decision,
    integrity: {
      pointInTimeOnly: true,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    guardrails: [
      "This OOS block is chronologically disjoint from the 2026-02-15..2026-09-03 development/frozen dataset.",
      "Cost BASE/STRESS scenarios are fixed before reading OOS results.",
      "Funding is a conservative debit stress assumption; realized venue-native funding can be positive or negative and is not reconstructed here.",
      "Binance USD-M 5m data remains a price/structure proxy for BingX; DOGE normalized-volume proxy retains the prior caveat.",
      "Runner is still limited to 24h in this gate. A separate 72h+ runner test comes only after this OOS gate.",
      "No production execution, PAPER order, or LIVE order is enabled by this workflow.",
    ],
  };

  await writeFile(
    "artifacts/oos_costs/v4_structure_exit_oos_costs_summary.json",
    JSON.stringify(output, null, 2),
    "utf8"
  );

  await writeFile(
    "artifacts/oos_costs/v4_structure_exit_oos_costs_events.json",
    JSON.stringify(events, null, 2),
    "utf8"
  );

  console.log("===== V4 STRUCTURE EXIT OOS + COSTS =====");
  console.log(JSON.stringify({
    dataset: output.dataset?.id ?? output.dataset?.datasetId ?? null,
    replayWindow: output.replayWindow,
    population: output.population,
    structureCoverage: output.structureCoverage,
    overall: output.overall,
    costTotals: output.costModel.costTotals,
    decision: output.decision,
    integrity: output.integrity,
  }, null, 2));
}

await main();
