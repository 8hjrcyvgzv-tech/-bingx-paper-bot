// V4 CLEAN CORE — ADAPTIVE RISK + LEVERAGE DIAGNOSTIC LAB
// CONSUMED OOS1 + OOS2 ONLY. NOT FRESH VALIDATION.
// NO PAPER / NO LIVE / NO ORDERS.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  VERSION as POLICY_VERSION,
  ADAPTIVE_POLICY,
  FIXED_REFERENCE,
  simulateAdaptive,
  simulateFixedReference,
  policyFingerprint,
} from "./v4_adaptive_risk_leverage.mjs";

const VERSION = "V4_ADAPTIVE_RISK_LEVERAGE_LAB_1";
const OOS1_EVENTS = process.env.OOS1_EVENTS_PATH || "consumed/oos1/artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";
const OOS2_EVENTS = process.env.OOS2_EVENTS_PATH || "consumed/oos2/artifacts/oos_costs/v4_structure_exit_oos_costs_events.json";

const SANITY = Object.freeze({
  minTradesTakenPct: 60,
  maxAdaptiveDrawdownPct: 15,
  maxMarginUtilizationPct: 70,
  stressCatastropheFloorUsd: 90,
  minDistinctTiersCombined: 3,
});

function validEvents(rows) {
  return (Array.isArray(rows) ? rows : []).filter((x) => (
    Number.isFinite(Number(x?.timestampMs)) &&
    Number.isFinite(Number(x?.model?.costScenarios?.BASE?.netResultR)) &&
    Number.isFinite(Number(x?.model?.costScenarios?.STRESS?.netResultR))
  ));
}

function runSet(name, events) {
  return {
    name,
    population: events.length,
    fixed: {
      BASE: simulateFixedReference(events, "BASE"),
      STRESS: simulateFixedReference(events, "STRESS"),
    },
    adaptive: {
      BASE: simulateAdaptive(events, "BASE"),
      STRESS: simulateAdaptive(events, "STRESS"),
    },
  };
}

function passes(result) {
  for (const x of [result.adaptive.BASE, result.adaptive.STRESS]) {
    if (x.tradesTakenPct < SANITY.minTradesTakenPct) return false;
    if (x.maxDrawdownPct > SANITY.maxAdaptiveDrawdownPct) return false;
    if (x.maxMarginUtilizationPct > SANITY.maxMarginUtilizationPct) return false;
  }
  return result.adaptive.STRESS.endingEquityUsd >= SANITY.stressCatastropheFloorUsd;
}

async function main() {
  const [a, b] = await Promise.all([
    readFile(OOS1_EVENTS, "utf8").then(JSON.parse),
    readFile(OOS2_EVENTS, "utf8").then(JSON.parse),
  ]);
  const oos1 = validEvents(a);
  const oos2 = validEvents(b);
  if (oos1.length < 100 || oos2.length < 100) {
    throw new Error(`Unexpected diagnostic populations OOS1=${oos1.length} OOS2=${oos2.length}`);
  }

  const r1 = runSet("CONSUMED_OOS1", oos1);
  const r2 = runSet("CONSUMED_OOS2", oos2);
  const combined = simulateAdaptive([...oos1, ...oos2], "STRESS");
  const tierPass = combined.distinctRiskTiersUsed >= SANITY.minDistinctTiersCombined;
  const sanityPass = passes(r1) && passes(r2) && tierPass;

  const output = {
    version: VERSION,
    mode: "CONSUMED_OOS1_OOS2_DIAGNOSTIC_ONLY",
    policyVersion: POLICY_VERSION,
    policyFingerprint: policyFingerprint(),
    lockedAdaptivePolicy: ADAPTIVE_POLICY,
    fixedReference: FIXED_REFERENCE,
    sanityScreen: SANITY,
    results: { OOS1: r1, OOS2: r2, combinedStressAdaptive: combined },
    decision: sanityPass ? "LOCK_POLICY_FOR_FRESH_OOS3" : "STOP_BEFORE_OOS3_REDESIGN_REQUIRED",
    integrity: {
      productionFilesModified: false,
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
    },
    notes: [
      "This lab uses consumed OOS1/OOS2 only; it is a sanity check, not fresh validation.",
      "The adaptive thresholds are not re-fit from these outcomes.",
      "If OOS3 runs, the policy fingerprint must match exactly.",
    ],
  };

  await mkdir("diagnostics/adaptive_lab", { recursive: true });
  await writeFile("diagnostics/adaptive_lab/v4_adaptive_risk_leverage_lab_summary.json", JSON.stringify(output, null, 2), "utf8");

  console.log("===== V4 ADAPTIVE RISK + LEVERAGE LAB =====");
  console.log(JSON.stringify({
    OOS1: r1,
    OOS2: r2,
    combinedStressAdaptive: {
      avgActualRiskPct: combined.avgActualRiskPct,
      avgLeverage: combined.avgLeverage,
      distinctRiskTiersUsed: combined.distinctRiskTiersUsed,
      maxOpenRiskPctObserved: combined.maxOpenRiskPctObserved,
      maxMarginUtilizationPct: combined.maxMarginUtilizationPct,
    },
    decision: output.decision,
    integrity: output.integrity,
  }, null, 2));
}

await main();
