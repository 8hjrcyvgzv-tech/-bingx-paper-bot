// V4 CLEAN CORE — POINT-IN-TIME REGIME + EXIT GOVERNOR V2
// RESEARCH / HISTORICAL REPLAY ONLY
// NO SCANNER / NO PAPER / NO LIVE / NO ORDERS

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadFrozenFiveMinuteRows } from "./v4_frozen_data_provider.mjs";
import { POLICY, VERSION as POLICY_VERSION, round, policyFingerprint } from "./v4_regime_exit_adaptive_v2.mjs";

const VERSION = "V4_REGIME_EXIT_GOVERNOR_2";
const HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

const SIGNALS_PATH = process.env.REPLAY_SIGNALS_PATH || "artifacts/v4_replay_signals.json";
const REPLAY_SUMMARY_PATH = process.env.REPLAY_SUMMARY_PATH || "artifacts/v4_replay_summary.json";
const STRUCTURE_EVENTS_PATH = process.env.STRUCTURE_EVENTS_PATH || "artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";
const STRUCTURE_SUMMARY_PATH = process.env.STRUCTURE_SUMMARY_PATH || "artifacts/oos_costs/v4_structure_exit_oos_costs_summary.json";
const OUTPUT_DIR = process.env.REGIME_GOV_OUTPUT_DIR || "artifacts/regime_exit_v2";

const COST_SCENARIOS = Object.freeze({
  BASE: Object.freeze({ feeBpsPerFill: 5.0, slippageBpsPerFill: 1.0, fundingStressBpsPer8h: 0.5 }),
  STRESS: Object.freeze({ feeBpsPerFill: 5.0, slippageBpsPerFill: 3.0, fundingStressBpsPer8h: 1.0 }),
});

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
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
      openTime: bucket,
      closeTime: bucket + bucketMs - 1,
      open: first.open,
      high: Math.max(...part.map((x) => x.high)),
      low: Math.min(...part.map((x) => x.low)),
      close: last.close,
      volume: part.reduce((s, x) => s + (n(x.volume) ?? 0), 0),
      quoteVolume: part.reduce((s, x) => s + (n(x.quoteVolume) ?? 0), 0),
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

function sliceCompleted(rows, timestamp, limit) {
  const end = upperIndex(rows, timestamp, "closeTime");
  return rows.slice(Math.max(0, end - limit), end);
}

function stopTouched(direction, bar, level) {
  return direction === "LONG" ? bar.low <= level : bar.high >= level;
}

function targetTouched(direction, bar, level) {
  return direction === "LONG" ? bar.high >= level : bar.low <= level;
}

function directionalR(direction, entry, stop, price) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return direction === "LONG" ? (price - entry) / risk : (entry - price) / risk;
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

function simulateFixedBaseline(signal, fiveMinuteRows) {
  const direction = String(signal?.direction || "").toUpperCase();
  const entry = n(signal?.entry);
  const stop = n(signal?.stop);
  const tp1 = n(signal?.tp1);
  const ts = n(signal?.timestampMs);

  if (!["LONG", "SHORT"].includes(direction) || !(entry > 0) || !(stop > 0) || !(tp1 > 0) || !Number.isFinite(ts)) {
    return { valid: false, reason: "INVALID_FIXED_INPUT" };
  }

  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) return { valid: false, reason: "INVALID_FIXED_RISK" };

  const startIndex = lowerOpenIndex(fiveMinuteRows, ts);
  const endIndex = lowerOpenIndex(fiveMinuteRows, ts + 24 * HOUR);
  const rows = fiveMinuteRows.slice(startIndex, endIndex);
  if (!rows.length) return { valid: false, reason: "NO_FIXED_OUTCOME_ROWS" };

  let grossResultR = null;
  let exitPrice = entry;
  let exitReason = "HORIZON";
  let barsHeld = 0;
  let finalClose = entry;

  for (const bar of rows) {
    barsHeld += 1;
    finalClose = bar.close;

    // Conservative same-candle convention: stop has priority.
    if (stopTouched(direction, bar, stop)) {
      grossResultR = -1;
      exitPrice = stop;
      exitReason = "INITIAL_STOP";
      break;
    }
    if (targetTouched(direction, bar, tp1)) {
      grossResultR = directionalR(direction, entry, stop, tp1);
      exitPrice = tp1;
      exitReason = "TP1";
      break;
    }
  }

  if (!Number.isFinite(grossResultR)) {
    grossResultR = directionalR(direction, entry, stop, finalClose);
    exitPrice = finalClose;
    exitReason = "HORIZON";
  }
  if (!Number.isFinite(grossResultR)) return { valid: false, reason: "INVALID_FIXED_GROSS_R" };

  const costScenarios = {};
  for (const [name, cost] of Object.entries(COST_SCENARIOS)) {
    let tradingCostR = costRForFill({
      share: 1,
      price: entry,
      entry,
      riskFraction,
      feeBps: cost.feeBpsPerFill,
      slippageBps: cost.slippageBpsPerFill,
    });
    tradingCostR += costRForFill({
      share: 1,
      price: exitPrice,
      entry,
      riskFraction,
      feeBps: cost.feeBpsPerFill,
      slippageBps: cost.slippageBpsPerFill,
    });
    const fundingCostR = fundingStressR({
      share: 1,
      minutes: barsHeld * 5,
      riskFraction,
      fundingBpsPer8h: cost.fundingStressBpsPer8h,
    });
    costScenarios[name] = {
      netResultR: round(grossResultR - tradingCostR - fundingCostR, 6),
      tradingCostR: round(tradingCostR, 6),
      fundingStressR: round(fundingCostR, 6),
      totalCostR: round(tradingCostR + fundingCostR, 6),
    };
  }

  return {
    valid: true,
    grossResultR: round(grossResultR, 6),
    costScenarios,
    barsHeld,
    exitReason,
  };
}

function mean(values) {
  const x = values.filter(Number.isFinite);
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
}

function regimeFeatures(oneHourRows, ts, direction) {
  const rows = sliceCompleted(oneHourRows, ts, 80);
  if (rows.length < 21) {
    return { valid: false, reason: "INSUFFICIENT_1H_HISTORY" };
  }

  const closes = rows.map((x) => n(x.close)).filter(Number.isFinite);
  const lookback = POLICY.regime.efficiencyLookbackHours;
  const part = closes.slice(-(lookback + 1));
  if (part.length < lookback + 1) return { valid: false, reason: "INSUFFICIENT_EFFICIENCY_HISTORY" };

  let path = 0;
  for (let i = 1; i < part.length; i++) path += Math.abs(part[i] - part[i - 1]);
  const efficiency = path > 0 ? Math.abs(part.at(-1) - part[0]) / path : 0;

  const tr = [];
  for (let i = 0; i < rows.length; i++) {
    const high = n(rows[i].high);
    const low = n(rows[i].low);
    const prevClose = i > 0 ? n(rows[i - 1].close) : null;
    const values = [high - low];
    if (Number.isFinite(prevClose)) {
      values.push(Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    tr.push(Math.max(...values.filter(Number.isFinite)));
  }
  const atr14 = mean(tr.slice(-14));
  const atr50 = mean(tr.slice(-50));
  const lastClose = closes.at(-1);
  const atrPct1h = atr14 > 0 && lastClose > 0 ? (atr14 / lastClose) * 100 : null;
  const atrRatio1h = atr14 > 0 && atr50 > 0 ? atr14 / atr50 : null;

  const sma20 = mean(closes.slice(-20));
  const sma50 = mean(closes.slice(-50));
  const trendAligned = direction === "LONG"
    ? lastClose > sma20 && sma20 > sma50
    : lastClose < sma20 && sma20 < sma50;

  let regime = "TRADEABLE_TREND";
  if (efficiency < POLICY.regime.minTradeableEfficiency) regime = "CHOP";
  else if (efficiency >= POLICY.regime.maxTradeableEfficiencyExclusive) regime = "OVEREXTENDED";

  return {
    valid: true,
    efficiency20h: round(efficiency, 6),
    atrPct1h: round(atrPct1h, 6),
    atrRatio1h: round(atrRatio1h, 6),
    trendAligned,
    regime,
  };
}

function stat(values) {
  const x = values.filter(Number.isFinite);
  const wins = x.filter((v) => v > 0);
  const losses = x.filter((v) => v < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    setups: x.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: x.length ? round((wins.length / x.length) * 100, 2) : null,
    expectancyR: x.length ? round(x.reduce((a, b) => a + b, 0) / x.length, 4) : null,
    cumulativeR: round(x.reduce((a, b) => a + b, 0), 4),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : null,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const [signalsRaw, replaySummary, structureEventsRaw, structureSummary] = await Promise.all([
    readFile(SIGNALS_PATH, "utf8").then(JSON.parse),
    readFile(REPLAY_SUMMARY_PATH, "utf8").then(JSON.parse),
    readFile(STRUCTURE_EVENTS_PATH, "utf8").then(JSON.parse),
    readFile(STRUCTURE_SUMMARY_PATH, "utf8").then(JSON.parse),
  ]);

  const signals = Array.isArray(signalsRaw) ? signalsRaw : [];
  const structureEvents = Array.isArray(structureEventsRaw) ? structureEventsRaw : [];
  if (!signals.length || !structureEvents.length) throw new Error("Missing replay or structure events");

  const expectedAllocation = structureSummary?.candidateLockedBeforeRun?.allocation;
  if (n(structureSummary?.candidateLockedBeforeRun?.strongRadarThreshold) !== 7) throw new Error("Structure source threshold drifted");
  if (n(expectedAllocation?.tp1) !== 0.6 || n(expectedAllocation?.tp2) !== 0.3 || n(expectedAllocation?.runner) !== 0.1) {
    throw new Error("Structure source allocation drifted");
  }

  const signalMap = new Map(signals.map((x) => [`${x.timestampMs}|${x.symbol}|${x.direction}`, x]));
  const symbols = [...new Set(structureEvents.map((x) => x.symbol))];
  const cache = new Map();
  for (const symbol of symbols) {
    const five = await loadFrozenFiveMinuteRows(symbol);
    cache.set(symbol, { five, oneHour: aggregateCandles(five, 60) });
  }

  const events = [];
  for (const structureEvent of structureEvents) {
    const key = `${structureEvent.timestampMs}|${structureEvent.symbol}|${structureEvent.direction}`;
    const signal = signalMap.get(key);
    if (!signal) throw new Error(`Signal join failed for ${key}`);
    if (n(signal.radarScore) < 7) throw new Error(`Structure population contains non-Strong Radar signal ${key}`);

    const data = cache.get(signal.symbol);
    const fixed = simulateFixedBaseline(signal, data.five);
    if (fixed?.valid !== true) throw new Error(`Fixed simulation failed ${key}: ${fixed?.reason}`);
    if (Math.abs((n(signal.resultR) ?? 999) - fixed.grossResultR) > 0.002) {
      throw new Error(`Fixed gross mismatch ${key}: signal=${signal.resultR} reconstructed=${fixed.grossResultR}`);
    }

    const features = regimeFeatures(data.oneHour, n(signal.timestampMs), String(signal.direction).toUpperCase());
    if (features?.valid !== true) throw new Error(`Regime feature failure ${key}: ${features?.reason}`);

    const status = String(signal.structureStatus || "UNKNOWN").toUpperCase();
    const radarPass = n(signal.radarScore) >= POLICY.strongRadarMin;
    const statusPass = POLICY.eligibleStructureStatuses.includes(status);
    const regimePass = features.regime === "TRADEABLE_TREND";
    const eligible = radarPass && statusPass && regimePass;

    let eligibilityReason = "ELIGIBLE";
    if (!radarPass) eligibilityReason = "RADAR_BELOW_7_5";
    else if (!statusPass) eligibilityReason = `STATUS_${status}_NOT_ELIGIBLE`;
    else if (!regimePass) eligibilityReason = `REGIME_${features.regime}`;

    const selectedExitPolicy = POLICY.exitGovernor[status] || POLICY.exitGovernor.default;
    const structureModel = structureEvent?.model;
    if (!structureModel?.costScenarios?.BASE || !structureModel?.costScenarios?.STRESS) {
      throw new Error(`Structure cost model missing ${key}`);
    }

    const selectedModel = selectedExitPolicy === "STRUCTURE_60_30_10" ? structureModel : fixed;
    const selectedCostScenarios = selectedModel.costScenarios;
    const selectedGrossResultR = n(selectedModel.grossResultR);
    const selectedBarsHeld = n(selectedModel.barsHeld);

    events.push({
      datasetId: replaySummary?.dataset?.id ?? replaySummary?.dataset?.datasetId ?? null,
      timestamp: signal.timestamp,
      timestampMs: signal.timestampMs,
      symbol: signal.symbol,
      direction: signal.direction,
      decision: signal.decision,
      finalScore: signal.finalScore,
      radarScore: signal.radarScore,
      directionScore: signal.directionScore,
      structureScore: signal.structureScore,
      flowScore: signal.flowScore,
      structureStatus: status,
      entry: signal.entry,
      stop: signal.stop,
      baselineGrossResultR: signal.resultR,
      structureTargetSource: structureEvent?.structurePlan?.targetSource ?? null,
      structurePlan: structureEvent?.structurePlan ?? null,
      fixedModel: fixed,
      structureModel: {
        grossResultR: structureModel.grossResultR,
        costScenarios: structureModel.costScenarios,
        barsHeld: structureModel.barsHeld,
        exitReason: structureModel.exitReason,
      },
      regime: {
        ...features,
        radarPass,
        statusPass,
        regimePass,
        eligible,
        eligibilityReason,
      },
      governor: {
        selectedExitPolicy,
        grossResultR: selectedGrossResultR,
        barsHeld: selectedBarsHeld,
        costScenarios: selectedCostScenarios,
      },
    });
  }

  const eligibleEvents = events.filter((x) => x.regime.eligible === true);
  const selectedBase = eligibleEvents.map((x) => n(x.governor?.costScenarios?.BASE?.netResultR));
  const selectedStress = eligibleEvents.map((x) => n(x.governor?.costScenarios?.STRESS?.netResultR));
  const fixedBase = eligibleEvents.map((x) => n(x.fixedModel?.costScenarios?.BASE?.netResultR));
  const structureBase = eligibleEvents.map((x) => n(x.structureModel?.costScenarios?.BASE?.netResultR));

  const countsByReason = {};
  const countsByExit = {};
  const countsByStatus = {};
  for (const e of events) {
    countsByReason[e.regime.eligibilityReason] = (countsByReason[e.regime.eligibilityReason] ?? 0) + 1;
    if (e.regime.eligible) {
      countsByExit[e.governor.selectedExitPolicy] = (countsByExit[e.governor.selectedExitPolicy] ?? 0) + 1;
      countsByStatus[e.structureStatus] = (countsByStatus[e.structureStatus] ?? 0) + 1;
    }
  }

  const output = {
    version: VERSION,
    mode: "POINT_IN_TIME_REGIME_EXIT_GOVERNOR_V2_RESEARCH_ONLY",
    policyVersion: POLICY_VERSION,
    policyFingerprint: policyFingerprint(),
    dataset: replaySummary?.dataset ?? null,
    replayWindow: replaySummary?.replayWindow ?? null,
    sourcePopulation: {
      replaySignals: signals.length,
      strongRadar7Events: events.length,
      eligibleEvents: eligibleEvents.length,
      eligiblePctOfStrong7: round((eligibleEvents.length / events.length) * 100, 2),
    },
    lockedRules: {
      strongRadarMin: POLICY.strongRadarMin,
      eligibleStructureStatuses: POLICY.eligibleStructureStatuses,
      efficiencyWindow: `[${POLICY.regime.minTradeableEfficiency}, ${POLICY.regime.maxTradeableEfficiencyExclusive})`,
      exitGovernor: POLICY.exitGovernor,
      riskTierHighStructureScoreAtLeast: 5,
    },
    eligiblePerformanceBeforePortfolioSizing: {
      selectedBASE: stat(selectedBase),
      selectedSTRESS: stat(selectedStress),
      allFixedBASE: stat(fixedBase),
      allStructureBASE: stat(structureBase),
    },
    countsByReason,
    countsByExit,
    countsByStatus,
    integrity: {
      pointInTimeOnly: true,
      fixedGrossReconstructedAndMatched: true,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
  };

  await writeFile(`${OUTPUT_DIR}/v4_regime_exit_governor_v2_events.json`, JSON.stringify(events, null, 2), "utf8");
  await writeFile(`${OUTPUT_DIR}/v4_regime_exit_governor_v2_summary.json`, JSON.stringify(output, null, 2), "utf8");

  console.log("===== V4 REGIME + EXIT GOVERNOR V2 =====");
  console.log(JSON.stringify(output, null, 2));
}

await main();
