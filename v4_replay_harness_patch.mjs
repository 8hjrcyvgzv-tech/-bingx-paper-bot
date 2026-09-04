// V4 Replay Harness Patch
// TEST / REPLAY ONLY — NO ORDERS
//
// Purpose:
// 1) Preserve production V4 modules unchanged.
// 2) Build a temporary replay-only copy.
// 3) Expose raw execution geometry to avoid 2-decimal distortion.
// 4) Fix replay outcome timestamp to use timestampMs, not ISO text.
// 5) Use conservative BingX pagination and fail on incomplete/gapped replay data.
//
// This file never calls an order endpoint.

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

const TMP_DIR = ".v4_replay_tmp";

const FILES = [
  "v4_radar.js",
  "v4_direction.js",
  "v4_structure.js",
  "v4_flow.js",
  "v4_catalyst.js",
  "v4_execution.js",
  "worker_v4_clean_core.js",
  "v4_replay_runner.mjs",
];

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);

  if (first < 0) {
    throw new Error(`Replay harness patch failed: ${label} pattern not found`);
  }

  const second = source.indexOf(
    needle,
    first + needle.length
  );

  if (second >= 0) {
    throw new Error(`Replay harness patch failed: ${label} pattern is not unique`);
  }

  return (
    source.slice(0, first) +
    replacement +
    source.slice(first + needle.length)
  );
}

async function prepareTempTree() {
  await rm(TMP_DIR, {
    recursive: true,
    force: true,
  });

  await mkdir(TMP_DIR, {
    recursive: true,
  });

  for (const file of FILES) {
    await copyFile(
      file,
      `${TMP_DIR}/${file}`
    );
  }
}

async function patchExecution() {
  const path =
    `${TMP_DIR}/v4_execution.js`;

  let source =
    await readFile(path, "utf8");

  const needle = `    rr: {\n      tp1:\n        round2(rr1),\n\n      tp2:\n        round2(rr2),\n    },\n\n    componentScores: {`;

  const replacement = `    rr: {\n      tp1:\n        round2(rr1),\n\n      tp2:\n        round2(rr2),\n    },\n\n    // Replay-only precision payload.\n    // Display fields above stay rounded for UI compatibility.\n    raw: {\n      entry,\n      stop,\n      tp1:\n        targets.tp1,\n      tp2:\n        targets.tp2,\n      rr1,\n      rr2,\n    },\n\n    componentScores: {`;

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

async function patchReplayRunner() {
  const path =
    `${TMP_DIR}/v4_replay_runner.mjs`;

  let source =
    await readFile(path, "utf8");

  const timestampNeedle = `  const {\n    timestamp,\n    direction,\n    entry,\n    stop,\n    tp1,\n    tp2,\n  } = signal;`;

  const timestampReplacement = `  const {\n    timestampMs,\n    direction,\n    entry,\n    stop,\n    tp1,\n    tp2,\n  } = signal;\n\n  const timestamp =\n    Number(timestampMs);\n\n  if (!Number.isFinite(timestamp)) {\n    return {\n      outcome:\n        "INVALID_TIMESTAMP",\n\n      resultR:\n        null,\n    };\n  }`;

  source =
    replaceOnce(
      source,
      timestampNeedle,
      timestampReplacement,
      "numeric replay timestamp"
    );

  const geometryNeedle = `      entry:\n        num(\n          execution?.entry\n        ),\n\n      stop:\n        num(\n          execution?.stop\n        ),\n\n      tp1:\n        num(\n          execution?.tp1\n        ),\n\n      tp2:\n        num(\n          execution?.tp2\n        ),\n\n      rr1:\n        num(\n          execution?.rr\n            ?.tp1\n        ),\n\n      rr2:\n        num(\n          execution?.rr\n            ?.tp2\n        ),`;

  const geometryReplacement = `      entry:\n        num(\n          execution?.raw\n            ?.entry ??\n          execution?.entry\n        ),\n\n      stop:\n        num(\n          execution?.raw\n            ?.stop ??\n          execution?.stop\n        ),\n\n      tp1:\n        num(\n          execution?.raw\n            ?.tp1 ??\n          execution?.tp1\n        ),\n\n      tp2:\n        num(\n          execution?.raw\n            ?.tp2 ??\n          execution?.tp2\n        ),\n\n      rr1:\n        num(\n          execution?.raw\n            ?.rr1 ??\n          execution?.rr\n            ?.tp1\n        ),\n\n      rr2:\n        num(\n          execution?.raw\n            ?.rr2 ??\n          execution?.rr\n            ?.tp2\n        ),`;

  source =
    replaceOnce(
      source,
      geometryNeedle,
      geometryReplacement,
      "raw replay geometry consumption"
    );

  // BingX documents max 1440, but replay evidence showed silent partial
  // low-timeframe coverage with 1440-sized historical windows.
  // Use the documented default-sized 500-candle chunks for replay safety.
  source =
    replaceOnce(
      source,
      `  const maxRows = 1440;`,
      `  const maxRows = 500;`,
      "conservative kline pagination"
    );

  const returnNeedle = `  return [\n    ...dedupe.values(),\n  ].sort(\n    (a, b) =>\n      a.openTime -\n      b.openTime\n  );`;

  const returnReplacement = `  const output = [\n    ...dedupe.values(),\n  ].sort(\n    (a, b) =>\n      a.openTime -\n      b.openTime\n  );\n\n  // Replay integrity gate: never silently call a partial history a\n  // 60d/100d test. A few boundary bars are tolerated; large gaps fail.\n  const expectedBars =\n    Math.max(\n      1,\n      Math.floor(\n        (endTime - startTime) /\n          intervalMs\n      ) + 1\n    );\n\n  const coverage =\n    output.length /\n    expectedBars;\n\n  let maxGapMs = 0;\n\n  for (\n    let i = 1;\n    i < output.length;\n    i++\n  ) {\n    maxGapMs =\n      Math.max(\n        maxGapMs,\n        output[i].openTime -\n          output[i - 1].openTime\n      );\n  }\n\n  console.log(\n    \`[COVERAGE] \${symbol} \${interval} rows=\${output.length} expected≈\${expectedBars} coverage=\${round(coverage * 100, 2)}% maxGapMin=\${round(maxGapMs / MINUTE, 2)}\`\n  );\n\n  if (coverage < 0.97) {\n    throw new Error(\n      \`Replay data incomplete for \${symbol} \${interval}: \${round(coverage * 100, 2)}% coverage (\${output.length}/\${expectedBars})\`\n    );\n  }\n\n  if (\n    output.length > 1 &&\n    maxGapMs >\n      intervalMs * 3\n  ) {\n    throw new Error(\n      \`Replay data gap too large for \${symbol} \${interval}: \${round(maxGapMs / MINUTE, 2)} minutes\`\n    );\n  }\n\n  return output;`;

  source =
    replaceOnce(
      source,
      returnNeedle,
      returnReplacement,
      "replay data integrity gate"
    );

  const mainNeedle = `main().catch(\n  (error) => {\n    console.error(\n      "V4 REPLAY FATAL:",\n      error\n    );\n\n    process.exitCode = 1;\n  }\n);`;

  const mainReplacement = `await main();`;

  source =
    replaceOnce(
      source,
      mainNeedle,
      mainReplacement,
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
    "V4 REPLAY HARNESS: preparing precision + data-integrity safe replay copy"
  );

  await prepareTempTree();
  await patchExecution();
  await patchReplayRunner();

  console.log(
    "V4 REPLAY HARNESS: timestamp + raw geometry + pagination + coverage patches PASS"
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
  await rm(TMP_DIR, {
    recursive: true,
    force: true,
  });
}
