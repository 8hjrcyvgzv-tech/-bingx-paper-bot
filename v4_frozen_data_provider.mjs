// V4 CLEAN CORE — FROZEN DATA PROVIDER V1
// HISTORICAL REPLAY DATA ONLY
// NO NETWORK MARKET DATA / NO PAPER / NO LIVE / NO ORDERS

import {
  readFile,
} from "node:fs/promises";

import {
  gunzipSync,
} from "node:zlib";

import {
  createHash,
} from "node:crypto";

import {
  join,
} from "node:path";

const VERSION =
  "V4_FROZEN_DATA_PROVIDER_1";

const DATASET_DIR =
  process.env.V4_FROZEN_DATASET_DIR ||
  "frozen_dataset";

const EXPECTED_DATASET_ID =
  process.env.V4_FROZEN_DATASET_ID ||
  "V4_CORE6_BINANCE_UM_5M_20260215_20260903_EBECBEDEEE03";

const EXPECTED_ROOT_HASH =
  process.env.V4_FROZEN_ROOT_SHA256 ||
  "ebecbedeee03954dc9a8ff5fdabf764ebf92fb8cd90b30a659f8cbeaf9d67965";

const INTERVAL_MS =
  5 * 60 * 1000;

let manifestCache = null;

const rowsCache =
  new Map();

function sha256(buffer) {
  return createHash("sha256")
    .update(buffer)
    .digest("hex")
    .toLowerCase();
}

function requireValue(
  condition,
  message
) {
  if (!condition) {
    throw new Error(
      `Frozen dataset validation failed: ${message}`
    );
  }
}

export async function
loadFrozenManifest() {
  if (manifestCache) {
    return manifestCache;
  }

  const manifestPath =
    join(
      DATASET_DIR,
      "manifest.json"
    );

  const raw =
    await readFile(
      manifestPath,
      "utf8"
    );

  const manifest =
    JSON.parse(raw);

  requireValue(
    manifest?.status ===
      "FROZEN_EXACT_PASS",
    `status=${manifest?.status}`
  );

  requireValue(
    manifest?.datasetId ===
      EXPECTED_DATASET_ID,
    `datasetId mismatch: ${manifest?.datasetId}`
  );

  requireValue(
    String(
      manifest?.rootContentSha256 || ""
    ).toLowerCase() ===
      EXPECTED_ROOT_HASH.toLowerCase(),
    "root content SHA256 mismatch"
  );

  requireValue(
    Number(
      manifest?.layout?.warmupDays
    ) === 100,
    "warmupDays must be 100"
  );

  requireValue(
    Number(
      manifest?.layout?.replayDays
    ) === 100,
    "replayDays must be 100"
  );

  requireValue(
    Number(
      manifest?.layout?.outcomeTailDays
    ) === 1,
    "outcomeTailDays must be 1"
  );

  requireValue(
    Number(
      manifest?.layout
        ?.expectedRowsPerSymbol
    ) === 57888,
    "expectedRowsPerSymbol must be 57888"
  );

  requireValue(
    Array.isArray(
      manifest?.files
    ) &&
      manifest.files.length === 6,
    "CORE6 manifest file count must be 6"
  );

  manifestCache =
    manifest;

  console.log(
    `[FROZEN] manifest PASS dataset=${manifest.datasetId}`
  );

  return manifest;
}

function parseCsv(
  canonicalBytes
) {
  const text =
    canonicalBytes
      .toString("utf8")
      .trim();

  const lines =
    text.split(/\r?\n/);

  requireValue(
    lines.length >= 2,
    "CSV has no data rows"
  );

  const header =
    lines[0].split(",");

  const index =
    Object.fromEntries(
      header.map(
        (name, i) => [
          name,
          i,
        ]
      )
    );

  const required = [
    "openTimeMs",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "closeTimeMs",
    "quoteVolume",
  ];

  for (const name of required) {
    requireValue(
      Number.isInteger(
        index[name]
      ),
      `CSV missing column ${name}`
    );
  }

  const rows = [];

  for (
    let lineNo = 1;
    lineNo < lines.length;
    lineNo++
  ) {
    const cells =
      lines[lineNo]
        .split(",");

    if (
      cells.length <
      header.length
    ) {
      throw new Error(
        `Malformed frozen CSV line ${lineNo + 1}`
      );
    }

    const openTime =
      Number(
        cells[
          index.openTimeMs
        ]
      );

    const closeTime =
      Number(
        cells[
          index.closeTimeMs
        ]
      );

    const open =
      Number(
        cells[index.open]
      );

    const high =
      Number(
        cells[index.high]
      );

    const low =
      Number(
        cells[index.low]
      );

    const close =
      Number(
        cells[index.close]
      );

    const volume =
      Number(
        cells[index.volume]
      );

    const quoteVolume =
      Number(
        cells[
          index.quoteVolume
        ]
      );

    requireValue(
      [
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume,
        quoteVolume,
      ].every(
        Number.isFinite
      ),
      `non-finite numeric value at CSV line ${lineNo + 1}`
    );

    rows.push({
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
    });
  }

  return rows;
}

function verifyFiveMinuteRows(
  rows,
  expectedRows
) {
  requireValue(
    rows.length ===
      expectedRows,
    `row count ${rows.length}/${expectedRows}`
  );

  let previous = null;

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {
    const row =
      rows[i];

    requireValue(
      row.openTime > 0 &&
        row.close > 0,
      `invalid row ${i}`
    );

    if (
      previous !== null
    ) {
      const gap =
        row.openTime -
        previous;

      requireValue(
        gap ===
          INTERVAL_MS,
        `5m gap/duplicate at row ${i}: ${gap}ms`
      );
    }

    previous =
      row.openTime;
  }
}

export async function
loadFrozenFiveMinuteRows(
  symbol
) {
  const key =
    String(
      symbol || ""
    ).toUpperCase();

  if (
    rowsCache.has(key)
  ) {
    return rowsCache.get(key);
  }

  const manifest =
    await loadFrozenManifest();

  const entry =
    manifest.files.find(
      (x) =>
        String(
          x?.symbol || ""
        ).toUpperCase() ===
        key
    );

  requireValue(
    entry,
    `symbol not found in manifest: ${key}`
  );

  requireValue(
    entry?.integrityPass ===
      true,
    `${key} integrityPass is not true`
  );

  const relative =
    String(
      entry.file || ""
    ).replace(
      /^frozen_dataset\//,
      ""
    );

  const filePath =
    join(
      DATASET_DIR,
      relative
    );

  const compressed =
    await readFile(
      filePath
    );

  const gzipHash =
    sha256(
      compressed
    );

  requireValue(
    gzipHash ===
      String(
        entry.gzipSha256
      ).toLowerCase(),
    `${key} gzip SHA256 mismatch`
  );

  const canonical =
    gunzipSync(
      compressed
    );

  const canonicalHash =
    sha256(
      canonical
    );

  requireValue(
    canonicalHash ===
      String(
        entry.canonicalCsvSha256
      ).toLowerCase(),
    `${key} canonical CSV SHA256 mismatch`
  );

  const rows =
    parseCsv(
      canonical
    );

  verifyFiveMinuteRows(
    rows,
    Number(
      entry.expectedRows
    )
  );

  rowsCache.set(
    key,
    rows
  );

  console.log(
    `[FROZEN] ${key} PASS rows=${rows.length} gzipSHA=${gzipHash.slice(0, 12)}`
  );

  return rows;
}

export const
V4_FROZEN_DATA_PROVIDER_VERSION =
  VERSION;
