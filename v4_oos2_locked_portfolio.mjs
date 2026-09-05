// V4 OOS2 — LOCKED PORTFOLIO VALIDATION V1
// RESEARCH / HISTORICAL REPLAY ONLY
// NO PAPER ORDERS / NO LIVE ORDERS
//
// Locked BEFORE fresh OOS2:
// - Strong Radar >= 7.0
// - Structure Exit A: 60% TP1 / 30% TP2 / 10% runner
// - BASE/STRESS cost outcomes produced by v4_structure_exit_oos_costs.mjs
// - 0.50% equity risk per trade
// - max 2 concurrent positions
// - max one active position per symbol
// - 5x leverage used only for margin requirement
//
// OOS2 must be chronologically disjoint from BOTH OOS1 and development data.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const VERSION = "V4_OOS2_LOCKED_PORTFOLIO_1";
const FIVE_MIN_MS = 5 * 60 * 1000;
const STARTING_EQUITY = 100;

const EVENTS_PATH =
  process.env.OOS2_EVENTS_PATH ||
  "artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";

const COST_SUMMARY_PATH =
  process.env.OOS2_COST_SUMMARY_PATH ||
  "artifacts/oos_costs/v4_structure_exit_oos_costs_summary.json";

const REPLAY_SUMMARY_PATH =
  process.env.OOS2_REPLAY_SUMMARY_PATH ||
  "artifacts/v4_replay_summary.json";

const LOCKED = Object.freeze({
  riskPctEquity: 0.5,
  maxConcurrent: 2,
  leverage: 5,
  onePerSymbol: true,
});

// Pre-registered after OOS1 diagnostic and BEFORE OOS2 is observed.
const GATE = Object.freeze({
  baseEndingEquityUsdAtLeast: 100,
  stressEndingEquityUsdAtLeast: 100,
  baseMaxDrawdownPctAtMost: 10,
  stressMaxDrawdownPctAtMost: 12,
  maxMarginUtilizationPctAtMost: 70,
  minTradesTakenPct: 60,
});

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function pct(a, b) {
  return b > 0 ? (a / b) * 100 : null;
}

function eventCloseTs(event) {
  const start = num(event?.timestampMs);
  const bars = num(event?.model?.barsHeld);
  if (!Number.isFinite(start)) return null;
  const boundedBars = Number.isFinite(bars)
    ? Math.max(1, Math.min(288, bars))
    : 288;
  return start + boundedBars * FIVE_MIN_MS;
}

function riskFraction(event) {
  const entry = num(event?.entry);
  const stop = num(event?.stop);
  if (!(entry > 0) || !(stop > 0)) return null;
  const value = Math.abs(entry - stop) / entry;
  return value > 0 ? value : null;
}

function scenarioR(event, scenario) {
  return num(event?.model?.costScenarios?.[scenario]?.netResultR);
}

function maxDrawdownPct(points) {
  let peak = STARTING_EQUITY;
  let maxDd = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDd = Math.max(maxDd, ((peak - point.equity) / peak) * 100);
    }
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
    state.equityPoints.push({
      ts: pos.closeTs,
      equity: state.equity,
      type: "EXIT",
      symbol: pos.symbol,
    });
    if (pos.pnlUsd > 0) state.wins += 1;
    else if (pos.pnlUsd < 0) state.losses += 1;
  }

  return active.filter((x) => !dueIds.has(x.id));
}

function simulate(events, scenario) {
  const ordered = [...events]
    .filter((e) => Number.isFinite(num(e?.timestampMs)))
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  const state = {
    equity: STARTING_EQUITY,
    equityPoints: [{
      ts: ordered[0]?.timestampMs ?? 0,
      equity: STARTING_EQUITY,
      type: "START",
    }],
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
  let maxConcurrentObserved = 0;
  let seq = 0;

  for (const event of ordered) {
    const ts = num(event.timestampMs);
    active = flushClosed(active, ts, state);

    const resultR = scenarioR(event, scenario);
    const rf = riskFraction(event);
    const closeTs = eventCloseTs(event);

    if (
      !Number.isFinite(resultR) ||
      !(rf > 0) ||
      !Number.isFinite(closeTs) ||
      !(state.equity > 0)
    ) {
      skipInvalid += 1;
      continue;
    }

    if (LOCKED.onePerSymbol && active.some((x) => x.symbol === event.symbol)) {
      skipSameSymbol += 1;
      continue;
    }

    if (active.length >= LOCKED.maxConcurrent) {
      skipConcurrent += 1;
      continue;
    }

    const riskUsd = state.equity * (LOCKED.riskPctEquity / 100);
    const notionalUsd = riskUsd / rf;
    const marginUsd = notionalUsd / LOCKED.leverage;
    const activeMargin = active.reduce((s, x) => s + x.marginUsd, 0);

    // Same conservative capacity rule used in the consumed OOS1 risk lab.
    if (!(marginUsd > 0) || activeMargin + marginUsd > state.equity) {
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
      pnlUsd,
    });
    taken += 1;

    const newMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    maxMarginUtilizationPct = Math.max(
      maxMarginUtilizationPct,
      state.equity > 0 ? (newMargin / state.equity) * 100 : 999
    );
    maxConcurrentObserved = Math.max(maxConcurrentObserved, active.length);
  }

  active = flushClosed(active, Number.POSITIVE_INFINITY, state);

  const total = ordered.length;
  return {
    scenario,
    config: LOCKED,
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
    skipped: {
      concurrent: skipConcurrent,
      sameSymbol: skipSameSymbol,
      margin: skipMargin,
      invalid: skipInvalid,
    },
    maxConcurrentObserved,
    maxMarginUtilizationPct: round(maxMarginUtilizationPct, 2),
    endingActivePositions: active.length,
  };
}

function gatePass(base, stress) {
  return (
    base.endingEquityUsd >= GATE.baseEndingEquityUsdAtLeast &&
    stress.endingEquityUsd >= GATE.stressEndingEquityUsdAtLeast &&
    base.maxDrawdownPct <= GATE.baseMaxDrawdownPctAtMost &&
    stress.maxDrawdownPct <= GATE.stressMaxDrawdownPctAtMost &&
    Math.max(base.maxMarginUtilizationPct, stress.maxMarginUtilizationPct) <=
      GATE.maxMarginUtilizationPctAtMost &&
    Math.min(base.tradesTakenPct, stress.tradesTakenPct) >= GATE.minTradesTakenPct
  );
}

async function main() {
  const [eventsRaw, costs, replay] = await Promise.all([
    readFile(EVENTS_PATH, "utf8").then(JSON.parse),
    readFile(COST_SUMMARY_PATH, "utf8").then(JSON.parse),
    readFile(REPLAY_SUMMARY_PATH, "utf8").then(JSON.parse),
  ]);

  if (!Array.isArray(eventsRaw) || eventsRaw.length < 50) {
    throw new Error(`Fresh OOS2 event population unexpectedly small: ${eventsRaw?.length}`);
  }

  const replayStart = String(replay?.replayWindow?.start || "");
  const replayEnd = String(replay?.replayWindow?.end || "");
  if (!replayStart.startsWith("2025-04-19") || !replayEnd.startsWith("2025-07-27")) {
    throw new Error(`OOS2 window mismatch: ${replayStart} -> ${replayEnd}`);
  }

  // Freshness boundary: OOS2 outcome tail ends 2025-07-28, while OOS1
  // dataset starts 2025-07-29. There is zero candle overlap.
  const datasetStart = String(replay?.dataset?.layout?.datasetStart || "");
  const datasetEnd = String(replay?.dataset?.layout?.datasetEnd || "");
  if (!datasetStart.startsWith("2025-01-09") || !datasetEnd.startsWith("2025-07-28")) {
    throw new Error(`OOS2 dataset boundary mismatch: ${datasetStart} -> ${datasetEnd}`);
  }

  if (num(costs?.candidateLockedBeforeRun?.strongRadarThreshold) !== 7) {
    throw new Error("Strong Radar threshold drifted from locked >=7.0");
  }

  const allocation = costs?.candidateLockedBeforeRun?.allocation;
  if (
    num(allocation?.tp1) !== 0.6 ||
    num(allocation?.tp2) !== 0.3 ||
    num(allocation?.runner) !== 0.1
  ) {
    throw new Error("Structure Exit allocation drifted from locked 60/30/10");
  }

  const events = eventsRaw.filter((x) => (
    Number.isFinite(scenarioR(x, "BASE")) &&
    Number.isFinite(scenarioR(x, "STRESS")) &&
    riskFraction(x) > 0
  ));

  if (events.length !== eventsRaw.length) {
    throw new Error(`Invalid OOS2 costed events: ${eventsRaw.length - events.length}`);
  }

  const base = simulate(events, "BASE");
  const stress = simulate(events, "STRESS");
  const pass = gatePass(base, stress);

  const output = {
    version: VERSION,
    mode: "FRESH_OOS2_LOCKED_VALIDATION_ONLY",
    dataset: replay?.dataset ?? null,
    replayWindow: replay?.replayWindow ?? null,
    sourcePopulation: {
      frozenSignals: costs?.population?.frozenSignals ?? null,
      strongRadarSignals: events.length,
      strongRadarRetentionPct: costs?.population?.strongRadarRetentionPct ?? null,
    },
    lockedBeforeOos2: {
      strategy: "Strong Radar >=7 + Structure Exit A 60/30/10",
      portfolioRisk: LOCKED,
      rationale: "Selected from consumed OOS1 diagnostic; 5x chosen over identical-PnL 10x because 5x uses lower nominal leverage while remaining within the diagnostic margin screen.",
      noCoinDirectionStructureExclusions: true,
    },
    preregisteredOos2Gate: GATE,
    results: {
      BASE: base,
      STRESS: stress,
    },
    decision: pass
      ? "PROMOTE_TO_72H_RUNNER_RESEARCH"
      : "HOLD_RESEARCH_ONLY",
    integrity: {
      freshOos2NoOverlapWithOos1: true,
      pointInTimeOnly: true,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    guardrails: [
      "OOS2 dataset is 2025-01-09..2025-07-28; OOS1 dataset begins 2025-07-29, so even warmup/tail candles do not overlap.",
      "The locked portfolio policy is not altered after seeing OOS2 results.",
      "No BTC/SOL/LONG/BREAKOUT exclusions are introduced from OOS1 diagnostics.",
      "BASE/STRESS costs remain synthetic conservative stresses, not realized venue-native BingX funding history.",
      "A PROMOTE decision advances only to a 72h+ runner research test; it does not enable PAPER or LIVE execution."
    ],
  };

  await mkdir("artifacts/oos2_locked", { recursive: true });
  await writeFile(
    "artifacts/oos2_locked/v4_oos2_locked_portfolio_summary.json",
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("===== V4 FRESH OOS2 LOCKED VALIDATION =====");
  console.log(JSON.stringify({
    dataset: output.dataset?.id ?? null,
    replayWindow: output.replayWindow,
    sourcePopulation: output.sourcePopulation,
    lockedBeforeOos2: output.lockedBeforeOos2,
    gate: output.preregisteredOos2Gate,
    results: output.results,
    decision: output.decision,
    integrity: output.integrity,
  }, null, 2));
}

await main();
