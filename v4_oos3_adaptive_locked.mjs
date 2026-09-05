// V4 CLEAN CORE — FRESH OOS3 ADAPTIVE LOCKED VALIDATION
// RESEARCH / HISTORICAL ONLY. NO PAPER / NO LIVE / NO ORDERS.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  VERSION as POLICY_VERSION,
  ADAPTIVE_POLICY,
  FIXED_REFERENCE,
  simulateAdaptive,
  simulateFixedReference,
  policyFingerprint,
} from "./v4_adaptive_risk_leverage.mjs";

const VERSION = "V4_OOS3_ADAPTIVE_LOCKED_1";
const EVENTS_PATH = process.env.OOS3_EVENTS_PATH || "artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";
const COST_SUMMARY_PATH = process.env.OOS3_COST_SUMMARY_PATH || "artifacts/oos_costs/v4_structure_exit_oos_costs_summary.json";
const REPLAY_SUMMARY_PATH = process.env.OOS3_REPLAY_SUMMARY_PATH || "artifacts/v4_replay_summary.json";
const DIAGNOSTIC_PATH = process.env.ADAPTIVE_DIAGNOSTIC_PATH || "diagnostics/adaptive_lab/v4_adaptive_risk_leverage_lab_summary.json";

const GATE = Object.freeze({
  baseEndingEquityUsdAtLeast: 100,
  stressEndingEquityUsdAtLeast: 100,
  baseMaxDrawdownPctAtMost: 10,
  stressMaxDrawdownPctAtMost: 12,
  minTradesTakenPct: 60,
  maxMarginUtilizationPctAtMost: 70,
  minDistinctTiersUsed: 3,
});

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function gatePass(base, stress) {
  return (
    base.endingEquityUsd >= GATE.baseEndingEquityUsdAtLeast &&
    stress.endingEquityUsd >= GATE.stressEndingEquityUsdAtLeast &&
    base.maxDrawdownPct <= GATE.baseMaxDrawdownPctAtMost &&
    stress.maxDrawdownPct <= GATE.stressMaxDrawdownPctAtMost &&
    Math.min(base.tradesTakenPct, stress.tradesTakenPct) >= GATE.minTradesTakenPct &&
    Math.max(base.maxMarginUtilizationPct, stress.maxMarginUtilizationPct) <= GATE.maxMarginUtilizationPctAtMost &&
    Math.min(base.distinctRiskTiersUsed, stress.distinctRiskTiersUsed) >= GATE.minDistinctTiersUsed
  );
}

async function main() {
  const [eventsRaw, costs, replay, diagnostic] = await Promise.all([
    readFile(EVENTS_PATH, "utf8").then(JSON.parse),
    readFile(COST_SUMMARY_PATH, "utf8").then(JSON.parse),
    readFile(REPLAY_SUMMARY_PATH, "utf8").then(JSON.parse),
    readFile(DIAGNOSTIC_PATH, "utf8").then(JSON.parse),
  ]);

  if (diagnostic?.decision !== "LOCK_POLICY_FOR_FRESH_OOS3") throw new Error(`Adaptive policy not locked: ${diagnostic?.decision}`);
  if (diagnostic?.policyVersion !== POLICY_VERSION) throw new Error("Adaptive policy version drifted");
  if (diagnostic?.policyFingerprint !== policyFingerprint()) throw new Error("Adaptive policy fingerprint drifted");

  const replayStart = String(replay?.replayWindow?.start || "");
  const replayEnd = String(replay?.replayWindow?.end || "");
  const datasetStart = String(replay?.dataset?.layout?.datasetStart || "");
  const datasetEnd = String(replay?.dataset?.layout?.datasetEnd || "");
  if (!datasetStart.startsWith("2024-06-22") || !datasetEnd.startsWith("2025-01-08")) {
    throw new Error(`OOS3 dataset boundary mismatch: ${datasetStart} -> ${datasetEnd}`);
  }
  if (!replayStart.startsWith("2024-09-30") || !replayEnd.startsWith("2025-01-07")) {
    throw new Error(`OOS3 replay boundary mismatch: ${replayStart} -> ${replayEnd}`);
  }

  if (n(costs?.candidateLockedBeforeRun?.strongRadarThreshold) !== 7) throw new Error("Strong Radar threshold drifted");
  const allocation = costs?.candidateLockedBeforeRun?.allocation;
  if (n(allocation?.tp1) !== 0.6 || n(allocation?.tp2) !== 0.3 || n(allocation?.runner) !== 0.1) {
    throw new Error("Structure Exit allocation drifted");
  }

  const events = (Array.isArray(eventsRaw) ? eventsRaw : []).filter((x) => (
    Number.isFinite(Number(x?.timestampMs)) &&
    Number.isFinite(Number(x?.model?.costScenarios?.BASE?.netResultR)) &&
    Number.isFinite(Number(x?.model?.costScenarios?.STRESS?.netResultR))
  ));
  if (events.length < 100 || events.length !== eventsRaw.length) throw new Error(`Unexpected OOS3 population ${events.length}/${eventsRaw?.length}`);

  const adaptiveBase = simulateAdaptive(events, "BASE");
  const adaptiveStress = simulateAdaptive(events, "STRESS");
  const fixedBase = simulateFixedReference(events, "BASE");
  const fixedStress = simulateFixedReference(events, "STRESS");
  const pass = gatePass(adaptiveBase, adaptiveStress);

  const output = {
    version: VERSION,
    mode: "FRESH_OOS3_ADAPTIVE_LOCKED_VALIDATION_ONLY",
    dataset: replay?.dataset ?? null,
    replayWindow: replay?.replayWindow ?? null,
    sourcePopulation: {
      frozenSignals: costs?.population?.frozenSignals ?? null,
      strongRadarSignals: events.length,
      strongRadarRetentionPct: costs?.population?.strongRadarRetentionPct ?? null,
    },
    lockedBeforeOos3: {
      strategy: "Strong Radar >=7 + Structure Exit A 60/30/10",
      adaptivePolicyVersion: POLICY_VERSION,
      adaptivePolicyFingerprint: policyFingerprint(),
      adaptivePolicy: ADAPTIVE_POLICY,
      fixedReference: FIXED_REFERENCE,
      noCoinDirectionStructureExclusions: true,
    },
    preregisteredOos3Gate: GATE,
    results: {
      adaptive: { BASE: adaptiveBase, STRESS: adaptiveStress },
      fixedReference: { BASE: fixedBase, STRESS: fixedStress },
    },
    decision: pass ? "PROMOTE_TO_72H_RUNNER_RESEARCH" : "HOLD_RESEARCH_ONLY",
    integrity: {
      freshOos3NoOverlapWithOos2: true,
      policyFingerprintLockedBeforeOos3: true,
      pointInTimeOnly: true,
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    caveats: [
      "Risk budget changes PnL exposure; leverage changes modeled margin requirement only.",
      "Liquidation and maintenance-margin mechanics are not modeled yet.",
      "BASE/STRESS costs are conservative synthetic stresses, not realized venue-native BingX funding.",
      "DOGE volume remains a Binance proxy caveat.",
      "PROMOTE means 72h+ runner research only; PAPER and LIVE remain disabled.",
    ],
  };

  await mkdir("artifacts/oos3_adaptive", { recursive: true });
  await writeFile("artifacts/oos3_adaptive/v4_oos3_adaptive_locked_summary.json", JSON.stringify(output, null, 2), "utf8");
  console.log("===== V4 FRESH OOS3 ADAPTIVE LOCKED =====");
  console.log(JSON.stringify(output, null, 2));
}

await main();
