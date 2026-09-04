// BingX V4 Clean Core — CATALYST / NEWS CONTEXT
// Role owner: NEXUS / CATALYST CONTEXT
// Pure scoring module: same logic for live scan + replay.
// TEST / PAPER ONLY — REAL ORDERS DISABLED.
//
// Philosophy:
// - News/catalyst is context, not a standalone trade signal.
// - Missing news is NEUTRAL, never bearish by default.
// - Only events known at nowTs are eligible (future-leak guard).
// - Directional impact is explicit; this module does not guess sentiment from text.
// - Hard veto remains disabled until replay evidence supports it.

export const V4_CATALYST_VERSION = "V4_CATALYST_1";

export const V4_CATALYST_CFG = {
  neutralScore: 5.0,
  strongScore: 6.75,
  dominantScore: 8.0,

  maxAgeHours: 48,
  strongAgeHours: 8,
  maxNetImpact: 4.0,

  sourceQuality: {
    1: 1.00,
    2: 0.78,
    3: 0.58,
    4: 0.40,
  },

  categoryWeight: {
    HACK: 1.30,
    EXPLOIT: 1.30,
    REGULATORY: 1.20,
    ETF: 1.15,
    LISTING: 1.05,
    DELISTING: 1.20,
    TOKEN_UNLOCK: 1.00,
    UPGRADE: 0.95,
    PARTNERSHIP: 0.85,
    MACRO: 1.00,
    EXCHANGE: 0.95,
    LEGAL: 1.05,
    TREASURY: 0.95,
    ADOPTION: 0.90,
    OTHER: 0.80,
  },
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

function parseTs(v) {
  const direct = num(v);

  if (direct !== null) {
    return direct < 10_000_000_000
      ? direct * 1000
      : direct;
  }

  if (typeof v === "string" && v.trim()) {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeSentiment(v) {
  const numeric = num(v);

  if (numeric !== null) {
    return clamp(numeric, -1, 1);
  }

  const text = String(v ?? "")
    .trim()
    .toUpperCase();

  if (
    [
      "BULLISH",
      "POSITIVE",
      "BULL",
      "LONG",
      "UP",
    ].includes(text)
  ) {
    return 1;
  }

  if (
    [
      "BEARISH",
      "NEGATIVE",
      "BEAR",
      "SHORT",
      "DOWN",
    ].includes(text)
  ) {
    return -1;
  }

  return 0;
}

function normalizeSourceTier(v) {
  const numeric = num(v);

  if (numeric !== null) {
    return clamp(Math.round(numeric), 1, 4);
  }

  const text = String(v ?? "")
    .trim()
    .toUpperCase();

  if (
    [
      "PRIMARY",
      "OFFICIAL",
      "TIER1",
      "TIER_1",
      "HIGH",
    ].includes(text)
  ) {
    return 1;
  }

  if (["TIER2", "TIER_2", "GOOD"].includes(text)) {
    return 2;
  }

  if (["TIER3", "TIER_3", "MEDIUM"].includes(text)) {
    return 3;
  }

  if (
    [
      "TIER4",
      "TIER_4",
      "LOW",
      "UNVERIFIED",
    ].includes(text)
  ) {
    return 4;
  }

  return 2;
}

function symbolMatches(event, symbol) {
  if (event?.marketWide === true) {
    return true;
  }

  const explicit = String(event?.symbol ?? "")
    .trim()
    .toUpperCase();

  if (explicit) {
    return explicit === symbol;
  }

  const symbols = Array.isArray(event?.symbols)
    ? event.symbols.map((x) => String(x).toUpperCase())
    : [];

  if (symbols.length) {
    return symbols.includes(symbol);
  }

  return true;
}

function categoryWeight(category) {
  const key = String(category ?? "OTHER")
    .trim()
    .toUpperCase();

  return (
    V4_CATALYST_CFG.categoryWeight[key] ??
    V4_CATALYST_CFG.categoryWeight.OTHER
  );
}

function ageDecay(ageHours) {
  const maxAge = V4_CATALYST_CFG.maxAgeHours;

  if (ageHours < 0 || ageHours > maxAge) {
    return 0;
  }

  const linear = 1 - ageHours / maxAge;
  const recencyBoost =
    ageHours <= V4_CATALYST_CFG.strongAgeHours
      ? 1.15
      : 1.0;

  return clamp(linear * recencyBoost, 0, 1.15);
}

function normalizeEvent(event, nowTs, symbol) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (!symbolMatches(event, symbol)) {
    return null;
  }

  const ts = parseTs(
    event?.ts ??
    event?.time ??
    event?.publishedAt ??
    event?.published_at ??
    event?.timestamp
  );

  // Untimed or future events are rejected to protect replay integrity.
  if (ts === null || ts > nowTs) {
    return null;
  }

  const ageHours =
    (nowTs - ts) / (60 * 60 * 1000);

  if (
    ageHours < 0 ||
    ageHours > V4_CATALYST_CFG.maxAgeHours
  ) {
    return null;
  }

  const sentiment = normalizeSentiment(
    event?.sentiment ??
    event?.direction ??
    event?.bias ??
    event?.score
  );

  if (sentiment === 0) {
    return null;
  }

  const impact = clamp(
    num(event?.impact ?? event?.severity) ?? 3,
    1,
    5
  );

  const relevance = clamp(
    num(event?.relevance) ?? 0.75,
    0,
    1
  );

  const confidence = clamp(
    num(event?.confidence) ?? 0.75,
    0,
    1
  );

  const sourceTier = normalizeSourceTier(
    event?.sourceTier ??
    event?.source_tier ??
    event?.tier
  );

  const sourceQuality =
    V4_CATALYST_CFG.sourceQuality[sourceTier] ??
    0.5;

  const category = String(
    event?.category ?? "OTHER"
  )
    .trim()
    .toUpperCase();

  const decay = ageDecay(ageHours);

  const magnitude =
    (impact / 5) *
    relevance *
    confidence *
    sourceQuality *
    categoryWeight(category) *
    decay *
    2.25;

  const contribution = clamp(
    sentiment * magnitude,
    -2.0,
    2.0
  );

  return {
    ts,
    ageHours: round2(ageHours),
    sentiment,
    impact,
    relevance: round2(relevance),
    confidence: round2(confidence),
    sourceTier,
    category,
    contribution: round2(contribution),
    title: String(
      event?.title ?? event?.headline ?? ""
    ).slice(0, 180),
    source: String(
      event?.source ?? event?.publisher ?? ""
    ).slice(0, 80),
  };
}

export function analyzeV4Catalyst(input = {}) {
  const symbol = String(input?.symbol ?? "")
    .trim()
    .toUpperCase();

  const direction = String(
    input?.direction ?? "NEUTRAL"
  )
    .trim()
    .toUpperCase();

  const nowTs =
    parseTs(input?.nowTs) ??
    Date.now();

  const rawEvents = Array.isArray(input?.catalysts)
    ? input.catalysts
    : Array.isArray(input?.news)
      ? input.news
      : [];

  const events = rawEvents
    .map((event) =>
      normalizeEvent(event, nowTs, symbol)
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        Math.abs(b.contribution) -
        Math.abs(a.contribution)
    );

  const rawNet = events.reduce(
    (sum, event) =>
      sum + event.contribution,
    0
  );

  const netImpact = round2(
    clamp(
      rawNet,
      -V4_CATALYST_CFG.maxNetImpact,
      V4_CATALYST_CFG.maxNetImpact
    )
  );

  const bullishScore = round2(
    clamp(
      V4_CATALYST_CFG.neutralScore +
        netImpact,
      0,
      10
    )
  );

  const bearishScore = round2(
    clamp(
      V4_CATALYST_CFG.neutralScore -
        netImpact,
      0,
      10
    )
  );

  const directionalScore =
    direction === "LONG"
      ? bullishScore
      : direction === "SHORT"
        ? bearishScore
        : V4_CATALYST_CFG.neutralScore;

  let status = "NEUTRAL";

  if (
    bullishScore >=
    V4_CATALYST_CFG.dominantScore
  ) {
    status = "DOMINANT_BULLISH";
  } else if (
    bearishScore >=
    V4_CATALYST_CFG.dominantScore
  ) {
    status = "DOMINANT_BEARISH";
  } else if (
    bullishScore >=
    V4_CATALYST_CFG.strongScore
  ) {
    status = "STRONG_BULLISH";
  } else if (
    bearishScore >=
    V4_CATALYST_CFG.strongScore
  ) {
    status = "STRONG_BEARISH";
  }

  const coverage = round2(
    clamp(events.length / 3, 0, 1)
  );

  const severeAdverse = events.some(
    (event) => {
      const againstDirection =
        direction === "LONG"
          ? event.sentiment < 0
          : direction === "SHORT"
            ? event.sentiment > 0
            : false;

      return (
        againstDirection &&
        event.impact >= 4.5 &&
        event.sourceTier === 1 &&
        event.ageHours <= 8
      );
    }
  );

  const reasons = events
    .filter((x) => x.contribution > 0)
    .slice(0, 4)
    .map(
      (x) =>
        x.title ||
        `${x.category} positive catalyst`
    );

  const warnings = events
    .filter((x) => x.contribution < 0)
    .slice(0, 4)
    .map(
      (x) =>
        x.title ||
        `${x.category} negative catalyst`
    );

  return {
    version: V4_CATALYST_VERSION,
    symbol,
    direction,
    score: directionalScore,
    bullishScore,
    bearishScore,
    netImpact,
    status,
    coverage,
    severeAdverse,
    consideredEvents: events.length,
    reasons,
    warnings,
    events: events.slice(0, 8),

    // Context only until replay proves otherwise.
    hardVeto: false,
    tradePermission: false,
    realOrderPermission: false,
  };
}
