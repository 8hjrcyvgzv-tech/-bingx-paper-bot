// BingX V4 Clean Core — FLOW
// Role owner: DORUK / DERIVATIVES & MICROSTRUCTURE
// Pure scoring module: same logic for LIVE SCAN + REPLAY.
// TEST / PAPER ONLY.
//
// Purpose:
// Spot CVD + Futures CVD + Open Interest + Funding
// + Liquidations + leverage/absorption risk.
//
// FLOW IS CONTEXT.
// It never opens a trade by itself.
//
// Missing derivatives data should NOT automatically kill a setup.
// Neutral flow score = 5/10.
// Strong evidence moves the score above/below neutral.

export const V4_FLOW_VERSION = "V4_FLOW_2";

export const V4_FLOW_CFG = {
  neutralScore: 5.0,
  supportiveScore: 5.75,
  strongScore: 7.0,
  againstScore: 4.25,

  // Open Interest change thresholds
  oi15SupportPct: 0.40,
  oi60SupportPct: 1.00,
  oi60StrongPct: 2.00,

  // Funding values are normalized to decimal.
  // Example: 0.01% => 0.0001
  fundingCrowded: 0.0005,
  fundingExtreme: 0.0010,

    liquidationRatio: 1.50,

  minUsefulCoverage: 0.30,

  // FLOW_2 — directional pressure
  pressureNeutralScore: 5.0,
  pressureStrongScore: 7.0,
  pressureDominantScore: 8.0,

  spotPressureWeight: 1.40,
  futuresPressureWeight: 0.80,
  oiPressureWeight: 0.60,
  liquidationPressureWeight: 0.40,

  leveragePressurePenalty: 1.00,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Number.isFinite(v)
    ? Math.round(v * 100) / 100
    : null;
}

function pct(from, to) {
  if (!(from > 0) || !Number.isFinite(to)) {
    return null;
  }

  return ((to - from) / from) * 100;
}

function normalizeScalarSeries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      ts: Number(
        x?.ts ??
        x?.time ??
        x?.openTime ??
        0
      ),

      value: Number(
        x?.value ??
        x?.close ??
        x?.cvd ??
        x?.oi ??
        x?.openInterest ??
        0
      ),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.ts > 0 &&
        Number.isFinite(x.value)
    )
    .sort((a, b) => a.ts - b.ts);
}

function normalizePriceSeries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      ts: Number(
        x?.ts ??
        x?.time ??
        x?.openTime ??
        0
      ),

      price: Number(
        x?.price ??
        x?.close ??
        x?.lastPrice ??
        0
      ),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.ts > 0 &&
        Number.isFinite(x.price) &&
        x.price > 0
    )
    .sort((a, b) => a.ts - b.ts);
}

function normalizeLiquidations(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      ts: Number(
        x?.ts ??
        x?.time ??
        0
      ),

      longUsd: Math.max(
        0,
        Number(
          x?.longUsd ??
          x?.longLiquidationsUsd ??
          0
        )
      ),

      shortUsd: Math.max(
        0,
        Number(
          x?.shortUsd ??
          x?.shortLiquidationsUsd ??
          0
        )
      ),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.ts > 0 &&
        Number.isFinite(x.longUsd) &&
        Number.isFinite(x.shortUsd)
    )
    .sort((a, b) => a.ts - b.ts);
}

function nearestBefore(rows, targetTs) {
  let found = null;

  for (const row of rows) {
    if (row.ts <= targetTs) {
      found = row;
    } else {
      break;
    }
  }

  return found;
}

function seriesDelta(
  rows,
  nowTs,
  minutes
) {
  const latest = rows.at(-1);

  if (!latest) return null;

  const past = nearestBefore(
    rows,
    nowTs - minutes * 60 * 1000
  );

  if (!past) return null;

  return latest.value - past.value;
}

function seriesPctChange(
  rows,
  nowTs,
  minutes
) {
  const latest = rows.at(-1);

  if (!latest) return null;

  const past = nearestBefore(
    rows,
    nowTs - minutes * 60 * 1000
  );

  if (!past) return null;

  return pct(
    Math.abs(past.value),
    Math.abs(latest.value)
  );
}

function priceReturn(
  rows,
  nowTs,
  minutes
) {
  const latest = rows.at(-1);

  if (!latest) return null;

  const past = nearestBefore(
    rows,
    nowTs - minutes * 60 * 1000
  );

  if (!past) return null;

  return pct(
    past.price,
    latest.price
  );
}

function directionalSign(
  value,
  direction
) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (direction === "LONG") {
    return value > 0;
  }

  if (direction === "SHORT") {
    return value < 0;
  }

  return null;
}
// ---------------------------------
// FLOW_2 — DEMAND / SUPPLY PRESSURE
// ---------------------------------
function pressureAlignment(
  delta15,
  delta60,
  direction
) {
  const aligned15 =
    directionalSign(
      delta15,
      direction
    );

  const aligned60 =
    directionalSign(
      delta60,
      direction
    );

  if (
    aligned15 === true &&
    aligned60 === true
  ) {
    return 1.0;
  }

  if (
    aligned15 === true ||
    aligned60 === true
  ) {
    return 0.5;
  }

  if (
    aligned15 === false &&
    aligned60 === false
  ) {
    return -1.0;
  }

  if (
    aligned15 === false ||
    aligned60 === false
  ) {
    return -0.5;
  }

  return 0;
}

function directionalPressureScore(
  direction,
  {
    spot15,
    spot60,
    futures15,
    futures60,
    oi15,
    oi60,
    price15,
    price60,
    liquidation,
  }
) {
  let score =
    V4_FLOW_CFG.pressureNeutralScore;

  const reasons = [];
  const warnings = [];

  // -----------------------------
  // SPOT PRESSURE
  // -----------------------------

  const spotPressure =
    pressureAlignment(
      spot15,
      spot60,
      direction
    );

  score +=
    spotPressure *
    V4_FLOW_CFG.spotPressureWeight;

  if (spotPressure >= 1) {
    reasons.push(
      direction === "LONG"
        ? "strong spot demand"
        : "strong spot supply"
    );
  } else if (spotPressure > 0) {
    reasons.push(
      direction === "LONG"
        ? "partial spot demand"
        : "partial spot supply"
    );
  }

  // -----------------------------
  // FUTURES PRESSURE
  // -----------------------------

  const futuresPressure =
    pressureAlignment(
      futures15,
      futures60,
      direction
    );

  score +=
    futuresPressure *
    V4_FLOW_CFG.futuresPressureWeight;

  if (futuresPressure >= 1) {
    reasons.push(
      direction === "LONG"
        ? "futures buying pressure"
        : "futures selling pressure"
    );
  }

  // -----------------------------
  // OPEN INTEREST
  // -----------------------------

  const priceAligned15 =
    directionalSign(
      price15,
      direction
    );

  const priceAligned60 =
    directionalSign(
      price60,
      direction
    );

  let oiPressure = 0;

  if (
    priceAligned60 === true &&
    oi60 !== null &&
    oi60 >=
      V4_FLOW_CFG.oi60SupportPct
  ) {
    oiPressure = 1.0;
  } else if (
    priceAligned15 === true &&
    oi15 !== null &&
    oi15 >=
      V4_FLOW_CFG.oi15SupportPct
  ) {
    oiPressure = 0.5;
  }

  if (
    priceAligned60 === false &&
    oi60 !== null &&
    oi60 >=
      V4_FLOW_CFG.oi60StrongPct
  ) {
    oiPressure = -1.0;

    warnings.push(
      "OI expands against pressure direction"
    );
  }

  score +=
    oiPressure *
    V4_FLOW_CFG.oiPressureWeight;

  if (oiPressure > 0) {
    reasons.push(
      "fresh OI supports pressure"
    );
  }

  // -----------------------------
  // LIQUIDATION PRESSURE
  // -----------------------------

  let liquidationPressure = 0;

  const supportingLiquidations =
    direction === "LONG"
      ? liquidation?.shortUsd ?? 0
      : liquidation?.longUsd ?? 0;

  const opposingLiquidations =
    direction === "LONG"
      ? liquidation?.longUsd ?? 0
      : liquidation?.shortUsd ?? 0;

  const liquidationRatio =
    supportingLiquidations /
    Math.max(
      opposingLiquidations,
      1
    );

  if (
    supportingLiquidations > 0 &&
    liquidationRatio >=
      V4_FLOW_CFG.liquidationRatio
  ) {
    liquidationPressure = 1.0;

    reasons.push(
      direction === "LONG"
        ? "short squeeze pressure"
        : "long liquidation pressure"
    );
  }

  score +=
    liquidationPressure *
    V4_FLOW_CFG
      .liquidationPressureWeight;

  // -----------------------------
  // LEVERAGE QUALITY
  // -----------------------------

  let leverageDriven = false;

  if (
    futuresPressure > 0 &&
    spotPressure <= 0
  ) {
    score -=
      V4_FLOW_CFG
        .leveragePressurePenalty;

    leverageDriven = true;

    warnings.push(
      "pressure is futures-led without spot confirmation"
    );
  }

  score =
    round2(
      clamp(
        score,
        0,
        10
      )
    );

  return {
    direction,
    score,

    spotPressure:
      round2(spotPressure),

    futuresPressure:
      round2(futuresPressure),

    oiPressure:
      round2(oiPressure),

    liquidationPressure:
      round2(
        liquidationPressure
      ),

    leverageDriven,

    reasons:
      [...new Set(reasons)],

    warnings:
      [...new Set(warnings)],
  };
}

function buildDemandSupplyPressure(
  data
) {
  const demand =
    directionalPressureScore(
      "LONG",
      data
    );

  const supply =
    directionalPressureScore(
      "SHORT",
      data
    );

  const demandScore =
    demand.score;

  const supplyScore =
    supply.score;

  const netPressure =
    round2(
      demandScore -
      supplyScore
    );

  let dominantSide =
    "BALANCED";

  let pressureStrength =
    "NEUTRAL";

  if (
    demandScore >=
      V4_FLOW_CFG
        .pressureStrongScore &&
    demandScore > supplyScore
  ) {
    dominantSide =
      "DEMAND";

    pressureStrength =
      "STRONG";
  }

  if (
    supplyScore >=
      V4_FLOW_CFG
        .pressureStrongScore &&
    supplyScore > demandScore
  ) {
    dominantSide =
      "SUPPLY";

    pressureStrength =
      "STRONG";
  }

  if (
    demandScore >=
      V4_FLOW_CFG
        .pressureDominantScore &&
    demandScore > supplyScore
  ) {
    dominantSide =
      "DEMAND";

    pressureStrength =
      "DOMINANT";
  }

  if (
    supplyScore >=
      V4_FLOW_CFG
        .pressureDominantScore &&
    supplyScore > demandScore
  ) {
    dominantSide =
      "SUPPLY";

    pressureStrength =
      "DOMINANT";
  }

  return {
    demandScore,
    supplyScore,
    netPressure,
    dominantSide,
    pressureStrength,
    demand,
    supply,
  };
}
function normalizeFundingRate(value) {
  const v = num(value);

  if (v === null) return null;

  // Some APIs express 0.01% as 0.01,
  // others express it as 0.0001.
  //
  // Values larger than 1% in decimal form are
  // extremely unlikely for normal funding,
  // so assume percentage notation if needed.
  if (Math.abs(v) > 0.01) {
    return v / 100;
  }

  return v;
}

function liquidationWindow(
  rows,
  nowTs,
  minutes = 60
) {
  const cutoff =
    nowTs - minutes * 60 * 1000;

  let longUsd = 0;
  let shortUsd = 0;

  for (const row of rows) {
    if (row.ts >= cutoff && row.ts <= nowTs) {
      longUsd += row.longUsd;
      shortUsd += row.shortUsd;
    }
  }

  return {
    longUsd,
    shortUsd,
  };
}

function cvdState(
  delta15,
  delta60,
  direction
) {
  const aligned15 =
    directionalSign(
      delta15,
      direction
    );

  const aligned60 =
    directionalSign(
      delta60,
      direction
    );

  let score = 0;

  if (
    aligned15 === true &&
    aligned60 === true
  ) {
    score = 1;
  } else if (
    aligned15 === true ||
    aligned60 === true
  ) {
    score = 0.5;
  } else if (
    aligned15 === false &&
    aligned60 === false
  ) {
    score = -1;
  } else if (
    aligned15 === false ||
    aligned60 === false
  ) {
    score = -0.5;
  }

  return {
    score,
    aligned15,
    aligned60,
  };
}

function fundingState(
  funding,
  direction
) {
  if (funding === null) {
    return {
      adjustment: 0,
      crowded: false,
      extreme: false,
      oppositeFunding: false,
    };
  }

  const sameSide =
    direction === "LONG"
      ? funding > 0
      : funding < 0;

  const oppositeSide =
    direction === "LONG"
      ? funding < 0
      : funding > 0;

  const absFunding =
    Math.abs(funding);

  let adjustment = 0;

  let crowded = false;
  let extreme = false;

  if (
    absFunding <
    V4_FLOW_CFG.fundingCrowded
  ) {
    adjustment += 0.20;
  }

  if (
    sameSide &&
    absFunding >=
      V4_FLOW_CFG.fundingCrowded
  ) {
    adjustment -= 0.40;
    crowded = true;
  }

  if (
    sameSide &&
    absFunding >=
      V4_FLOW_CFG.fundingExtreme
  ) {
    adjustment -= 0.60;
    extreme = true;
  }

  // Opposite funding may fuel a squeeze
  // if price is moving against crowded traders.
  if (
    oppositeSide &&
    absFunding >=
      V4_FLOW_CFG.fundingCrowded
  ) {
    adjustment += 0.35;
  }

  return {
    adjustment,
    crowded,
    extreme,
    oppositeFunding:
      oppositeSide,
  };
}

function openInterestState(
  oi15,
  oi60,
  price15,
  price60,
  direction
) {
  const priceAligned15 =
    directionalSign(
      price15,
      direction
    );

  const priceAligned60 =
    directionalSign(
      price60,
      direction
    );

  let adjustment = 0;

  let supportive = false;
  let strongExpansion = false;
  let squeezeOnly = false;
  let absorptionRisk = false;

  if (
    priceAligned15 === true &&
    oi15 !== null &&
    oi15 >=
      V4_FLOW_CFG.oi15SupportPct
  ) {
    adjustment += 0.35;
    supportive = true;
  }

  if (
    priceAligned60 === true &&
    oi60 !== null &&
    oi60 >=
      V4_FLOW_CFG.oi60SupportPct
  ) {
    adjustment += 0.45;
    supportive = true;
  }

  if (
    priceAligned60 === true &&
    oi60 !== null &&
    oi60 >=
      V4_FLOW_CFG.oi60StrongPct
  ) {
    adjustment += 0.25;
    strongExpansion = true;
  }

  // Price moves in our direction while OI drops:
  // likely short/long covering rather than fresh positioning.
  if (
    priceAligned60 === true &&
    oi60 !== null &&
    oi60 <= -0.50
  ) {
    adjustment += 0.15;
    squeezeOnly = true;
  }

  // OI expands aggressively while price fails
  // to move in the expected direction:
  // possible absorption / trapped leverage.
  if (
    priceAligned60 === false &&
    oi60 !== null &&
    oi60 >=
      V4_FLOW_CFG.oi60StrongPct
  ) {
    adjustment -= 0.90;
    absorptionRisk = true;
  }

  return {
    adjustment,
    supportive,
    strongExpansion,
    squeezeOnly,
    absorptionRisk,
  };
}

export function analyzeV4Flow(
  input = {}
) {
  const symbol = String(
    input?.symbol || ""
  ).toUpperCase();

  const direction = String(
    input?.direction ??
    input?.htfDirection ??
    input?.radarDirection ??
    "NEUTRAL"
  ).toUpperCase();

  const prices =
    normalizePriceSeries(
      input?.prices ??
      input?.priceSnapshots
    );

  const spotCvd =
    normalizeScalarSeries(
      input?.spotCvd
    );

  const futuresCvd =
    normalizeScalarSeries(
      input?.futuresCvd
    );

  const openInterest =
    normalizeScalarSeries(
      input?.openInterest
    );

  const liquidations =
    normalizeLiquidations(
      input?.liquidations
    );

  const latestTs =
    Math.max(
      prices.at(-1)?.ts ?? 0,
      spotCvd.at(-1)?.ts ?? 0,
      futuresCvd.at(-1)?.ts ?? 0,
      openInterest.at(-1)?.ts ?? 0,
      liquidations.at(-1)?.ts ?? 0
    );

  const nowTs =
    Number(input?.nowTs) ||
    latestTs ||
    Date.now();

  const fundingRate =
    normalizeFundingRate(
      input?.fundingRate ??
      input?.funding
    );

  if (
    direction !== "LONG" &&
    direction !== "SHORT"
  ) {
    return {
      version: V4_FLOW_VERSION,
      symbol,
      direction: "NEUTRAL",
      score: 5,
      status: "NO_DIRECTION",
      coverage: 0,
      severeRisk: false,
      liquidityRisk: false,
      tradePermission: false,
    };
  }

  const price15 =
    priceReturn(
      prices,
      nowTs,
      15
    );

  const price60 =
    priceReturn(
      prices,
      nowTs,
      60
    );

  const spot15 =
    seriesDelta(
      spotCvd,
      nowTs,
      15
    );

  const spot60 =
    seriesDelta(
      spotCvd,
      nowTs,
      60
    );

  const futures15 =
    seriesDelta(
      futuresCvd,
      nowTs,
      15
    );

  const futures60 =
    seriesDelta(
      futuresCvd,
      nowTs,
      60
    );

  const oi15 =
    seriesPctChange(
      openInterest,
      nowTs,
      15
    );

  const oi60 =
    seriesPctChange(
      openInterest,
      nowTs,
      60
    );

  const spot =
    cvdState(
      spot15,
      spot60,
      direction
    );

  const futures =
    cvdState(
      futures15,
      futures60,
      direction
    );

  const oi =
    openInterestState(
      oi15,
      oi60,
      price15,
      price60,
      direction
    );

  const funding =
    fundingState(
      fundingRate,
      direction
    );

  const liquidation =
    liquidationWindow(
      liquidations,
      nowTs,
      60
    );
  // -----------------------------
  // FLOW_2 — DEMAND / SUPPLY
  // -----------------------------

  const pressure =
    buildDemandSupplyPressure({
      spot15,
      spot60,
      futures15,
      futures60,
      oi15,
      oi60,
      price15,
      price60,
      liquidation,
    });

  const directionalPressure =
    direction === "LONG"
      ? pressure.demand
      : pressure.supply;
  let score =
    V4_FLOW_CFG.neutralScore;

  const reasons = [];
  const warnings = [];

  // -----------------------------
  // SPOT CVD
  // -----------------------------

  if (spot.score === 1) {
    score += 1.20;
    reasons.push(
      "spot CVD aligned"
    );
  } else if (spot.score === 0.5) {
    score += 0.60;
    reasons.push(
      "spot CVD partly aligned"
    );
  } else if (spot.score === -1) {
    score -= 1.20;
    warnings.push(
      "spot CVD against move"
    );
  } else if (spot.score === -0.5) {
    score -= 0.60;
  }

  // -----------------------------
  // FUTURES CVD
  // -----------------------------

  if (futures.score === 1) {
    score += 0.70;
    reasons.push(
      "futures CVD aligned"
    );
  } else if (futures.score === 0.5) {
    score += 0.35;
  } else if (futures.score === -1) {
    score -= 0.70;
    warnings.push(
      "futures CVD against move"
    );
  } else if (futures.score === -0.5) {
    score -= 0.35;
  }

  // -----------------------------
  // OPEN INTEREST
  // -----------------------------

  score += oi.adjustment;

  if (oi.supportive) {
    reasons.push(
      "OI supports price"
    );
  }

  if (oi.strongExpansion) {
    reasons.push(
      "strong OI expansion"
    );
  }

  if (oi.squeezeOnly) {
    warnings.push(
      "move partly squeeze-driven"
    );
  }

  if (oi.absorptionRisk) {
    warnings.push(
      "OI expansion without price progress"
    );
  }

  // -----------------------------
  // FUNDING
  // -----------------------------

  score += funding.adjustment;

  if (funding.crowded) {
    warnings.push(
      "crowded funding"
    );
  }

  if (funding.extreme) {
    warnings.push(
      "extreme funding"
    );
  }

  if (
    funding.oppositeFunding &&
    Math.abs(fundingRate ?? 0) >=
      V4_FLOW_CFG.fundingCrowded
  ) {
    reasons.push(
      "opposite funding squeeze fuel"
    );
  }

  // -----------------------------
  // LIQUIDATIONS
  // -----------------------------

  let liquidationRatio = null;

  if (
    direction === "LONG" &&
    liquidation.shortUsd > 0
  ) {
    liquidationRatio =
      liquidation.shortUsd /
      Math.max(
        liquidation.longUsd,
        1
      );

    if (
      liquidationRatio >=
      V4_FLOW_CFG.liquidationRatio
    ) {
      score += 0.35;

      reasons.push(
        "short liquidation support"
      );
    }
  }

  if (
    direction === "SHORT" &&
    liquidation.longUsd > 0
  ) {
    liquidationRatio =
      liquidation.longUsd /
      Math.max(
        liquidation.shortUsd,
        1
      );

    if (
      liquidationRatio >=
      V4_FLOW_CFG.liquidationRatio
    ) {
      score += 0.35;

      reasons.push(
        "long liquidation support"
      );
    }
  }

  // -----------------------------
  // SPOT / FUTURES DIVERGENCE
  // -----------------------------

  const spotAligned =
    spot.score > 0;

  const futuresAligned =
    futures.score > 0;

  let leverageDriven = false;

  if (
    futuresAligned &&
    !spotAligned
  ) {
    score -= 1.00;
    leverageDriven = true;

    warnings.push(
      "futures-led / weak spot participation"
    );
  }

  if (
    spotAligned &&
    !futuresAligned
  ) {
    score += 0.20;

    reasons.push(
      "spot-led move"
    );
  }

  // -----------------------------
  // DATA COVERAGE
  // -----------------------------

  let available = 0;

  if (
    spot15 !== null ||
    spot60 !== null
  ) {
    available++;
  }

  if (
    futures15 !== null ||
    futures60 !== null
  ) {
    available++;
  }

  if (
    oi15 !== null ||
    oi60 !== null
  ) {
    available++;
  }

  if (fundingRate !== null) {
    available++;
  }

  if (
    liquidation.longUsd > 0 ||
    liquidation.shortUsd > 0
  ) {
    available++;
  }

  const coverage =
    available / 5;

  // Missing flow data does NOT become a bearish signal.
  // Pull score gently toward neutral instead.
  if (
    coverage <
    V4_FLOW_CFG.minUsefulCoverage
  ) {
    score =
      score * coverage +
      V4_FLOW_CFG.neutralScore *
        (1 - coverage);
  }

  score = round2(
    clamp(score, 0, 10)
  );

  // -----------------------------
  // SEVERE RISK
  // -----------------------------

  const severeRisk =
    (
      funding.extreme &&
      leverageDriven
    ) ||
    (
      oi.absorptionRisk &&
      funding.crowded
    );

  const liquidityRisk =
    severeRisk;

  let status = "MIXED_FLOW";

  if (
    coverage <
    V4_FLOW_CFG.minUsefulCoverage
  ) {
    status = "PARTIAL_FLOW_DATA";
  } else if (severeRisk) {
    status = "HIGH_FLOW_RISK";
  } else if (
    score >=
    V4_FLOW_CFG.strongScore
  ) {
    status = "STRONG_FLOW";
  } else if (
    score >=
    V4_FLOW_CFG.supportiveScore
  ) {
    status = "SUPPORTIVE_FLOW";
  } else if (
    score <
    V4_FLOW_CFG.againstScore
  ) {
    status = "FLOW_AGAINST";
  }

  return {
    version:
      V4_FLOW_VERSION,

    symbol,
    direction,

    score,
    status,
    // FLOW_2 — two-sided pressure
    demandScore:
      pressure.demandScore,

    supplyScore:
      pressure.supplyScore,

    netPressure:
      pressure.netPressure,

    dominantSide:
      pressure.dominantSide,

    pressureStrength:
      pressure.pressureStrength,

    directionalPressureScore:
      directionalPressure.score,

    directionalPressure,
    coverage:
      round2(coverage),

    price: {
      return15mPct:
        round2(price15),

      return60mPct:
        round2(price60),
    },

    spotCvd: {
      delta15m:
        round2(spot15),

      delta60m:
        round2(spot60),

      aligned15:
        spot.aligned15,

      aligned60:
        spot.aligned60,
    },

    futuresCvd: {
      delta15m:
        round2(futures15),

      delta60m:
        round2(futures60),

      aligned15:
        futures.aligned15,

      aligned60:
        futures.aligned60,
    },

    openInterest: {
      change15mPct:
        round2(oi15),

      change60mPct:
        round2(oi60),

      supportive:
        oi.supportive,

      strongExpansion:
        oi.strongExpansion,

      squeezeOnly:
        oi.squeezeOnly,

      absorptionRisk:
        oi.absorptionRisk,
    },

    funding: {
      rate:
        fundingRate,

      crowded:
        funding.crowded,

      extreme:
        funding.extreme,

      oppositeFunding:
        funding.oppositeFunding,
    },

    liquidations: {
      longUsd:
        Math.round(
          liquidation.longUsd
        ),

      shortUsd:
        Math.round(
          liquidation.shortUsd
        ),

      directionalRatio:
        round2(
          liquidationRatio
        ),
    },

    leverageDriven,

    severeRisk,

    // Final Clean Core may use this
    // as the LIQUIDITY_RISK hard veto.
    liquidityRisk,

    reasons:
      [...new Set(reasons)],

    warnings:
      [...new Set(warnings)],

    // FLOW never opens a trade.
    tradePermission: false,
  };
}
