// V4 CLEAN CORE — FROZEN 100D CONTROL REPLAY HARNESS V1
// TIBERIUS PERFORMANCE LAB
// HISTORICAL REPLAY ONLY
// NO PAPER / NO LIVE / NO ORDERS
//
// This harness:
// 1) copies production V4 modules to a temp tree,
// 2) preserves production files unchanged,
// 3) applies replay-only precision fixes,
// 4) replaces BingX historical API calls with the verified frozen dataset,
// 5) gives every HTF module 100 full warmup days,
// 6) keeps the 1-day outcome tail invisible to signal generation,
// 7) fails non-zero if any CORE6 symbol fails.

import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";

import {
  pathToFileURL,
} from "node:url";

const TMP_DIR =
  ".v4_frozen_replay_tmp";

const FILES = [
  "v4_radar.js",
  "v4_direction.js",
  "v4_structure.js",
  "v4_flow.js",
  "v4_catalyst.js",
  "v4_execution.js",
  "worker_v4_clean_core.js",
  "v4_replay_runner.mjs",
  "v4_frozen_data_provider.mjs",
];

function replaceOnce(
  source,
  needle,
  replacement,
  label
) {
  const first =
    source.indexOf(
      needle
    );

  if (first < 0) {
    throw new Error(
      `Frozen replay patch failed: ${label} pattern not found`
    );
  }

  const second =
    source.indexOf(
      needle,
      first +
        needle.length
    );

  if (second >= 0) {
    throw new Error(
      `Frozen replay patch failed: ${label} pattern is not unique`
    );
  }

  return (
    source.slice(
      0,
      first
    ) +
    replacement +
    source.slice(
      first +
        needle.length
    )
  );
}

function replaceSection(
  source,
  startNeedle,
  endNeedle,
  replacement,
  label
) {
  const start =
    source.indexOf(
      startNeedle
    );

  if (start < 0) {
    throw new Error(
      `Frozen replay patch failed: ${label} start not found`
    );
  }

  const end =
    source.indexOf(
      endNeedle,
      start
    );

  if (end < 0) {
    throw new Error(
      `Frozen replay patch failed: ${label} end not found`
    );
  }

  return (
    source.slice(
      0,
      start
    ) +
    replacement +
    "\n\n" +
    source.slice(end)
  );
}

async function
prepareTempTree() {
  await rm(
    TMP_DIR,
    {
      recursive: true,
      force: true,
    }
  );

  await mkdir(
    TMP_DIR,
    {
      recursive: true,
    }
  );

  for (
    const file of FILES
  ) {
    await copyFile(
      file,
      `${TMP_DIR}/${file}`
    );
  }
}

async function
patchExecution() {
  const path =
    `${TMP_DIR}/v4_execution.js`;

  let source =
    await readFile(
      path,
      "utf8"
    );

  const needle =
`    rr: {
      tp1:
        round2(rr1),

      tp2:
        round2(rr2),
    },

    componentScores: {`;

  const replacement =
`    rr: {
      tp1:
        round2(rr1),

      tp2:
        round2(rr2),
    },

    // Replay-only precision payload.
    // Production UI fields stay unchanged.
    raw: {
      entry,
      stop,
      tp1:
        targets.tp1,
      tp2:
        targets.tp2,
      rr1,
      rr2,
    },

    componentScores: {`;

  source =
    replaceOnce(
      source,
      needle,
      replacement,
      "raw execution geometry"
    );

  await writeFile(
    path,
    source,
    "utf8"
  );
}

async function
patchReplayRunner() {
  const path =
    `${TMP_DIR}/v4_replay_runner.mjs`;

  let source =
    await readFile(
      path,
      "utf8"
    );

  // Add the frozen data provider without touching production source.
  const importNeedle =
`import {
  runV4CleanCore,
} from "./worker_v4_clean_core.js";`;

  const importReplacement =
`import {
  runV4CleanCore,
} from "./worker_v4_clean_core.js";

import {
  loadFrozenManifest,
  loadFrozenFiveMinuteRows,
} from "./v4_frozen_data_provider.mjs";`;

  source =
    replaceOnce(
      source,
      importNeedle,
      importReplacement,
      "frozen provider import"
    );

  source =
    replaceOnce(
      source,
      `const VERSION = "V4_REPLAY_RUNNER_1";`,
      `const VERSION = "V4_FROZEN_CONTROL_REPLAY_1";`,
      "frozen replay version"
    );

  // Numeric timestamp fix from the validated replay harness.
  const timestampNeedle =
`  const {
    timestamp,
    direction,
    entry,
    stop,
    tp1,
    tp2,
  } = signal;`;

  const timestampReplacement =
`  const {
    timestampMs,
    direction,
    entry,
    stop,
    tp1,
    tp2,
  } = signal;

  const timestamp =
    Number(timestampMs);

  if (!Number.isFinite(timestamp)) {
    return {
      outcome:
        "INVALID_TIMESTAMP",

      resultR:
        null,
    };
  }`;

  source =
    replaceOnce(
      source,
      timestampNeedle,
      timestampReplacement,
      "numeric replay timestamp"
    );

  // Consume replay-only raw geometry.
  const geometryNeedle =
`      entry:
        num(
          execution?.entry
        ),

      stop:
        num(
          execution?.stop
        ),

      tp1:
        num(
          execution?.tp1
        ),

      tp2:
        num(
          execution?.tp2
        ),

      rr1:
        num(
          execution?.rr
            ?.tp1
        ),

      rr2:
        num(
          execution?.rr
            ?.tp2
        ),`;

  const geometryReplacement =
`      entry:
        num(
          execution?.raw
            ?.entry ??
          execution?.entry
        ),

      stop:
        num(
          execution?.raw
            ?.stop ??
          execution?.stop
        ),

      tp1:
        num(
          execution?.raw
            ?.tp1 ??
          execution?.tp1
        ),

      tp2:
        num(
          execution?.raw
            ?.tp2 ??
          execution?.tp2
        ),

      rr1:
        num(
          execution?.raw
            ?.rr1 ??
          execution?.rr
            ?.tp1
        ),

      rr2:
        num(
          execution?.raw
            ?.rr2 ??
          execution?.rr
            ?.tp2
        ),`;

  source =
    replaceOnce(
      source,
      geometryNeedle,
      geometryReplacement,
      "raw replay geometry consumption"
    );

  // Replace the whole read-only BingX historical fetch function with
  // deterministic local frozen-dataset access.
  const fetchStart =
    "async function fetchKlines(";

  const fetchEnd =
`// ---------------------------------------------------------
// 5M -> 15M / 1H AGGREGATION`;

  const localFetch =
`async function fetchKlines(
  symbol,
  interval,
  startTime,
  endTime
) {
  const base =
    await loadFrozenFiveMinuteRows(
      symbol
    );

  let sourceRows;

  if (
    interval === "5m"
  ) {
    sourceRows =
      base;
  } else {
    const minutes =
      interval === "4h"
        ? 240
        : interval === "12h"
        ? 720
        : interval === "1d"
        ? 1440
        : null;

    if (!minutes) {
      throw new Error(
        \`Frozen replay unsupported interval: \${interval}\`
      );
    }

    sourceRows =
      aggregateCandles(
        base,
        minutes
      );
  }

  const intervalMs =
    INTERVAL_MS[interval];

  const output =
    sourceRows.filter(
      (x) =>
        x.openTime >=
          startTime &&
        x.openTime <=
          endTime
    );

  const firstExpectedOpen =
    Math.ceil(
      startTime /
        intervalMs
    ) *
    intervalMs;

  const lastExpectedOpen =
    Math.floor(
      endTime /
        intervalMs
    ) *
    intervalMs;

  const expected =
    lastExpectedOpen >=
      firstExpectedOpen
      ? Math.floor(
          (
            lastExpectedOpen -
            firstExpectedOpen
          ) /
            intervalMs
        ) + 1
      : 0;

  console.log(
    \`[FROZEN-DATA] \${symbol} \${interval} rows=\${output.length}/\${expected} \${iso(startTime)} -> \${iso(endTime)}\`
  );

  if (
    expected > 0 &&
    output.length !==
      expected
  ) {
    throw new Error(
      \`Frozen replay coverage mismatch for \${symbol} \${interval}: \${output.length}/\${expected}\`
    );
  }

  return output;
}`;

  source =
    replaceSection(
      source,
      fetchStart,
      fetchEnd,
      localFetch,
      "local frozen fetchKlines"
    );

  // Use the full verified warmup for every timeframe.
  source =
    replaceOnce(
      source,
`  const fiveStart =
    replayStart -
    3 * DAY;`,
`  const fiveStart =
    replayStart -
    100 * DAY;`,
      "5m 100d warmup"
    );

  source =
    replaceOnce(
      source,
`  const fourStart =
    replayStart -
    15 * DAY;`,
`  const fourStart =
    replayStart -
    100 * DAY;`,
      "4h 100d warmup"
    );

  source =
    replaceOnce(
      source,
`  const twelveStart =
    replayStart -
    25 * DAY;`,
`  const twelveStart =
    replayStart -
    100 * DAY;`,
      "12h 100d warmup"
    );

  source =
    replaceOnce(
      source,
`  const dailyStart =
    replayStart -
    50 * DAY;`,
`  const dailyStart =
    replayStart -
    100 * DAY;`,
      "1d 100d warmup"
    );

  // Five-minute data alone receives the 24h outcome tail.
  // Signal generation remains bounded by replayEnd via replayBars + sliceUntil.
  const fiveFetchNeedle =
`  const fiveRaw =
    await fetchKlines(
      symbol,
      "5m",
      fiveStart,
      replayEnd
    );`;

  const fiveFetchReplacement =
`  const fiveRaw =
    await fetchKlines(
      symbol,
      "5m",
      fiveStart,
      replayEnd +
        CONFIG.outcomeHours *
          HOUR
    );`;

  source =
    replaceOnce(
      source,
      fiveFetchNeedle,
      fiveFetchReplacement,
      "outcome tail fetch"
    );

  // Freeze the replay clock to manifest dates, never Date.now().
  const clockNeedle =
`  const now =
    Date.now();

  // Avoid the currently forming market candle.
  const replayEnd =
    now -
    20 * MINUTE;

  const replayStart =
    replayEnd -
    CONFIG.replayDays *
      DAY;`;

  const clockReplacement =
`  const manifest =
    await loadFrozenManifest();

  const replayStart =
    Date.parse(
      manifest.layout
        .replayStart
    );

  const replayEndOpen =
    Date.parse(
      manifest.layout
        .replayEnd
    );

  // Manifest stores the final 5m OPEN timestamp (23:55).
  // Replay uses the completed bar close bound (23:59:59.999).
  const replayEnd =
    replayEndOpen +
    INTERVAL_MS["5m"] -
    1;

  if (
    !Number.isFinite(
      replayStart
    ) ||
    !Number.isFinite(
      replayEnd
    ) ||
    replayEnd <=
      replayStart
  ) {
    throw new Error(
      "Invalid frozen replay window in manifest"
    );
  }`;

  source =
    replaceOnce(
      source,
      clockNeedle,
      clockReplacement,
      "manifest replay clock"
    );

  // Record immutable dataset identity in the output.
  const configNeedle =
`    config:
      CONFIG,

    replayWindow: {`;

  const configReplacement =
`    config:
      CONFIG,

    dataset: {
      id:
        manifest.datasetId,

      rootContentSha256:
        manifest.rootContentSha256,

      source:
        manifest.source,

      layout:
        manifest.layout,

      volumeProxyCaveat:
        manifest
          ?.crossExchangeValidation
          ?.normalizedVolumeProxy ??
        null,
    },

    replayWindow: {`;

  source =
    replaceOnce(
      source,
      configNeedle,
      configReplacement,
      "dataset identity in summary"
    );

  // Make limitations explicit.
  const limitationNeedle =
`    limitations: [
      "Initial replay uses 5m base data; dedicated XRP/ZEC 1m regression comes later.",`;

  const limitationReplacement =
`    limitations: [
      "Frozen source is Binance USD-M Futures official archive validated against recent BingX price/structure data.",
      "Binance volume is a replay proxy, not venue-native BingX volume; DOGE normalized-volume proxy was not validated in the prior overlap test.",
      "Initial replay uses 5m base data; dedicated XRP/ZEC 1m regression comes later.",`;

  source =
    replaceOnce(
      source,
      limitationNeedle,
      limitationReplacement,
      "frozen replay limitations"
    );

  // Old runner swallowed per-symbol failures. In this control replay,
  // any CORE6 failure makes the workflow red.
  const allEventsNeedle =
`  const allEvents =
    symbolResults`;

  const allEventsReplacement =
`  const failedSymbols =
    symbolResults.filter(
      (x) => x?.error
    );

  if (
    failedSymbols.length
  ) {
    throw new Error(
      \`Frozen control replay symbol failures: \${failedSymbols
        .map(
          (x) =>
            \`\${x.symbol}=\${x.error}\`
        )
        .join("; ")}\`
    );
  }

  const allEvents =
    symbolResults`;

  source =
    replaceOnce(
      source,
      allEventsNeedle,
      allEventsReplacement,
      "nonzero on symbol failure"
    );

  // Let the harness await completion; fatal exceptions propagate out.
  const mainNeedle =
`main().catch(
  (error) => {
    console.error(
      "V4 REPLAY FATAL:",
      error
    );

    process.exitCode = 1;
  }
);`;

  source =
    replaceOnce(
      source,
      mainNeedle,
      `await main();`,
      "await replay completion"
    );

  await writeFile(
    path,
    source,
    "utf8"
  );
}

async function main() {
  console.log(
    "V4 FROZEN CONTROL HARNESS: preparing immutable 100d replay"
  );

  await prepareTempTree();
  await patchExecution();
  await patchReplayRunner();

  console.log(
    "V4 FROZEN CONTROL HARNESS: precision + frozen data + 100d warmup patches PASS"
  );

  const runnerUrl =
    pathToFileURL(
      `${process.cwd()}/${TMP_DIR}/v4_replay_runner.mjs`
    ).href;

  await import(
    `${runnerUrl}?run=${Date.now()}`
  );
}

try {
  await main();
} finally {
  await rm(
    TMP_DIR,
    {
      recursive: true,
      force: true,
    }
  );
}
