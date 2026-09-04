// BingX V4 Clean Core — STRUCTURE
// Role owner: AKSEL / MARKET STRUCTURE
// Pure scoring module: same logic for LIVE SCAN + REPLAY.
// TEST / PAPER ONLY.
//
// Purpose:
// boundary + repeated tests + compression + breakout/retest
// + classical continuation structure.
//
// IMPORTANT:
// Missing a textbook pattern is NOT a veto.
// Structure contributes SCORE.
// Extended/late entry is flagged for the EXECUTION engine.

export const V4_STRUCTURE_VERSION = "V4_STRUCTURE_1";

export const V4_STRUCTURE_CFG = {
  minCandles15m: 45,
  minCandles1h: 45,
  minCandles4h: 35,

  usableScore: 5.5,
  strongScore: 7.0,
  eliteScore: 8.25,

  boundaryLookback: 60,
  boundaryToleranceATR: 0.30,

  nearBoundaryATR: 0.80,
  veryNearBoundaryATR: 0.40,

  breakoutMaxATR: 1.25,
  extendedATR: 1.75,

  retestMaxBars: 6,
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
      volume: Number(x?.volume ?? 0),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.time) &&
        x.time > 0 &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close) &&
        x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function trueRange(rows, index) {
  const row = rows[index];

  if (index === 0) {
    return row.high - row.low;
  }

  const prevClose = rows[index - 1].close;

  return Math.max(
    row.high - row.low,
    Math.abs(row.high - prevClose),
    Math.abs(row.low - prevClose)
  );
}

function atr(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) {
    return null;
  }

  const start = Math.max(
    1,
    rows.length - period
  );

  const values = [];

  for (let i = start; i < rows.length; i++) {
    values.push(trueRange(rows, i));
  }

  if (!values.length) return null;

  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  );
}

function sma(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const part = values.slice(-period);

  return (
    part.reduce((a, b) => a + b, 0) /
    part.length
  );
}

function swingPoints(
  rows,
  kind,
  wing = 2
) {
  const out = [];

  for (
    let i = wing;
    i < rows.length - wing;
    i++
  ) {
    const value =
      kind === "HIGH"
        ? rows[i].high
        : rows[i].low;

    let valid = true;

    for (
      let j = i - wing;
      j <= i + wing;
      j++
    ) {
      if (j === i) continue;

      const other =
        kind === "HIGH"
          ? rows[j].high
          : rows[j].low;

      if (
        kind === "HIGH"
          ? other > value
          : other < value
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      out.push({
        index: i,
        time: rows[i].time,
        price: value,
      });
    }
  }

  return out;
}

function detectBoundary(
  rows,
  direction
) {
  const sample = rows.slice(
    -V4_STRUCTURE_CFG.boundaryLookback
  );

  const swings =
    direction === "LONG"
      ? swingPoints(sample, "HIGH", 2)
      : swingPoints(sample, "LOW", 2);

  if (!swings.length) {
    return {
      level: null,
      tests: 0,
      swings: [],
    };
  }

  // Latest confirmed swing is the active boundary.
  const active = swings.at(-1);
  const level = active.price;

  const a = atr(sample, 14);

  if (!(a > 0)) {
    return {
      level,
      tests: 1,
      swings,
    };
  }

  const tolerance =
    a *
    V4_STRUCTURE_CFG.boundaryToleranceATR;

  const tests = swings.filter(
    (x) =>
      Math.abs(x.price - level) <=
      tolerance
  ).length;

  return {
    level,
    tests,
    swings,
  };
}

function compressionState(rows) {
  const sample = rows.slice(-25);

  if (sample.length < 20) {
    return {
      ratio: null,
      score: 0,
      compressed: false,
    };
  }

  const recent = sample.slice(-6);
  const prior = sample.slice(-20, -6);

  const recentRange =
    Math.max(...recent.map((x) => x.high)) -
    Math.min(...recent.map((x) => x.low));

  const priorRange =
    Math.max(...prior.map((x) => x.high)) -
    Math.min(...prior.map((x) => x.low));

  if (!(priorRange > 0)) {
    return {
      ratio: null,
      score: 0,
      compressed: false,
    };
  }

  const ratio = recentRange / priorRange;

  let score = 0;

  if (ratio <= 0.75) score += 0.75;
  if (ratio <= 0.55) score += 0.50;
  if (ratio <= 0.40) score += 0.25;

  return {
    ratio: round2(ratio),
    score: clamp(score, 0, 1.5),
    compressed: ratio <= 0.75,
  };
}

function boundaryTestScore(tests) {
  if (tests >= 4) return 1.50;
  if (tests === 3) return 1.25;
  if (tests === 2) return 0.75;
  if (tests === 1) return 0.25;
  return 0;
}

function distanceState(
  rows,
  direction,
  boundary
) {
  const latest = rows.at(-1);

  if (
    !latest ||
    !(boundary > 0)
  ) {
    return {
      distanceATR: null,
      signedDistanceATR: null,
      near: false,
      veryNear: false,
      extended: false,
    };
  }

  const a = atr(rows, 14);

  if (!(a > 0)) {
    return {
      distanceATR: null,
      signedDistanceATR: null,
      near: false,
      veryNear: false,
      extended: false,
    };
  }

  const signed =
    direction === "LONG"
      ? (latest.close - boundary) / a
      : (boundary - latest.close) / a;

  const absolute = Math.abs(signed);

  return {
    distanceATR: round2(absolute),
    signedDistanceATR: round2(signed),

    near:
      absolute <=
      V4_STRUCTURE_CFG.nearBoundaryATR,

    veryNear:
      absolute <=
      V4_STRUCTURE_CFG.veryNearBoundaryATR,

    extended:
      signed >
      V4_STRUCTURE_CFG.extendedATR,
  };
}

function breakoutState(
  rows,
  direction,
  boundary
) {
  if (
    rows.length < 3 ||
    !(boundary > 0)
  ) {
    return {
      breakout: false,
      barsSinceBreakout: null,
      accepted: false,
    };
  }

  let breakIndex = null;

  for (
    let i = Math.max(1, rows.length - 8);
    i < rows.length;
    i++
  ) {
    const prev = rows[i - 1];
    const row = rows[i];

    const crossed =
      direction === "LONG"
        ? prev.close <= boundary &&
          row.close > boundary
        : prev.close >= boundary &&
          row.close < boundary;

    if (crossed) {
      breakIndex = i;
    }
  }

  if (breakIndex === null) {
    return {
      breakout: false,
      barsSinceBreakout: null,
      accepted: false,
    };
  }

  const latest = rows.at(-1);

  const accepted =
    direction === "LONG"
      ? latest.close > boundary
      : latest.close < boundary;

  return {
    breakout: true,
    barsSinceBreakout:
      rows.length - 1 - breakIndex,
    accepted,
  };
}

function retestState(
  rows,
  direction,
  boundary,
  breakout
) {
  if (
    !breakout?.breakout ||
    !breakout?.accepted ||
    breakout.barsSinceBreakout === null ||
    breakout.barsSinceBreakout >
      V4_STRUCTURE_CFG.retestMaxBars
  ) {
    return {
      retest: false,
      quality: 0,
    };
  }

  const latest = rows.at(-1);
  const a = atr(rows, 14);

  if (
    !latest ||
    !(a > 0)
  ) {
    return {
      retest: false,
      quality: 0,
    };
  }

  const dist =
    direction === "LONG"
      ? (latest.close - boundary) / a
      : (boundary - latest.close) / a;

  const wickTouched =
    direction === "LONG"
      ? latest.low <= boundary + 0.25 * a
      : latest.high >= boundary - 0.25 * a;

  const stillAccepted =
    direction === "LONG"
      ? latest.close >= boundary
      : latest.close <= boundary;

  const retest =
    wickTouched &&
    stillAccepted &&
    dist >= 0 &&
    dist <= 0.60;

  return {
    retest,
    quality: retest ? 1.5 : 0,
  };
}

function staircaseState(
  rows,
  direction
) {
  const sample = rows.slice(-12);

  if (sample.length < 10) {
    return {
      score: 0,
      valid: false,
    };
  }

  const first = sample.slice(0, 6);
  const second = sample.slice(-6);

  const firstHigh =
    Math.max(...first.map((x) => x.high));

  const firstLow =
    Math.min(...first.map((x) => x.low));

  const secondHigh =
    Math.max(...second.map((x) => x.high));

  const secondLow =
    Math.min(...second.map((x) => x.low));

  const valid =
    direction === "LONG"
      ? secondLow > firstLow &&
        secondHigh >= firstHigh
      : secondHigh < firstHigh &&
        secondLow <= firstLow;

  return {
    score: valid ? 0.75 : 0,
    valid,
  };
}

function trendSupportScore(
  rows,
  direction
) {
  const closes = rows.map((x) => x.close);
  const latest = closes.at(-1);

  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);

  let score = 0;

  if (
    direction === "LONG"
  ) {
    if (
      s20 !== null &&
      latest > s20
    ) {
      score += 0.4;
    }

    if (
      s20 !== null &&
      s50 !== null &&
      s20 > s50
    ) {
      score += 0.35;
    }
  }

  if (
    direction === "SHORT"
  ) {
    if (
      s20 !== null &&
      latest < s20
    ) {
      score += 0.4;
    }

    if (
      s20 !== null &&
      s50 !== null &&
      s20 < s50
    ) {
      score += 0.35;
    }
  }

  return clamp(score, 0, 0.75);
}

function analyzeOneDirection(
  rows15,
  rows1h,
  rows4h,
  direction
) {
  const boundaryInfo =
    detectBoundary(
      rows1h,
      direction
    );

  const boundary =
    boundaryInfo.level;

  if (!(boundary > 0)) {
    return {
      direction,
      score: 0,
      boundary: null,
      tests: 0,
      status: "NO_BOUNDARY",
      extended: false,
      breakout: false,
      retest: false,
      reasons: [],
    };
  }

  const compression =
    compressionState(rows1h);

  const distance =
    distanceState(
      rows15,
      direction,
      boundary
    );

  const breakout =
    breakoutState(
      rows15,
      direction,
      boundary
    );

  const retest =
    retestState(
      rows15,
      direction,
      boundary,
      breakout
    );

  const staircase =
    staircaseState(
      rows1h,
      direction
    );

  const trend1h =
    trendSupportScore(
      rows1h,
      direction
    );

  const trend4h =
    trendSupportScore(
      rows4h,
      direction
    );

  let score = 0;
  const reasons = [];

  const testScore =
    boundaryTestScore(
      boundaryInfo.tests
    );

  score += testScore;

  if (testScore > 0) {
    reasons.push(
      `${boundaryInfo.tests} boundary tests`
    );
  }

  score += compression.score;

  if (compression.compressed) {
    reasons.push("compression");
  }

  if (distance.near) {
    score += 0.75;
    reasons.push("near boundary");
  }

  if (distance.veryNear) {
    score += 0.50;
    reasons.push("very near boundary");
  }

  if (
    breakout.breakout &&
    breakout.accepted
  ) {
    score += 1.50;
    reasons.push("accepted breakout");
  }

  if (retest.retest) {
    score += retest.quality;
    reasons.push("successful retest");
  }

  score += staircase.score;

  if (staircase.valid) {
    reasons.push("staircase structure");
  }

  score += trend1h;
  score += trend4h;

  if (
    trend1h + trend4h >= 1
  ) {
    reasons.push("trend support");
  }

  // A breakout that already traveled too far
  // should not receive full fresh-entry quality.
  if (distance.extended) {
    score -= 2.0;
    reasons.push("extended from boundary");
  }

  score = round2(
    clamp(score, 0, 10)
  );

  let status = "DEVELOPING";

  if (distance.extended) {
    status = "EXTENDED";
  } else if (retest.retest) {
    status = "RETEST";
  } else if (
    breakout.breakout &&
    breakout.accepted
  ) {
    status = "BREAKOUT";
  } else if (
    distance.veryNear &&
    compression.compressed
  ) {
    status = "ARMED";
  } else if (distance.near) {
    status = "PREPARING";
  }

  return {
    direction,
    score,
    status,

    boundary: round2(boundary),
    boundaryTests:
      boundaryInfo.tests,

    compressionRatio:
      compression.ratio,

    distanceATR:
      distance.distanceATR,

    signedDistanceATR:
      distance.signedDistanceATR,

    nearBoundary:
      distance.near,

    veryNearBoundary:
      distance.veryNear,

    breakout:
      breakout.breakout,

    breakoutAccepted:
      breakout.accepted,

    barsSinceBreakout:
      breakout.barsSinceBreakout,

    retest:
      retest.retest,

    staircase:
      staircase.valid,

    extended:
      distance.extended,

    reasons,
  };
}

export function analyzeV4Structure(
  input = {}
) {
  const symbol = String(
    input?.symbol || ""
  ).toUpperCase();

  const rows15 =
    normalizeCandles(
      input?.candles15m
    );

  const rows1h =
    normalizeCandles(
      input?.candles1h
    );

  const rows4h =
    normalizeCandles(
      input?.candles4h
    );

  const requestedDirection =
    String(
      input?.direction ??
      input?.htfDirection ??
      input?.radarDirection ??
      "NEUTRAL"
    ).toUpperCase();

  const enoughData =
    rows15.length >=
      V4_STRUCTURE_CFG.minCandles15m &&
    rows1h.length >=
      V4_STRUCTURE_CFG.minCandles1h &&
    rows4h.length >=
      V4_STRUCTURE_CFG.minCandles4h;

  if (!enoughData) {
    return {
      version:
        V4_STRUCTURE_VERSION,

      symbol,

      status:
        "INSUFFICIENT_DATA",

      direction:
        requestedDirection,

      score: 0,

      extended: false,

      tradePermission: false,
    };
  }

  const longResult =
    analyzeOneDirection(
      rows15,
      rows1h,
      rows4h,
      "LONG"
    );

  const shortResult =
    analyzeOneDirection(
      rows15,
      rows1h,
      rows4h,
      "SHORT"
    );

  let selected;

  if (
    requestedDirection === "LONG"
  ) {
    selected = longResult;
  } else if (
    requestedDirection === "SHORT"
  ) {
    selected = shortResult;
  } else {
    selected =
      longResult.score >=
      shortResult.score
        ? longResult
        : shortResult;
  }

  let quality = "WEAK";

  if (
    selected.score >=
    V4_STRUCTURE_CFG.eliteScore
  ) {
    quality = "ELITE";
  } else if (
    selected.score >=
    V4_STRUCTURE_CFG.strongScore
  ) {
    quality = "STRONG";
  } else if (
    selected.score >=
    V4_STRUCTURE_CFG.usableScore
  ) {
    quality = "USABLE";
  }

  return {
    version:
      V4_STRUCTURE_VERSION,

    symbol,

    direction:
      selected.direction,

    requestedDirection,

    score:
      selected.score,

    quality,

    status:
      selected.status,

    boundary:
      selected.boundary,

    boundaryTests:
      selected.boundaryTests,

    compressionRatio:
      selected.compressionRatio,

    distanceATR:
      selected.distanceATR,

    signedDistanceATR:
      selected.signedDistanceATR,

    nearBoundary:
      selected.nearBoundary,

    veryNearBoundary:
      selected.veryNearBoundary,

    breakout:
      selected.breakout,

    breakoutAccepted:
      selected.breakoutAccepted,

    barsSinceBreakout:
      selected.barsSinceBreakout,

    retest:
      selected.retest,

    staircase:
      selected.staircase,

    // This is a warning for EXECUTION.
    // STRUCTURE does not itself authorize or kill a trade.
    extendedEntry:
      selected.extended,

    reasons:
      selected.reasons,

    alternatives: {
      longScore:
        longResult.score,

      shortScore:
        shortResult.score,
    },

    tradePermission: false,
  };
}
