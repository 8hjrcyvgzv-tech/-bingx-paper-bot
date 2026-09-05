// V4 CLEAN CORE — FINAL FRESH OOS4 REGIME + EXIT + ADAPTIVE V2 LOCKED GATE
// RESEARCH / HISTORICAL ONLY. NO PAPER / NO LIVE / NO ORDERS.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  VERSION as POLICY_VERSION,
  POLICY,
  policyFingerprint,
  simulateAdaptiveV2,
} from "./v4_regime_exit_adaptive_v2.mjs";

const VERSION = "V4_OOS4_REGIME_EXIT_LOCKED_1";
const EVENTS_PATH = process.env.OOS4_GOV_EVENTS || "artifacts/regime_exit_v2/v4_regime_exit_governor_v2_events.json";
const GOV_SUMMARY_PATH = process.env.OOS4_GOV_SUMMARY || "artifacts/regime_exit_v2/v4_regime_exit_governor_v2_summary.json";
const LAB_SUMMARY_PATH = process.env.REGIME_V2_LAB_SUMMARY || "diagnostics/regime_exit_v2_lab/v4_regime_exit_v2_lab_summary.json";
const OUT_DIR = process.env.OOS4_OUTPUT_DIR || "artifacts/oos4_regime_exit";

const FINAL_GATE = Object.freeze({
  baseEndingEquityUsdAtLeast: 100,
  stressEndingEquityUsdAtLeast: 100,
  baseMaxDrawdownPctAtMost: 5,
  stressMaxDrawdownPctAtMost: 6,
  minTradesTaken: 10,
  minEligibleEvents: 10,
  minStressProfitFactorUsd: 1.0,
  maxMarginUtilizationPctAtMost: POLICY.maxMarginUtilizationPct,
  maxOpenRiskPctAtMost: POLICY.maxOpenRiskPctEquity,
});

function startsWithDay(value, day) {
  return String(value || "").startsWith(day);
}

function finalPass(base, stress) {
  return (
    base.endingEquityUsd >= FINAL_GATE.baseEndingEquityUsdAtLeast &&
    stress.endingEquityUsd >= FINAL_GATE.stressEndingEquityUsdAtLeast &&
    base.maxDrawdownPct <= FINAL_GATE.baseMaxDrawdownPctAtMost &&
    stress.maxDrawdownPct <= FINAL_GATE.stressMaxDrawdownPctAtMost &&
    Math.min(base.tradesTaken, stress.tradesTaken) >= FINAL_GATE.minTradesTaken &&
    Math.min(base.eligibleEvents, stress.eligibleEvents) >= FINAL_GATE.minEligibleEvents &&
    Number.isFinite(stress.profitFactorUsd) && stress.profitFactorUsd >= FINAL_GATE.minStressProfitFactorUsd &&
    Math.max(base.maxMarginUtilizationPct, stress.maxMarginUtilizationPct) <= FINAL_GATE.maxMarginUtilizationPctAtMost &&
    Math.max(base.maxOpenRiskPctObserved, stress.maxOpenRiskPctObserved) <= FINAL_GATE.maxOpenRiskPctAtMost + 1e-9
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const [events, governor, lab] = await Promise.all([
    readFile(EVENTS_PATH, "utf8").then(JSON.parse),
    readFile(GOV_SUMMARY_PATH, "utf8").then(JSON.parse),
    readFile(LAB_SUMMARY_PATH, "utf8").then(JSON.parse),
  ]);

  if (!Array.isArray(events) || events.length < 100) throw new Error(`Unexpected OOS4 governor population ${events?.length}`);
  if (lab?.decision !== "LOCK_POLICY_FOR_FRESH_OOS4") throw new Error(`Consumed lab did not lock OOS4: ${lab?.decision}`);
  if (lab?.policyVersion !== POLICY_VERSION || lab?.policyFingerprint !== policyFingerprint()) throw new Error("Consumed lab policy drifted");
  if (governor?.policyVersion !== POLICY_VERSION || governor?.policyFingerprint !== policyFingerprint()) throw new Error("OOS4 governor policy drifted");

  const layout = governor?.dataset?.layout || {};
  const replay = governor?.replayWindow || {};
  if (!startsWithDay(layout.datasetStart, "2023-12-04") ||
      !startsWithDay(layout.replayStart, "2024-03-13") ||
      !startsWithDay(layout.replayEnd, "2024-06-20") ||
      !startsWithDay(layout.datasetEnd, "2024-06-21")) {
    throw new Error(`OOS4 dataset boundary mismatch: ${JSON.stringify(layout)}`);
  }
  if (!startsWithDay(replay.start, "2024-03-13") || !startsWithDay(replay.end, "2024-06-20")) {
    throw new Error(`OOS4 replay boundary mismatch: ${JSON.stringify(replay)}`);
  }

  const consumedStarts = Object.values(lab?.results || {})
    .map((x) => Date.parse(String(x?.replayWindow?.start || "")))
    .filter(Number.isFinite);
  const oos4End = Date.parse(String(replay.end || ""));
  if (consumedStarts.length !== 3 || !Number.isFinite(oos4End) || !(oos4End < Math.min(...consumedStarts))) {
    throw new Error("OOS4 is not chronologically disjoint and earlier than consumed OOS1/OOS2/OOS3");
  }

  const base = simulateAdaptiveV2(events, "BASE");
  const stress = simulateAdaptiveV2(events, "STRESS");
  const pass = finalPass(base, stress);

  const output = {
    version: VERSION,
    mode: "FRESH_OOS4_FINAL_LOCKED_VALIDATION_ONLY",
    dataset: governor?.dataset ?? null,
    replayWindow: governor?.replayWindow ?? null,
    lockedBeforeOos4: {
      policyVersion: POLICY_VERSION,
      policyFingerprint: policyFingerprint(),
      policy: POLICY,
      consumedLabDecision: lab.decision,
      consumedLabFingerprintMatches: true,
      noCoinDirectionManualExclusions: true,
    },
    governorPopulation: governor?.sourcePopulation ?? null,
    preregisteredFinalGate: FINAL_GATE,
    results: { BASE: base, STRESS: stress },
    decision: pass ? "PROMOTE_TO_72H_RUNNER_RESEARCH" : "HOLD_RESEARCH_ONLY",
    integrity: {
      freshOos4ChronologicallyDisjoint: true,
      policyLockedBeforeOos4: true,
      pointInTimeOnly: true,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    nextStep: pass
      ? "Run one 72h+ runner research gate with the same locked entry/regime/risk policy. PAPER remains disabled until that gate passes."
      : "Do not run 72h runner or PAPER. Return to strategy architecture; do not tune on OOS4.",
    caveats: [
      "BASE/STRESS costs remain conservative synthetic stresses, not realized venue-native BingX funding history.",
      "Leverage changes modeled margin requirement only; liquidation and maintenance-margin mechanics are not modeled yet.",
      "Binance USD-M data remains a proxy for BingX; DOGE volume proxy caveat remains.",
      "OOS4 is final fresh validation for this V2 policy and must not be used for retuning.",
    ],
  };

  await writeFile(`${OUT_DIR}/v4_oos4_regime_exit_locked_summary.json`, JSON.stringify(output, null, 2), "utf8");
  console.log("===== V4 FINAL FRESH OOS4 REGIME + EXIT + ADAPTIVE V2 =====");
  console.log(JSON.stringify(output, null, 2));
}

await main();
