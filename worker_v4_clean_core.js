// BingX V4 Clean Core
// Champions League Integration
// TEST / REPLAY ONLY — REAL ORDERS DISABLED

import {
  analyzeV4Radar,
  V4_RADAR_VERSION,
} from "./v4_radar.js";

import {
  analyzeV4Direction,
  V4_DIRECTION_VERSION,
} from "./v4_direction.js";

import {
  analyzeV4Structure,
  V4_STRUCTURE_VERSION,
} from "./v4_structure.js";

import {
  analyzeV4Flow,
  V4_FLOW_VERSION,
} from "./v4_flow.js";

import {
  analyzeV4Execution,
  V4_EXECUTION_VERSION,
} from "./v4_execution.js";

const VERSION = "V4_CLEAN_CORE_INTEGRATED_1";

const TEAM = {
  RADAR: "BELIT",
  DIRECTION: "EMRE",
  STRUCTURE: "AKSEL",
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Number.isFinite(v)
    ? Math.round(v * 100) / 100
    : null;
}

function validDirection(v) {
  return v === "LONG" || v === "SHORT";
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      time: Number(
        x?.time ??
        x?.openTime ??
        x?.ts ??
        0
      ),
      open: Number(x?.open),
      high: Number(x?.high),
      low: Number(x?.low),
      close: Number(x?.close),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close) &&
        x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function atr(rows, period = 14) {
  const candles = normalizeCandles(rows);

  if (candles.length <= period) {
    return null;
  }

  const start = Math.max(
    1,
    candles.length - period
  );

  const values = [];

  for (
    let i = start;
    i < candles.length;
    i++
  ) {
    const row = candles[i];
    const prevClose =
      candles[i - 1].close;

    values.push(
      Math.max(
        row.high - row.low,
        Math.abs(
          row.high - prevClose
        ),
        Math.abs(
          row.low - prevClose
        )
      )
    );
  }

  if (!values.length) {
    return null;
  }

  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  );
}

function latestPrice(input) {
  const direct =
    num(input?.currentPrice) ??
    num(input?.price) ??
    num(input?.entry);

  if (direct !== null && direct > 0) {
    return direct;
  }

  const snapshots =
    input?.snapshots ??
    input?.priceSnapshots ??
    [];

  const snapshotPrice =
    num(
      snapshots.at(-1)?.price ??
      snapshots.at(-1)?.lastPrice ??
      snapshots.at(-1)?.close
    );

  if (
    snapshotPrice !== null &&
    snapshotPrice > 0
  ) {
    return snapshotPrice;
  }

  for (const key of [
    "candles15m",
    "candles1h",
    "candles4h",
  ]) {
    const rows =
      Array.isArray(input?.[key])
        ? input[key]
        : [];

    const price =
      num(rows.at(-1)?.close);

    if (
      price !== null &&
      price > 0
    ) {
      return price;
    }
  }

  return null;
}

function fallbackStop(
  input,
  direction,
  entry,
  atr15m
) {
  const explicit =
    num(
      input?.stop ??
      input?.invalidation
    );

  if (explicit !== null) {
    return explicit;
  }

  if (
    !validDirection(direction) ||
    !(entry > 0)
  ) {
    return null;
  }

  const candles15m =
    normalizeCandles(
      input?.candles15m
    );

  const candles1h =
    normalizeCandles(
      input?.candles1h
    );

  const sample =
    candles15m.length >= 8
      ? candles15m.slice(-12)
      : candles1h.slice(-8);

  if (!sample.length) {
    return null;
  }

  const a =
    atr15m ??
    atr(input?.candles1h) ??
    entry * 0.005;

  const buffer =
    Math.max(
      a * 0.20,
      entry * 0.0005
    );

  if (direction === "LONG") {
    return (
      Math.min(
        ...sample.map(
          (x) => x.low
        )
      ) - buffer
    );
  }

  return (
    Math.max(
      ...sample.map(
        (x) => x.high
      )
    ) + buffer
  );
}

function systemInfo() {
  return {
    version: VERSION,

    mode:
      "TEST_REPLAY_ONLY",

    architecture: [
      "RADAR",
      "DIRECTION",
      "STRUCTURE",
      "FLOW",
      "EXECUTION",
    ],

    modules: {
      radar:
        V4_RADAR_VERSION,

      direction:
        V4_DIRECTION_VERSION,

      structure:
        V4_STRUCTURE_VERSION,

      flow:
        V4_FLOW_VERSION,

      execution:
        V4_EXECUTION_VERSION,
    },

    team: TEAM,

    core5: CORE5,

    status:
      "TEAM_CONNECTED",

    scannerEnabled: false,

    paperOrdersEnabled: false,

    realOrdersEnabled: false,
  };
}

export function runV4CleanCore(
  input = {}
) {
  const symbol = String(
    input?.symbol || ""
  ).toUpperCase();

  // 1 — BELIT / RADAR
  const radar =
    analyzeV4Radar({
      symbol,

      snapshots:
        input?.snapshots ??
        input?.priceSnapshots,

      nowTs:
        input?.nowTs,

      quoteVolume24h:
        input?.quoteVolume24h,

      spreadPct:
        input?.spreadPct,

      compressionRatio:
        input?.compressionRatio,

      distanceToBreakoutPct:
        input?.distanceToBreakoutPct,
    });

  // 2 — EMRE / DIRECTION
  const direction =
    analyzeV4Direction({
      symbol,

      radarDirection:
        radar?.direction,

      candles4h:
        input?.candles4h,

      candles12h:
        input?.candles12h,

      candles1d:
        input?.candles1d,
    });

  const htfDirection =
    validDirection(
      direction?.direction
    ) &&
    Number(direction?.score) >= 5.5
      ? direction.direction
      : null;

  const radarDirection =
    validDirection(
      radar?.direction
    )
      ? radar.direction
      : null;

  const selectedDirection =
    htfDirection ??
    radarDirection ??
    "NEUTRAL";

  // 3 — AKSEL / STRUCTURE
  const structure =
    analyzeV4Structure({
      symbol,

      direction:
        selectedDirection,

      candles15m:
        input?.candles15m,

      candles1h:
        input?.candles1h,

      candles4h:
        input?.candles4h,
    });

  // 4 — DORUK / FLOW
  const flow =
    analyzeV4Flow({
      symbol,

      direction:
        selectedDirection,

      prices:
        input?.prices ??
        input?.priceSnapshots ??
        input?.snapshots,

      spotCvd:
        input?.spotCvd,

      futuresCvd:
        input?.futuresCvd,

      openInterest:
        input?.openInterest,

      fundingRate:
        input?.fundingRate ??
        input?.funding,

      liquidations:
        input?.liquidations,

      nowTs:
        input?.nowTs,
    });

  // 5 — MR TRADER / EXECUTION
  const entry =
    latestPrice(input);

  const atr15m =
    atr(
      input?.candles15m
    );

  const stop =
    fallbackStop(
      input,
      selectedDirection,
      entry,
      atr15m
    );

  const execution =
    analyzeV4Execution({
      symbol,

      direction:
        selectedDirection,

      currentPrice:
        entry,

      entry,

      stop,

      invalidation:
        stop,

      atr15m,

      tp1:
        input?.tp1 ??
        input?.target1,

      tp2:
        input?.tp2 ??
        input?.target2,

      radar,

      directionEngine:
        direction,

      structure,

      flow,
    });

  return {
    version: VERSION,

    symbol,

    selectedDirection,

    pipeline: {
      radar,
      direction,
      structure,
      flow,
      execution,
    },

    summary: {
      decision:
        execution?.decision ??
        "PASS",

      finalScore:
        execution?.finalScore ??
        0,

      entry:
        execution?.entry ??
        round2(entry),

      stop:
        execution?.stop ??
        round2(stop),

      tp1:
        execution?.tp1 ??
        null,

      tp2:
        execution?.tp2 ??
        null,

      rr:
        execution?.rr ??
        null,

      hardVeto:
        execution?.hardVeto === true,

      hardVetoReasons:
        execution
          ?.hardVetoReasons ??
        [],

      paperCandidate:
        execution
          ?.paperCandidate ===
        true,
    },

    safety: {
      scannerEnabled: false,
      paperOrdersEnabled: false,
      realOrdersEnabled: false,
      realOrderPermission: false,
    },
  };
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store",
      },
    }
  );
}

export default {
  async fetch(request) {
    try {
      const url =
        new URL(
          request.url
        );

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return json(
          systemInfo()
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return json({
          ok: true,
          ...systemInfo(),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/analyze"
      ) {
        const input =
          await request.json();

        return json(
          runV4CleanCore(
            input
          )
        );
      }

      return json(
        {
          error:
            "NOT_FOUND",

          routes: [
            "GET /",
            "GET /health",
            "POST /analyze",
          ],
        },
        404
      );
    } catch (error) {
      return json(
        {
          error:
            "V4_WORKER_ERROR",

          message:
            String(
              error?.message ??
              error
            ),

          realOrdersEnabled:
            false,
        },
        500
      );
    }
  },

  async scheduled() {
    // Bilerek NO-OP.
    // Replay + smoke test bitmeden
    // piyasa taraması veya emir yok.
    console.log(
      JSON.stringify({
        ...systemInfo(),

        scheduledAction:
          "NOOP_TEST_ONLY",
      })
    );
  },
};
