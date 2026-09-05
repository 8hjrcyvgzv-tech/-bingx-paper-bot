// V4 CLEAN CORE — PORTFOLIO RISK LAB V1
// RESEARCH / HISTORICAL SIMULATION ONLY
// NO SCANNER / NO PAPER / NO LIVE / NO ORDERS
//
// Purpose:
// Turn the consumed OOS1 Structure Exit + Costs events into a $100 portfolio
// stress lab. This is DIAGNOSTIC ONLY; it does not promote a strategy.
//
// Important modeling choices:
// - Uses already-costed BASE/STRESS R outcomes from OOS1.
// - Risk sizing is stop based: riskUsd = equity * riskPct.
// - Notional = riskUsd / stopDistanceFraction.
// - Leverage changes margin required, not the R outcome.
// - PnL is realized at the event's final close time (barsHeld * 5m).
// - Until final close, the full initial margin is conservatively treated as locked.
// - Default matrix allows only one active position per symbol.
// - If max concurrency or margin capacity is exceeded, the later signal is skipped.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const VERSION = "V4_PORTFOLIO_RISK_LAB_1";
const FIVE_MIN_MS = 5 * 60 * 1000;
const STARTING_EQUITY = 100;

const INPUT =
  process.env.OOS_EVENTS_PATH ||
  "oos1/artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";

const OUTPUT_DIR = "artifacts/portfolio_lab";

const MATRIX = {
  riskPctEquity: [0.25, 0.5, 1.0],
  maxConcurrent: [1, 2, 3, 5],
  leverage: [5, 10],
  onePerSymbol: true,
};

const DIAGNOSTIC_SCREEN = {
  // These are not validation gates. They only identify configurations worth
  // freezing for a future fresh OOS test.
  baseMaxDrawdownPctAtMost: 10,
  stressMaxDrawdownPctAtMost: 12,
  stressEndingEquityAtLeast: 100,
  maxMarginUtilizationPctAtMost: 70,
  minTakenPct: 60,
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

function pct(a, b) {
  return b > 0 ? (a / b) * 100 : null;
}

function eventCloseTs(event) {
  const start = num(event.timestampMs);
  const bars = num(event?.model?.barsHeld);
  if (!Number.isFinite(start)) return null;
  const boundedBars = Number.isFinite(bars)
    ? Math.max(1, Math.min(288, bars))
    : 288;
  return start + boundedBars * FIVE_MIN_MS;
}

function riskFraction(event) {
  const entry = num(event.entry);
  const stop = num(event.stop);
  if (!(entry > 0) || !(stop > 0)) return null;
  const x = Math.abs(entry - stop) / entry;
  return x > 0 ? x : null;
}

function scenarioR(event, scenario) {
  return num(event?.model?.costScenarios?.[scenario]?.netResultR);
}

function maxDrawdownPct(equityPoints) {
  let peak = STARTING_EQUITY;
  let maxDd = 0;
  for (const point of equityPoints) {
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

function simulate(events, cfg, scenario) {
  const ordered = [...events]
    .filter((e) => Number.isFinite(num(e.timestampMs)))
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  const state = {
    equity: STARTING_EQUITY,
    equityPoints: [{ ts: ordered[0]?.timestampMs ?? 0, equity: STARTING_EQUITY, type: "START" }],
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

    const r = scenarioR(event, scenario);
    const rf = riskFraction(event);
    const closeTs = eventCloseTs(event);

    if (!Number.isFinite(r) || !(rf > 0) || !Number.isFinite(closeTs) || !(state.equity > 0)) {
      skipInvalid += 1;
      continue;
    }

    if (cfg.onePerSymbol && active.some((x) => x.symbol === event.symbol)) {
      skipSameSymbol += 1;
      continue;
    }

    if (active.length >= cfg.maxConcurrent) {
      skipConcurrent += 1;
      continue;
    }

    const riskUsd = state.equity * (cfg.riskPctEquity / 100);
    const notionalUsd = riskUsd / rf;
    const marginUsd = notionalUsd / cfg.leverage;
    const activeMargin = active.reduce((s, x) => s + x.marginUsd, 0);

    // Conservative capacity rule: do not lock more margin than current equity.
    if (!(marginUsd > 0) || activeMargin + marginUsd > state.equity) {
      skipMargin += 1;
      continue;
    }

    const pnlUsd = r * riskUsd;
    seq += 1;
    active.push({
      id: `${event.symbol}-${ts}-${seq}`,
      seq,
      symbol: event.symbol,
      entryTs: ts,
      closeTs,
      marginUsd,
      riskUsd,
      pnlUsd,
      resultR: r,
    });
    taken += 1;

    const newMargin = active.reduce((s, x) => s + x.marginUsd, 0);
    maxMarginUtilizationPct = Math.max(
      maxMarginUtilizationPct,
      state.equity > 0 ? (newMargin / state.equity) * 100 : 999
    );
    maxConcurrentObserved = Math.max(maxConcurrentObserved, active.length);
  }

  // Realize all remaining positions in chronological exit order.
  active = flushClosed(active, Number.POSITIVE_INFINITY, state);

  const maxDdPct = maxDrawdownPct(state.equityPoints);
  const totalReturnPct = ((state.equity / STARTING_EQUITY) - 1) * 100;
  const total = ordered.length;

  return {
    scenario,
    config: cfg,
    startingEquityUsd: STARTING_EQUITY,
    endingEquityUsd: round(state.equity, 4),
    returnPct: round(totalReturnPct, 2),
    maxDrawdownPct: round(maxDdPct, 2),
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

function screenPair(base, stress) {
  const s = DIAGNOSTIC_SCREEN;
  return (
    base.maxDrawdownPct <= s.baseMaxDrawdownPctAtMost &&
    stress.maxDrawdownPct <= s.stressMaxDrawdownPctAtMost &&
    stress.endingEquityUsd >= s.stressEndingEquityAtLeast &&
    Math.max(base.maxMarginUtilizationPct, stress.maxMarginUtilizationPct) <= s.maxMarginUtilizationPctAtMost &&
    Math.min(base.tradesTakenPct, stress.tradesTakenPct) >= s.minTakenPct
  );
}

function configKey(cfg) {
  return `risk${cfg.riskPctEquity}_max${cfg.maxConcurrent}_lev${cfg.leverage}`;
}

async function main() {
  const raw = JSON.parse(await readFile(INPUT, "utf8"));
  if (!Array.isArray(raw) || raw.length < 100) {
    throw new Error(`Expected OOS event array, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }

  const events = raw.filter((x) => (
    Number.isFinite(scenarioR(x, "BASE")) &&
    Number.isFinite(scenarioR(x, "STRESS")) &&
    riskFraction(x) > 0
  ));

  const matrix = [];
  for (const riskPctEquity of MATRIX.riskPctEquity) {
    for (const maxConcurrent of MATRIX.maxConcurrent) {
      for (const leverage of MATRIX.leverage) {
        const cfg = {
          riskPctEquity,
          maxConcurrent,
          leverage,
          onePerSymbol: MATRIX.onePerSymbol,
        };
        const base = simulate(events, cfg, "BASE");
        const stress = simulate(events, cfg, "STRESS");
        matrix.push({
          key: configKey(cfg),
          config: cfg,
          base,
          stress,
          diagnosticScreenPass: screenPair(base, stress),
        });
      }
    }
  }

  const screened = matrix
    .filter((x) => x.diagnosticScreenPass)
    .sort((a, b) => (
      b.stress.endingEquityUsd - a.stress.endingEquityUsd ||
      a.stress.maxDrawdownPct - b.stress.maxDrawdownPct
    ));

  const output = {
    version: VERSION,
    mode: "CONSUMED_OOS1_PORTFOLIO_DIAGNOSTIC_ONLY",
    source: {
      inputPath: INPUT,
      oos1RunId: 33975089837,
      oos1ArtifactId: 9972079030,
      events: events.length,
      expectedCandidate: "Strong Radar >=7 + Structure Exit A 60/30/10 + BASE/STRESS costs",
    },
    assumptions: {
      startingEquityUsd: STARTING_EQUITY,
      leverageMeaning: "Leverage only changes margin requirement. Stop-based risk controls PnL exposure.",
      positionSizing: "riskUsd = current equity * riskPct; notional = riskUsd / abs(entry-stop)/entry",
      marginLock: "Full initial margin conservatively locked until final event close.",
      eventClose: "timestamp + barsHeld*5m, capped at 24h",
      onePerSymbol: MATRIX.onePerSymbol,
      noNewTradingRules: true,
    },
    matrixDefinition: MATRIX,
    diagnosticScreen: DIAGNOSTIC_SCREEN,
    matrix,
    screenedCount: screened.length,
    screenedTop: screened.slice(0, 10),
    integrity: {
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    nextAction: (
      screened.length
        ? "USE_DEV_PLUS_CONSUMED_OOS1_DIAGNOSTICS_TO_FREEZE_ONE_PORTFOLIO_RISK POLICY; THEN VALIDATE UNCHANGED ON FRESH OOS2"
        : "DO_NOT PROMOTE; REDESIGN PORTFOLIO RISK BEFORE FRESH OOS2"
    ),
    guardrails: [
      "OOS1 is consumed by this diagnostic and cannot be reused as fresh validation for a tuned risk policy.",
      "The diagnostic screen is not a promotion gate and must not be described as OOS validation.",
      "No coin/direction/structure exclusion is introduced here; regime-specific filters require separate preregistration and fresh OOS validation.",
      "BASE/STRESS costs are synthetic conservative stresses, not realized BingX funding history.",
      "This lab never sends orders and never enables scanner, PAPER, or LIVE execution."
    ],
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    `${OUTPUT_DIR}/v4_portfolio_risk_lab_summary.json`,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("===== V4 PORTFOLIO RISK LAB =====");
  console.log(JSON.stringify({
    sourceEvents: events.length,
    screenedCount: output.screenedCount,
    screenedTop: output.screenedTop.slice(0, 5).map((x) => ({
      key: x.key,
      baseEndingEquityUsd: x.base.endingEquityUsd,
      baseMaxDrawdownPct: x.base.maxDrawdownPct,
      stressEndingEquityUsd: x.stress.endingEquityUsd,
      stressMaxDrawdownPct: x.stress.maxDrawdownPct,
      tradesTakenPct: x.stress.tradesTakenPct,
      maxMarginUtilizationPct: x.stress.maxMarginUtilizationPct,
    })),
    integrity: output.integrity,
    nextAction: output.nextAction,
  }, null, 2));
}

await main();
