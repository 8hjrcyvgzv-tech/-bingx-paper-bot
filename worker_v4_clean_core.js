// BingX V4 Clean Core
// Champions League rebuild
// TEST / PAPER ONLY — REAL ORDER EXECUTION DISABLED

const VERSION = "V4_CLEAN_CORE";
const EXECUTION_MODE = "TEST";

const TEAM = {
  DIRECTION: "EMRE",
  STRUCTURE: "AKSEL",
  EARLY_MOVE: "BELIT",
  FLOW: "DORUK",
  EXECUTION: "MR_TRADER",
  PERFORMANCE: "TIBERIUS",
};

const CORE5 = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
];

// V4 philosophy:
// RADAR -> DIRECTION -> STRUCTURE -> FLOW -> EXECUTION
//
// Most evidence contributes SCORE.
// Only genuine risk/invalidation conditions may VETO a trade.
//
// NO REAL ORDERS until replay + PAPER evidence proves the system.

const HARD_VETO = {
  HTF_INVALIDATION: true,
  BAD_RISK_REWARD: true,
  EXTENDED_ENTRY: true,
  LIQUIDITY_RISK: true,
};

const WEIGHTS = {
  RADAR: 0.20,
  DIRECTION: 0.20,
  STRUCTURE: 0.20,
  FLOW: 0.20,
  EXECUTION: 0.20,
};

function systemInfo() {
  return {
    version: VERSION,
    executionMode: EXECUTION_MODE,
    architecture: [
      "RADAR",
      "DIRECTION",
      "STRUCTURE",
      "FLOW",
      "EXECUTION",
    ],
    team: TEAM,
    core5: CORE5,
    hardVeto: HARD_VETO,
    weights: WEIGHTS,
    status: "BOOTSTRAP",
    realOrdersEnabled: false,
  };
}

export default {
  async fetch() {
    return Response.json(systemInfo());
  },

  async scheduled() {
    console.log(JSON.stringify(systemInfo()));
  },
};
