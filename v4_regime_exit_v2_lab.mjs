// V4 CLEAN CORE — CONSUMED OOS1/OOS2/OOS3 REGIME + EXIT + ADAPTIVE V2 LAB
// CONSUMED DATA ONLY. THIS FILE MUST NOT BUILD OR READ FRESH OOS4.
// RESEARCH / HISTORICAL ONLY. NO PAPER / NO LIVE / NO ORDERS.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  VERSION as POLICY_VERSION,
  POLICY,
  policyFingerprint,
  simulateAdaptiveV2,
} from "./v4_regime_exit_adaptive_v2.mjs";

const VERSION = "V4_REGIME_EXIT_V2_LAB_1";
const OUT_DIR = process.env.REGIME_V2_LAB_OUTPUT_DIR || "diagnostics/regime_exit_v2_lab";

const INPUTS = {
  OOS1: {
    events: process.env.OOS1_GOV_EVENTS || "consumed/oos1/regime/v4_regime_exit_governor_v2_events.json",
    summary: process.env.OOS1_GOV_SUMMARY || "consumed/oos1/regime/v4_regime_exit_governor_v2_summary.json",
  },
  OOS2: {
    events: process.env.OOS2_GOV_EVENTS || "consumed/oos2/regime/v4_regime_exit_governor_v2_events.json",
    summary: process.env.OOS2_GOV_SUMMARY || "consumed/oos2/regime/v4_regime_exit_governor_v2_summary.json",
  },
  OOS3: {
    events: process.env.OOS3_GOV_EVENTS || "consumed/oos3/regime/v4_regime_exit_governor_v2_events.json",
    summary: process.env.OOS3_GOV_SUMMARY || "consumed/oos3/regime/v4_regime_exit_governor_v2_summary.json",
  },
};

const SANITY_GATE = Object.freeze({
  eachBaseEndingEquityUsdAtLeast: 100,
  eachStressEndingEquityUsdAtLeast: 100,
  eachBaseMaxDrawdownPctAtMost: 5,
  eachStressMaxDrawdownPctAtMost: 6,
  eachMinTradesTaken: 12,
  combinedStressEndingEquityUsdAtLeast: 100,
  maxMarginUtilizationPctAtMost: POLICY.maxMarginUtilizationPct,
  maxOpenRiskPctAtMost: POLICY.maxOpenRiskPctEquity,
});

function parseTs(v) {
  const x = Date.parse(String(v || ""));
  return Number.isFinite(x) ? x : null;
}

function windowsDisjoint(summaries) {
  const windows = Object.entries(summaries).map(([name, x]) => ({
    name,
    start: parseTs(x?.replayWindow?.start),
    end: parseTs(x?.replayWindow?.end),
  }));
  if (windows.some((x) => !Number.isFinite(x.start) || !Number.isFinite(x.end) || x.start > x.end)) return false;
  windows.sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].start <= windows[i - 1].end) return false;
  }
  return true;
}

function passPeriod(base, stress) {
  return (
    base.endingEquityUsd >= SANITY_GATE.eachBaseEndingEquityUsdAtLeast &&
    stress.endingEquityUsd >= SANITY_GATE.eachStressEndingEquityUsdAtLeast &&
    base.maxDrawdownPct <= SANITY_GATE.eachBaseMaxDrawdownPctAtMost &&
    stress.maxDrawdownPct <= SANITY_GATE.eachStressMaxDrawdownPctAtMost &&
    Math.min(base.tradesTaken, stress.tradesTaken) >= SANITY_GATE.eachMinTradesTaken &&
    Math.max(base.maxMarginUtilizationPct, stress.maxMarginUtilizationPct) <= SANITY_GATE.maxMarginUtilizationPctAtMost &&
    Math.max(base.maxOpenRiskPctObserved, stress.maxOpenRiskPctObserved) <= SANITY_GATE.maxOpenRiskPctAtMost + 1e-9
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const eventsByName = {};
  const summaries = {};
  for (const [name, paths] of Object.entries(INPUTS)) {
    eventsByName[name] = JSON.parse(await readFile(paths.events, "utf8"));
    summaries[name] = JSON.parse(await readFile(paths.summary, "utf8"));
    if (!Array.isArray(eventsByName[name]) || eventsByName[name].length < 100) {
      throw new Error(`${name} governor population unexpectedly small`);
    }
    if (summaries[name]?.policyVersion !== POLICY_VERSION || summaries[name]?.policyFingerprint !== policyFingerprint()) {
      throw new Error(`${name} policy fingerprint drift`);
    }
  }

  if (!windowsDisjoint(summaries)) throw new Error("Consumed OOS windows overlap or are invalid");

  const results = {};
  let all = [];
  for (const name of Object.keys(INPUTS)) {
    const events = eventsByName[name];
    const base = simulateAdaptiveV2(events, "BASE");
    const stress = simulateAdaptiveV2(events, "STRESS");
    results[name] = {
      datasetId: summaries[name]?.dataset?.id ?? summaries[name]?.dataset?.datasetId ?? null,
      replayWindow: summaries[name]?.replayWindow ?? null,
      governorPopulation: summaries[name]?.sourcePopulation ?? null,
      BASE: base,
      STRESS: stress,
      sanityPass: passPeriod(base, stress),
    };
    all = all.concat(events);
  }

  const combined = {
    BASE: simulateAdaptiveV2(all, "BASE"),
    STRESS: simulateAdaptiveV2(all, "STRESS"),
  };

  const pass = (
    Object.values(results).every((x) => x.sanityPass === true) &&
    combined.STRESS.endingEquityUsd >= SANITY_GATE.combinedStressEndingEquityUsdAtLeast &&
    combined.STRESS.maxMarginUtilizationPct <= SANITY_GATE.maxMarginUtilizationPctAtMost &&
    combined.STRESS.maxOpenRiskPctObserved <= SANITY_GATE.maxOpenRiskPctAtMost + 1e-9
  );

  const output = {
    version: VERSION,
    mode: "CONSUMED_OOS1_OOS2_OOS3_SANITY_ONLY",
    policyVersion: POLICY_VERSION,
    policyFingerprint: policyFingerprint(),
    lockedPolicy: POLICY,
    preregisteredSanityGate: SANITY_GATE,
    consumedWindowsDisjoint: true,
    results,
    combined,
    decision: pass ? "LOCK_POLICY_FOR_FRESH_OOS4" : "STOP_DO_NOT_CONSUME_OOS4",
    integrity: {
      usesConsumedDataOnly: true,
      freshOos4Read: false,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    notes: [
      "This lab does not tune thresholds from outcomes; the V2 policy is code-locked before OOS4.",
      "Leverage changes modeled margin requirement only; risk percentage controls modeled PnL exposure.",
      "OOS4 must not be built unless decision equals LOCK_POLICY_FOR_FRESH_OOS4.",
    ],
  };

  await writeFile(`${OUT_DIR}/v4_regime_exit_v2_lab_summary.json`, JSON.stringify(output, null, 2), "utf8");
  console.log("===== V4 REGIME + EXIT + ADAPTIVE V2 CONSUMED LAB =====");
  console.log(JSON.stringify(output, null, 2));
}

await main();
