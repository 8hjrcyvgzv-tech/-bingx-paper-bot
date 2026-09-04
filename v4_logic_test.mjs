// V4 deterministic logic checks.
// No network, no orders.

import assert from "node:assert/strict";

import {
  analyzeV4Catalyst,
} from "./v4_catalyst.js";

const NOW = Date.UTC(
  2026,
  8,
  4,
  12,
  0,
  0
);

const neutral =
  analyzeV4Catalyst({
    symbol: "XRP-USDT",
    direction: "LONG",
    nowTs: NOW,
    catalysts: [],
  });

assert.equal(
  neutral.score,
  5,
  "missing catalyst must stay neutral"
);

assert.equal(
  neutral.tradePermission,
  false,
  "catalyst must never grant trade permission"
);

const bullish =
  analyzeV4Catalyst({
    symbol: "XRP-USDT",
    direction: "LONG",
    nowTs: NOW,
    catalysts: [
      {
        ts: NOW - 60 * 60 * 1000,
        symbol: "XRP-USDT",
        sentiment: "BULLISH",
        impact: 5,
        relevance: 1,
        confidence: 1,
        sourceTier: 1,
        category: "REGULATORY",
        title: "confirmed positive catalyst",
      },
    ],
  });

assert.ok(
  bullish.score > 5,
  "bullish catalyst must support LONG"
);

const bullishForShort =
  analyzeV4Catalyst({
    symbol: "XRP-USDT",
    direction: "SHORT",
    nowTs: NOW,
    catalysts: [
      {
        ts: NOW - 60 * 60 * 1000,
        symbol: "XRP-USDT",
        sentiment: "BULLISH",
        impact: 5,
        relevance: 1,
        confidence: 1,
        sourceTier: 1,
        category: "REGULATORY",
      },
    ],
  });

assert.ok(
  bullishForShort.score < 5,
  "bullish catalyst must work against SHORT"
);

const futureLeak =
  analyzeV4Catalyst({
    symbol: "XRP-USDT",
    direction: "LONG",
    nowTs: NOW,
    catalysts: [
      {
        ts: NOW + 60 * 1000,
        symbol: "XRP-USDT",
        sentiment: "BULLISH",
        impact: 5,
        relevance: 1,
        confidence: 1,
        sourceTier: 1,
        category: "ETF",
      },
    ],
  });

assert.equal(
  futureLeak.consideredEvents,
  0,
  "future catalyst must be rejected"
);

assert.equal(
  futureLeak.score,
  5,
  "future catalyst must not alter score"
);

const bearish =
  analyzeV4Catalyst({
    symbol: "ZEC-USDT",
    direction: "SHORT",
    nowTs: NOW,
    catalysts: [
      {
        ts: NOW - 30 * 60 * 1000,
        symbol: "ZEC-USDT",
        sentiment: "BEARISH",
        impact: 5,
        relevance: 1,
        confidence: 1,
        sourceTier: 1,
        category: "HACK",
      },
    ],
  });

assert.ok(
  bearish.score > 5,
  "bearish catalyst must support SHORT"
);

console.log("V4 CATALYST LOGIC: PASS");
