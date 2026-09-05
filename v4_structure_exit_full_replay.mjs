// V4 STRUCTURE EXIT + RUNNER — FULL FROZEN REPLAY
// RESEARCH / HISTORICAL REPLAY ONLY
// NO PAPER ORDERS / NO LIVE ORDERS
//
// Uses only candles completed at each signal timestamp.
// TP1 = first meaningful structure level.
// TP2 = next meaningful structure level.
// After TP1, remaining stop moves to breakeven from the NEXT 5m bar.
// Runner has no fixed TP; for this first full replay it keeps only the
// breakeven stop and is marked at the 24h horizon if not stopped.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  loadFrozenFiveMinuteRows,
} from "./v4_frozen_data_provider.mjs";
import {
  resolveStructureExitPlan,
  V4_STRUCTURE_EXIT_RUNNER_VERSION,
} from "./v4_structure_exit_runner.mjs";

const VERSION = "V4_STRUCTURE_EXIT_FULL_REPLAY_1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CFG = {
  strongRadarScore: 7.0,
  outcomeHours: 24,
  oneHourLookback: 120,
  fourHourLookback: 60,
  models: {
    A_60_30_10: { tp1: 0.60, tp2: 0.30, runner: 0.10 },
    B_65_30_05: { tp1: 0.65, tp2: 0.30, runner: 0.05 },
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
  return direction === "LONG"
    ? bar.high >= level
    : bar.low <= level;
}

function stopTouched(direction, bar, level) {
  return direction === "LONG"
    ? bar.low <= level
    : bar.high >= level;
}

function directionalR(direction, entry, stop, price) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return direction === "LONG"
    ? (price - entry) / risk
    : (entry - price) / risk;
}

function directionalMovePct(direction, entry, price) {
  if (!(entry > 0) || !(price > 0)) return null;
  return direction === "LONG"
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100;
}

function simulateEvent(signal, plan, fiveMinuteRows, allocation) {
  const direction = String(signal.direction).toUpperCase();
  const entry = num(signal.entry);
  const stop = num(signal.stop);
  const tp1 = num(plan.tp1);
  const tp2 = num(plan.tp2);
  const rr1 = num(plan.rr1);
  const rr2 = num(plan.rr2);

  if (
    !["LONG", "SHORT"].includes(direction) ||
    !(entry > 0) || !(stop > 0) || !(tp1 > 0) || !(tp2 > 0) ||
    !Number.isFinite(rr1) || !Number.isFinite(rr2)
  ) {
    return { valid: false, reason: "INVALID_SIMULATION_INPUT" };
  }

  const ts = num(signal.timestampMs);
  const endTs = ts + CFG.outcomeHours * HOUR;
  const startIndex = lowerOpenIndex(fiveMinuteRows, ts);
  const endIndex = lowerOpenIndex(fiveMinuteRows, endTs);
  const rows = fiveMinuteRows.slice(startIndex, endIndex);

  if (!rows.length) {
    return { valid: false, reason: "NO_OUTCOME_ROWS" };
  }

  const shares = {
    tp1: allocation.tp1,
    tp2: allocation.tp2,
    runner: allocation.runner,
  };

  const contribution = { tp1: 0, tp2: 0, runner: 0 };
  let tp1Hit = false;
  let tp2Hit = false;
  let stage = 0; // 0=before TP1, 1=after TP1, 2=after TP2, 3=closed
  let exitReason = "HORIZON";
  let runnerExitReason = "HORIZON";
  let runnerExitR = null;
  let maxFavorable = 0;
  let maxAdverse = 0;
  let finalClose = entry;

  for (const bar of rows) {
    finalClose = bar.close;

    const favorable = direction === "LONG"
      ? bar.high - entry
      : entry - bar.low;

    const adverse = direction === "LONG"
      ? entry - bar.low
      : bar.high - entry;

    maxFavorable = Math.max(maxFavorable, favorable);
    maxAdverse = Math.max(maxAdverse, adverse);

    if (stage === 0) {
      // Same-candle convention before TP1: initial stop has priority.
      if (stopTouched(direction, bar, stop)) {
        contribution.tp1 = -shares.tp1;
        contribution.tp2 = -shares.tp2;
        contribution.runner = -shares.runner;
        runnerExitR = -1;
        runnerExitReason = "INITIAL_STOP";
        exitReason = "INITIAL_STOP";
        stage = 3;
        break;
      }

      if (targetTouched(direction, bar, tp1)) {
        tp1Hit = true;
        contribution.tp1 = shares.tp1 * rr1;
        stage = 1;

        // TP2 may be reached on the same directional candle.
        // Breakeven activates only from the next 5m bar, avoiding
        // retroactive intrabar sequencing assumptions.
        if (targetTouched(direction, bar, tp2)) {
          tp2Hit = true;
          contribution.tp2 = shares.tp2 * rr2;
          stage = 2;
        }
        continue;
      }
    } else if (stage === 1) {
      // After TP1, remaining position is protected at entry.
      if (stopTouched(direction, bar, entry)) {
        contribution.tp2 = 0;
        contribution.runner = 0;
        runnerExitR = 0;
        runnerExitReason = "BREAKEVEN";
        exitReason = "BREAKEVEN_AFTER_TP1";
        stage = 3;
        break;
      }

      if (targetTouched(direction, bar, tp2)) {
        tp2Hit = true;
        contribution.tp2 = shares.tp2 * rr2;
        stage = 2;
        continue;
      }
    } else if (stage === 2) {
      // Runner has no fixed TP. It keeps the breakeven stop.
      if (stopTouched(direction, bar, entry)) {
        contribution.runner = 0;
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

    runnerExitReason = "HORIZON";
    exitReason = "HORIZON";
  }

  const resultR = contribution.tp1 + contribution.tp2 + contribution.runner;
  const riskPct = (Math.abs(entry - stop) / entry) * 100;
  const mfePct = (maxFavorable / entry) * 100;
  const maePct = (maxAdverse / entry) * 100;
  const weightedMovePct = resultR * riskPct;

  return {
    valid: true,
    resultR: round(resultR, 6),
    contributionR: {
      tp1: round(contribution.tp1, 6),
      tp2: round(contribution.tp2, 6),
      runner: round(contribution.runner, 6),
    },
    tp1Hit,
    tp2Hit,
    exitReason,
    runnerExitReason,
    runnerExitR: round(runnerExitR, 6),
    riskPct: round(riskPct, 6),
    mfePct: round(mfePct, 6),
    maePct: round(maePct, 6),
    weightedMovePct: round(weightedMovePct, 6),
    capturePctOfMfe:
      mfePct > 0
        ? round((weightedMovePct / mfePct) * 100, 2)
        : null,
  };
}

function maxDrawdown(values) {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const value of values) {
    eq += value;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

function stats(rows, selector) {
  const values = rows
    .map(selector)
    .filter(Number.isFinite);

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

function monsterSummary(rows, modelKey) {
  const buckets = {};
  for (const threshold of [5, 10, 20, 30]) {
    const part = rows.filter((x) => (x.models[modelKey]?.mfePct ?? 0) >= threshold);
    const captures = part
      .map((x) => x.models[modelKey]?.capturePctOfMfe)
      .filter(Number.isFinite);

    buckets[`mfeAtLeast${threshold}Pct`] = {
      signals: part.length,
      avgCapturePctOfMfe:
        captures.length
          ? round(captures.reduce((a, b) => a + b, 0) / captures.length, 2)
          : null,
      cumulativeR: round(
        part.reduce((s, x) => s + (x.models[modelKey]?.resultR ?? 0), 0),
        4
      ),
    };
  }
  return buckets;
}

async function main() {
  await mkdir("artifacts/runner_lab", { recursive: true });

  const signals = JSON.parse(
    await readFile("artifacts/v4_replay_signals.json", "utf8")
  );

  const replaySummary = JSON.parse(
    await readFile("artifacts/v4_replay_summary.json", "utf8")
  );

  if (!Array.isArray(signals) || signals.length !== 892) {
    throw new Error(`Expected frozen population 892, got ${signals?.length}`);
  }

  const strong = signals
    .filter((x) => num(x.radarScore) >= CFG.strongRadarScore)
    .sort((a, b) => num(a.timestampMs) - num(b.timestampMs));

  if (strong.length !== 180) {
    throw new Error(`Expected Strong Radar population 180, got ${strong.length}`);
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

    const candles1h = sliceCompleted(
      data.oneHour,
      ts,
      CFG.oneHourLookback
    );

    const candles4h = sliceCompleted(
      data.fourHour,
      ts,
      CFG.fourHourLookback
    );

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

    const models = {};
    for (const [modelKey, allocation] of Object.entries(CFG.models)) {
      models[modelKey] = simulateEvent(
        signal,
        plan,
        data.five,
        allocation
      );
    }

    events.push({
      timestamp: signal.timestamp,
      timestampMs: signal.timestampMs,
      symbol: signal.symbol,
      direction: signal.direction,
      structureStatus: signal.structureStatus,
      radarScore: signal.radarScore,
      baselineResultR: signal.resultR,
      baselineOutcome: signal.outcome,
      entry: signal.entry,
      stop: signal.stop,
      originalTp1: signal.tp1,
      originalTp2: signal.tp2,
      structurePlan: {
        tp1: plan.tp1,
        tp2: plan.tp2,
        rr1: plan.rr1,
        rr2: plan.rr2,
        targetSource: plan.targetSource,
        detectedLevels: plan.detectedLevels,
      },
      models,
    });
  }

  const replayEnd = Date.parse(replaySummary?.replayWindow?.end);
  if (!Number.isFinite(replayEnd)) {
    throw new Error("Invalid replay end");
  }

  const windows = {};
  for (const days of [30, 60, 100]) {
    const start = replayEnd - days * DAY + 1;
    const part = events.filter((x) => num(x.timestampMs) >= start);

    windows[`${days}d`] = {
      baseline: stats(part, (x) => num(x.baselineResultR)),
      A_60_30_10: stats(part, (x) => num(x.models.A_60_30_10?.resultR)),
      B_65_30_05: stats(part, (x) => num(x.models.B_65_30_05?.resultR)),
    };
  }

  const structureCoverage = {
    tp1Structure: events.filter(
      (x) => x.structurePlan?.targetSource?.tp1 === "STRUCTURE"
    ).length,
    tp2Structure: events.filter(
      (x) => x.structurePlan?.targetSource?.tp2 === "STRUCTURE"
    ).length,
    tp1Fallback: events.filter(
      (x) => x.structurePlan?.targetSource?.tp1 === "R_FALLBACK"
    ).length,
    tp2Fallback: events.filter(
      (x) => x.structurePlan?.targetSource?.tp2 === "R_FALLBACK"
    ).length,
  };

  const modelDetails = {};
  for (const modelKey of Object.keys(CFG.models)) {
    modelDetails[modelKey] = {
      overall: stats(events, (x) => num(x.models[modelKey]?.resultR)),
      tp1Hits: events.filter((x) => x.models[modelKey]?.tp1Hit === true).length,
      tp2Hits: events.filter((x) => x.models[modelKey]?.tp2Hit === true).length,
      runnerContributionR: round(
        events.reduce(
          (s, x) => s + (num(x.models[modelKey]?.contributionR?.runner) ?? 0),
          0
        ),
        4
      ),
      bySymbol: groupStats(events, "symbol", (x) => num(x.models[modelKey]?.resultR)),
      byDirection: groupStats(events, "direction", (x) => num(x.models[modelKey]?.resultR)),
      byStructure: groupStats(events, "structureStatus", (x) => num(x.models[modelKey]?.resultR)),
      monsterMoves: monsterSummary(events, modelKey),
    };
  }

  const output = {
    version: VERSION,
    mode: "HISTORICAL_REPLAY_ONLY",
    moduleVersion: V4_STRUCTURE_EXIT_RUNNER_VERSION,
    dataset: replaySummary?.dataset ?? null,
    replayWindow: replaySummary?.replayWindow ?? null,
    population: {
      frozenSignals: signals.length,
      strongRadarSignals: strong.length,
      strongRadarThreshold: CFG.strongRadarScore,
    },
    rules: {
      pointInTimeOnly: true,
      oneHourLookbackCandles: CFG.oneHourLookback,
      fourHourLookbackCandles: CFG.fourHourLookback,
      tp1: "First meaningful structure level at least 1R away; otherwise existing 1.8R fallback.",
      tp2: "Next meaningful structure level; otherwise existing 2.8R fallback.",
      afterTp1Stop: "BREAKEVEN_ENTRY_FROM_NEXT_5M_BAR",
      runner: "NO_FIXED_TP; BREAKEVEN_STOP; MARK_TO_24H_HORIZON_IF_NOT_STOPPED",
      sameCandleRule: "Before TP1 initial stop has priority. After TP1, breakeven becomes active on the next 5m bar; TP2 may be credited on the TP1 bar if also touched.",
      models: CFG.models,
    },
    integrity: {
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    structureCoverage,
    windows,
    modelDetails,
    guardrails: [
      "Fees, slippage and funding are not included in this replay.",
      "The runner is limited to a 24h outcome horizon by the current frozen dataset tail; multi-day UNI-like runners are therefore not fully measured.",
      "5m OHLC does not reveal exact intrabar path; the same-candle convention is explicitly fixed above.",
      "The 30d/60d/100d windows are stability views of the same frozen history, not independent OOS data.",
      "This workflow does not change production execution and does not enable PAPER or LIVE orders."
    ],
  };

  await writeFile(
    "artifacts/runner_lab/v4_structure_exit_full_replay_summary.json",
    JSON.stringify(output, null, 2),
    "utf8"
  );

  await writeFile(
    "artifacts/runner_lab/v4_structure_exit_full_replay_events.json",
    JSON.stringify(events, null, 2),
    "utf8"
  );

  console.log("===== V4 STRUCTURE EXIT FULL REPLAY =====");
  console.log(JSON.stringify({
    integrity: output.integrity,
    population: output.population,
    structureCoverage: output.structureCoverage,
    windows: output.windows,
    modelOverall: Object.fromEntries(
      Object.entries(output.modelDetails).map(([k, v]) => [k, v.overall])
    ),
  }, null, 2));
}

await main();
