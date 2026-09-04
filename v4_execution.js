// BingX V4 Clean Core — EXECUTION
// Role owner: MR. TRADER / EXECUTION & RISK
// Final decision layer for V4 Clean Core.
// TEST / PAPER ONLY — REAL ORDERS DISABLED.
//
// Inputs:
// RADAR + DIRECTION + STRUCTURE + FLOW
//
// Outputs:
// PASS / WATCH / STARTER / CONFIRMED
//
// Philosophy:
// Most disagreement = SCORE / POSITION SIZE.
// Only genuine risk = HARD VETO.

export const V4_EXECUTION_VERSION = "V4_EXECUTION_1";

export const V4_EXECUTION_CFG = {
  // Bootstrap thresholds.
  // Replay Lab must validate/calibrate these.
  minHardRR: 1.50,
  minStarterRR: 1.80,
  minConfirmedRR: 2.00,

  starterScore: 6.70,
  confirmedScore: 7.75,
  eliteScore: 8.60,

  // Entry distance from structure boundary.
  preferredEntryATR: 0.80,
  cautionEntryATR: 1.50,
  hardExtendedATR: 2.00,

  // Default stop placement outside structure.
  stopBufferATR: 0.35,

  // PAPER risk units.
  starterRiskR: 0.25,
  strongStarterRiskR: 0.40,
  confirmedRiskR: 0.50,

  // Default R-based targets when no explicit target exists.
  defaultTP1R: 1.80,
  defaultTP2R: 2.80,
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

function validDirection(direction) {
  return direction === "LONG" || direction === "SHORT";
}

function validStopGeometry(
  direction,
  entry,
  stop
) {
  if (
    !validDirection(direction) ||
    !(entry > 0) ||
    !(stop > 0)
  ) {
    return false;
  }

  if (direction === "LONG") {
    return stop < entry;
  }

  return stop > entry;
}

function validTargetGeometry(
  direction,
  entry,
  target
) {
  if (
    !validDirection(direction) ||
    !(entry > 0) ||
    !(target > 0)
  ) {
    return false;
  }

  if (direction === "LONG") {
    return target > entry;
  }

  return target < entry;
}

function riskDistance(
  direction,
  entry,
  stop
) {
  if (!validStopGeometry(direction, entry, stop)) {
    return null;
  }

  return Math.abs(entry - stop);
}

function rewardDistance(
  direction,
  entry,
  target
) {
  if (!validTargetGeometry(direction, entry, target)) {
    return null;
  }

  return Math.abs(target - entry);
}

function riskReward(
  direction,
  entry,
  stop,
  target
) {
  const risk =
    riskDistance(
      direction,
      entry,
      stop
    );

  const reward =
    rewardDistance(
      direction,
      entry,
      target
    );

  if (
    !(risk > 0) ||
    !(reward > 0)
  ) {
    return null;
  }

  return reward / risk;
}

function resolveEntry(input) {
  return (
    num(input?.entry) ??
    num(input?.currentPrice) ??
    num(input?.price) ??
    null
  );
}

function resolveATR(input) {
  return (
    num(input?.atr15m) ??
    num(input?.atr1h) ??
    num(input?.atr) ??
    null
  );
}

function resolveBoundary(input) {
  return (
    num(input?.structure?.boundary) ??
    num(input?.boundary) ??
    null
  );
}

function resolveStop(
  input,
  direction,
  entry
) {
  const explicitStop =
    num(input?.stop) ??
    num(input?.invalidation);

  if (
    explicitStop !== null &&
    validStopGeometry(
      direction,
      entry,
      explicitStop
    )
  ) {
    return {
      stop: explicitStop,
      source: "EXPLICIT",
    };
  }

  const boundary =
    resolveBoundary(input);

  const atr =
    resolveATR(input);

  if (
    !(boundary > 0) ||
    !(atr > 0)
  ) {
    return {
      stop: null,
      source: "UNAVAILABLE",
    };
  }

  const buffer =
    atr *
    V4_EXECUTION_CFG.stopBufferATR;

  const stop =
    direction === "LONG"
      ? boundary - buffer
      : boundary + buffer;

  if (
    !validStopGeometry(
      direction,
      entry,
      stop
    )
  ) {
    return {
      stop: null,
      source: "INVALID_STRUCTURE_STOP",
    };
  }

  return {
    stop,
    source: "STRUCTURE_ATR",
  };
}

function resolveTargets(
  input,
  direction,
  entry,
  stop
) {
  const explicitTP1 =
    num(input?.tp1) ??
    num(input?.target1);

  const explicitTP2 =
    num(input?.tp2) ??
    num(input?.target2);

  const risk =
    riskDistance(
      direction,
      entry,
      stop
    );

  if (!(risk > 0)) {
    return {
      tp1: null,
      tp2: null,
      source: "UNAVAILABLE",
    };
  }

  const defaultTP1 =
    direction === "LONG"
      ? entry +
        risk *
          V4_EXECUTION_CFG.defaultTP1R
      : entry -
        risk *
          V4_EXECUTION_CFG.defaultTP1R;

  const defaultTP2 =
    direction === "LONG"
      ? entry +
        risk *
          V4_EXECUTION_CFG.defaultTP2R
      : entry -
        risk *
          V4_EXECUTION_CFG.defaultTP2R;

  const tp1 =
    explicitTP1 !== null &&
    validTargetGeometry(
      direction,
      entry,
      explicitTP1
    )
      ? explicitTP1
      : defaultTP1;

  const tp2 =
    explicitTP2 !== null &&
    validTargetGeometry(
      direction,
      entry,
      explicitTP2
    )
      ? explicitTP2
      : defaultTP2;

  return {
    tp1,
    tp2,
    source:
      explicitTP1 !== null ||
      explicitTP2 !== null
        ? "MIXED_EXPLICIT"
        : "R_BASED",
  };
}

function structureExecutionQuality(
  structure = {}
) {
  let score = 5;
  const reasons = [];
  const warnings = [];

  const status =
    String(
      structure?.status || ""
    ).toUpperCase();

  if (status === "RETEST") {
    score += 1.60;
    reasons.push("successful retest");
  }

  if (status === "BREAKOUT") {
    score += 1.00;
    reasons.push("accepted breakout");
  }

  if (status === "ARMED") {
    score += 1.20;
    reasons.push("armed near boundary");
  }

  if (status === "PREPARING") {
    score += 0.70;
    reasons.push("preparing near boundary");
  }

  if (
    structure?.veryNearBoundary === true
  ) {
    score += 0.50;
    reasons.push("very near boundary");
  }

  if (
    structure?.nearBoundary === true
  ) {
    score += 0.25;
  }

  if (
    Number(structure?.boundaryTests) >= 3
  ) {
    score += 0.35;
    reasons.push("repeated boundary tests");
  }

  if (
    structure?.compressionRatio !== null &&
    num(structure?.compressionRatio) !== null &&
    Number(structure.compressionRatio) <= 0.75
  ) {
    score += 0.35;
    reasons.push("compression");
  }

  const distanceATR =
    num(structure?.distanceATR);

  if (
    distanceATR !== null &&
    distanceATR <=
      V4_EXECUTION_CFG.preferredEntryATR
  ) {
    score += 0.50;
    reasons.push("efficient entry distance");
  }

  if (
    distanceATR !== null &&
    distanceATR >
      V4_EXECUTION_CFG.cautionEntryATR
  ) {
    score -= 0.80;
    warnings.push("late entry risk");
  }

  if (
    structure?.extendedEntry === true
  ) {
    score -= 1.00;
    warnings.push("extended structure");
  }

  return {
    score: clamp(score, 0, 10),
    reasons,
    warnings,
  };
}

function scoreAgreement(
  direction,
  radar,
  htf,
  structure
) {
  let adjustment = 0;
  const reasons = [];
  const warnings = [];

  const radarDirection =
    String(
      radar?.direction || "NEUTRAL"
    ).toUpperCase();

  const htfDirection =
    String(
      htf?.direction || "NEUTRAL"
    ).toUpperCase();

  const structureDirection =
    String(
      structure?.direction || "NEUTRAL"
    ).toUpperCase();

  if (
    radarDirection === direction
  ) {
    adjustment += 0.20;
  }

  if (
    htfDirection === direction
  ) {
    adjustment += 0.30;
    reasons.push("HTF aligned");
  }

  if (
    structureDirection === direction
  ) {
    adjustment += 0.25;
    reasons.push("structure aligned");
  }

  if (
    htfDirection !== "NEUTRAL" &&
    htfDirection !== direction
  ) {
    adjustment -= 0.70;
    warnings.push("HTF disagreement");
  }

  if (
    structureDirection !== "NEUTRAL" &&
    structureDirection !== direction
  ) {
    adjustment -= 0.50;
    warnings.push("structure disagreement");
  }

  return {
    adjustment,
    reasons,
    warnings,
  };
}

function weightedCoreScore(
  radarScore,
  directionScore,
  structureScore,
  flowScore,
  executionScore
) {
  const radar =
    clamp(
      num(radarScore) ?? 5,
      0,
      10
    );

  const direction =
    clamp(
      num(directionScore) ?? 5,
      0,
      10
    );

  const structure =
    clamp(
      num(structureScore) ?? 5,
      0,
      10
    );

  const flow =
    clamp(
      num(flowScore) ?? 5,
      0,
      10
    );

  const execution =
    clamp(
      num(executionScore) ?? 5,
      0,
      10
    );

  // Clean Core:
  // no single player dominates the team.
  return (
    radar * 0.20 +
    direction * 0.22 +
    structure * 0.23 +
    flow * 0.15 +
    execution * 0.20
  );
}

export function analyzeV4Execution(
  input = {}
) {
  const symbol = String(
    input?.symbol || ""
  ).toUpperCase();

  const radar =
    input?.radar || {};

  const htf =
    input?.directionEngine ??
    input?.directionResult ??
    {};

  const structure =
    input?.structure || {};

  const flow =
    input?.flow || {};

  const proposedDirection =
    String(
      input?.direction ??
      htf?.direction ??
      structure?.direction ??
      radar?.direction ??
      "NEUTRAL"
    ).toUpperCase();

  if (
    !validDirection(
      proposedDirection
    )
  ) {
    return {
      version:
        V4_EXECUTION_VERSION,

      symbol,

      decision: "PASS",

      reason:
        "NO_CLEAR_DIRECTION",

      finalScore: 0,

      hardVeto: true,

      hardVetoReasons: [
        "NO_CLEAR_DIRECTION",
      ],

      realOrderPermission: false,
    };
  }

  const entry =
    resolveEntry(input);

  if (!(entry > 0)) {
    return {
      version:
        V4_EXECUTION_VERSION,

      symbol,

      direction:
        proposedDirection,

      decision: "PASS",

      finalScore: 0,

      hardVeto: true,

      hardVetoReasons: [
        "NO_VALID_ENTRY_PRICE",
      ],

      realOrderPermission: false,
    };
  }

  const stopInfo =
    resolveStop(
      input,
      proposedDirection,
      entry
    );

  const stop =
    stopInfo.stop;

  const hardVetoReasons = [];
  const warnings = [];
  const reasons = [];

  if (
    htf?.hardVeto === true
  ) {
    hardVetoReasons.push(
      htf?.hardVetoReason ||
      "HTF_INVALIDATION"
    );
  }

  if (
    flow?.liquidityRisk === true ||
    flow?.severeRisk === true
  ) {
    hardVetoReasons.push(
      "LIQUIDITY_FLOW_RISK"
    );
  }

  if (
    !validStopGeometry(
      proposedDirection,
      entry,
      stop
    )
  ) {
    hardVetoReasons.push(
      "INVALID_STOP"
    );
  }

  const targets =
    resolveTargets(
      input,
      proposedDirection,
      entry,
      stop
    );

  const rr1 =
    riskReward(
      proposedDirection,
      entry,
      stop,
      targets.tp1
    );

  const rr2 =
    riskReward(
      proposedDirection,
      entry,
      stop,
      targets.tp2
    );

  if (
    rr1 !== null &&
    rr1 <
      V4_EXECUTION_CFG.minHardRR
  ) {
    hardVetoReasons.push(
      "BAD_RISK_REWARD"
    );
  }

  const distanceATR =
    num(
      structure?.distanceATR
    );

  if (
    structure?.extendedEntry === true &&
    distanceATR !== null &&
    distanceATR >=
      V4_EXECUTION_CFG.hardExtendedATR
  ) {
    hardVetoReasons.push(
      "TOO_LATE"
    );
  }

  const executionQuality =
    structureExecutionQuality(
      structure
    );

  reasons.push(
    ...executionQuality.reasons
  );

  warnings.push(
    ...executionQuality.warnings
  );

  const agreement =
    scoreAgreement(
      proposedDirection,
      radar,
      htf,
      structure
    );

  reasons.push(
    ...agreement.reasons
  );

  warnings.push(
    ...agreement.warnings
  );

  let finalScore =
    weightedCoreScore(
      radar?.score,
      htf?.score,
      structure?.score,
      flow?.score,
      executionQuality.score
    );

  finalScore +=
    agreement.adjustment;

  // RR improves execution quality,
  // but does not overpower bad structure.
  if (
    rr1 !== null &&
    rr1 >= 2.0
  ) {
    finalScore += 0.25;
    reasons.push(
      `RR ${round2(rr1)}`
    );
  }

  if (
    rr1 !== null &&
    rr1 >= 2.5
  ) {
    finalScore += 0.20;
  }

  if (
    rr1 !== null &&
    rr1 >= 3.0
  ) {
    finalScore += 0.15;
  }

  // Strong flow confirms;
  // weak flow reduces size/score rather than
  // automatically killing the trade.
  if (
    num(flow?.score) !== null &&
    Number(flow.score) >= 7
  ) {
    finalScore += 0.25;
    reasons.push(
      "strong flow confirmation"
    );
  }

  if (
    num(flow?.score) !== null &&
    Number(flow.score) < 4.25
  ) {
    finalScore -= 0.50;
    warnings.push(
      "flow against setup"
    );
  }

  finalScore =
    round2(
      clamp(
        finalScore,
        0,
        10
      )
    );

  const hardVeto =
    hardVetoReasons.length > 0;

  let decision = "WATCH";

  if (hardVeto) {
    decision = "PASS";
  } else {
    const structureStatus =
      String(
        structure?.status || ""
      ).toUpperCase();

    const starterStructure =
      [
        "PREPARING",
        "ARMED",
        "BREAKOUT",
        "RETEST",
      ].includes(
        structureStatus
      );

    const confirmedStructure =
      [
        "BREAKOUT",
        "RETEST",
      ].includes(
        structureStatus
      );

    if (
      finalScore >=
        V4_EXECUTION_CFG.confirmedScore &&
      rr1 !== null &&
      rr1 >=
        V4_EXECUTION_CFG.minConfirmedRR &&
      confirmedStructure
    ) {
      decision =
        "CONFIRMED";
    } else if (
      finalScore >=
        V4_EXECUTION_CFG.starterScore &&
      rr1 !== null &&
      rr1 >=
        V4_EXECUTION_CFG.minStarterRR &&
      starterStructure
    ) {
      decision =
        "STARTER";
    }
  }

  let riskR = 0;

  if (
    decision === "STARTER"
  ) {
    riskR =
      finalScore >= 7.5
        ? V4_EXECUTION_CFG
            .strongStarterRiskR
        : V4_EXECUTION_CFG
            .starterRiskR;
  }

  if (
    decision === "CONFIRMED"
  ) {
    riskR =
      V4_EXECUTION_CFG
        .confirmedRiskR;
  }

  let quality = "LOW";

  if (
    finalScore >=
    V4_EXECUTION_CFG.eliteScore
  ) {
    quality = "ELITE";
  } else if (
    finalScore >=
    V4_EXECUTION_CFG.confirmedScore
  ) {
    quality = "STRONG";
  } else if (
    finalScore >=
    V4_EXECUTION_CFG.starterScore
  ) {
    quality = "USABLE";
  }

  return {
    version:
      V4_EXECUTION_VERSION,

    symbol,

    direction:
      proposedDirection,

    decision,

    quality,

    finalScore,

    entry:
      round2(entry),

    stop:
      round2(stop),

    stopSource:
      stopInfo.source,

    tp1:
      round2(
        targets.tp1
      ),

    tp2:
      round2(
        targets.tp2
      ),

    targetSource:
      targets.source,

    rr: {
      tp1:
        round2(rr1),

      tp2:
        round2(rr2),
    },

    componentScores: {
      radar:
        round2(
          num(radar?.score)
        ),

      direction:
        round2(
          num(htf?.score)
        ),

      structure:
        round2(
          num(structure?.score)
        ),

      flow:
        round2(
          num(flow?.score)
        ),

      execution:
        round2(
          executionQuality.score
        ),
    },

    structure: {
      status:
        structure?.status ??
        null,

      boundary:
        round2(
          resolveBoundary(input)
        ),

      distanceATR:
        round2(
          distanceATR
        ),

      extended:
        structure?.extendedEntry === true,
    },

    risk: {
      paperRiskR:
        riskR,

      starter:
        decision === "STARTER",

      confirmed:
        decision === "CONFIRMED",

      scaleInAllowed:
        decision === "CONFIRMED",
    },

    hardVeto,

    hardVetoReasons:
      [...new Set(
        hardVetoReasons
      )],

    reasons:
      [...new Set(
        reasons
      )],

    warnings:
      [...new Set(
        warnings
      )],

    // Candidate for Replay/PAPER only.
    paperCandidate:
      decision === "STARTER" ||
      decision === "CONFIRMED",

    // Absolutely no real execution.
    realOrderPermission: false,
  };
}
