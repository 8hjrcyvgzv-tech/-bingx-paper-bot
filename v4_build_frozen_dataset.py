#!/usr/bin/env python3
# V4 CLEAN CORE — FROZEN DATASET BUILDER V1
# READ-ONLY HISTORICAL DATA BUILD ONLY
# NO STRATEGY IMPORTS / NO SCANNER / NO PAPER / NO LIVE / NO ORDERS
#
# Dataset layout:
#   100 completed UTC days WARMUP
# + 100 completed UTC days REPLAY/TEST
# +   1 completed UTC day OUTCOME TAIL
# = 201 days total per symbol
#
# Why 100 warmup days?
# v4_direction.js uses EMA100 on HTF context. The first replay day therefore
# needs 100 fully completed prior daily candles to avoid an under-warmed start.
#
# Why 1 outcome-tail day?
# The replay lab resolves trades over a 24h outcome window. The final replay
# day needs one future day for outcome resolution without leaking that data
# into signal generation.
#
# Source:
# Binance USD-M Futures official public archive (data.binance.vision).
# Full calendar months are downloaded from monthly archives where available;
# boundary months and monthly misses fall back to daily archives.
# Every ZIP is SHA256 checked against its official .CHECKSUM file.

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

VERSION = "V4_FROZEN_DATASET_BUILDER_1"
SOURCE = "BINANCE_USDM_OFFICIAL_PUBLIC_ARCHIVE"
INTERVAL = "5m"
INTERVAL_MS = 5 * 60_000
BARS_PER_DAY = 288

WARMUP_DAYS = int(os.getenv("V4_WARMUP_DAYS", "100"))
REPLAY_DAYS = int(os.getenv("V4_REPLAY_DAYS", "100"))
OUTCOME_TAIL_DAYS = int(os.getenv("V4_OUTCOME_TAIL_DAYS", "1"))
TOTAL_DAYS = WARMUP_DAYS + REPLAY_DAYS + OUTCOME_TAIL_DAYS

SYMBOLS = [
    s.strip().upper()
    for s in os.getenv(
        "V4_DATASET_SYMBOLS",
        "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,ZEC-USDT",
    ).split(",")
    if s.strip()
]

ARCHIVE_WORKERS = int(os.getenv("V4_ARCHIVE_WORKERS", "8"))
DISCOVERY_BACK_DAYS = int(os.getenv("V4_DISCOVERY_BACK_DAYS", "7"))
USER_AGENT = "V4-Frozen-Dataset-Builder/1.0"

DAILY_BASE = "https://data.binance.vision/data/futures/um/daily/klines"
MONTHLY_BASE = "https://data.binance.vision/data/futures/um/monthly/klines"

OUTDIR = Path("frozen_dataset")
DATADIR = OUTDIR / "data"
MANIFEST_PATH = OUTDIR / "manifest.json"
SUMMARY_PATH = OUTDIR / "build_summary.json"

# Provenance from the completed 30d BingX-vs-Binance archive validation.
# This is metadata only; it does not alter downloaded candles.
CROSS_VALIDATION = {
    "runId": 33922822478,
    "window": {
        "start": "2026-08-05T00:00:00Z",
        "end": "2026-09-03T23:55:00Z",
        "interval": "5m",
    },
    "priceStructureProxy": {
        "status": "PASS_CORE6_6_OF_6",
        "validatedSymbols": [
            "BTC-USDT", "ETH-USDT", "SOL-USDT",
            "XRP-USDT", "DOGE-USDT", "ZEC-USDT"
        ],
    },
    "normalizedVolumeProxy": {
        "status": "PARTIAL_PASS_5_OF_6",
        "validatedSymbols": [
            "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "ZEC-USDT"
        ],
        "notValidatedSymbols": ["DOGE-USDT"],
        "note": "DOGE normalized volume correlation was below the pre-registered 0.50 threshold; do not treat Binance volume as venue-native BingX volume.",
    },
}

_cache: dict[str, tuple[bytes, dict[str, Any]]] = {}


def utc_midnight(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def symbol_code(symbol: str) -> str:
    return symbol.replace("-", "")


def normalize_ts_ms(value: Any) -> int | None:
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return None
    # Defensive support if an archive uses microseconds.
    if n > 100_000_000_000_000:
        n //= 1000
    return n


def http_get_bytes(url: str, timeout: int = 35) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().lower()


def fetch_verified_zip(url: str) -> tuple[bytes, dict[str, Any]]:
    if url in _cache:
        return _cache[url]

    payload = http_get_bytes(url)
    checksum_text = http_get_bytes(url + ".CHECKSUM").decode(
        "utf-8", errors="replace"
    ).strip()

    expected = checksum_text.split()[0].strip().lower()
    actual = sha256_bytes(payload)

    if len(expected) != 64:
        raise RuntimeError(f"Invalid CHECKSUM format for {url}")

    if actual != expected:
        raise RuntimeError(
            f"SHA256 mismatch for {url}: expected={expected} actual={actual}"
        )

    meta = {
        "url": url,
        "sha256": actual,
        "bytes": len(payload),
        "checksumVerified": True,
    }
    _cache[url] = (payload, meta)
    return payload, meta


def daily_url(symbol: str, day: datetime) -> str:
    s = symbol_code(symbol)
    d = day.strftime("%Y-%m-%d")
    return f"{DAILY_BASE}/{s}/5m/{s}-5m-{d}.zip"


def monthly_url(symbol: str, month: datetime) -> str:
    s = symbol_code(symbol)
    ym = month.strftime("%Y-%m")
    return f"{MONTHLY_BASE}/{s}/5m/{s}-5m-{ym}.zip"


def latest_complete_archive_day() -> datetime:
    today = utc_midnight(datetime.now(timezone.utc))
    probe = SYMBOLS[0] if SYMBOLS else "BTC-USDT"

    for back in range(1, DISCOVERY_BACK_DAYS + 1):
        day = today - timedelta(days=back)
        try:
            fetch_verified_zip(daily_url(probe, day))
            print(f"[DISCOVERY] latest verified daily archive: {day.date()}")
            return day
        except Exception as exc:
            print(f"[DISCOVERY] {day.date()} unavailable: {exc}")

    raise RuntimeError(
        f"No complete verified archive day found in previous "
        f"{DISCOVERY_BACK_DAYS} UTC days"
    )


def month_start(dt: datetime) -> datetime:
    return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def next_month(dt: datetime) -> datetime:
    if dt.month == 12:
        return dt.replace(year=dt.year + 1, month=1, day=1)
    return dt.replace(month=dt.month + 1, day=1)


def month_end_day(dt: datetime) -> datetime:
    return next_month(month_start(dt)) - timedelta(days=1)


def enumerate_days(start_day: datetime, end_day: datetime) -> list[datetime]:
    out = []
    cur = start_day
    while cur <= end_day:
        out.append(cur)
        cur += timedelta(days=1)
    return out


def plan_archives(
    symbol: str,
    start_day: datetime,
    end_day: datetime,
) -> list[dict[str, Any]]:
    """
    Use monthly archives for full calendar months completely inside the
    dataset window. Boundary partial months use daily files.
    Monthly failures are converted to daily fallback at fetch time.
    """
    plan: list[dict[str, Any]] = []
    cur = month_start(start_day)

    while cur <= end_day:
        m_start = cur
        m_end = month_end_day(cur)

        use_start = max(start_day, m_start)
        use_end = min(end_day, m_end)

        full_month = (use_start == m_start and use_end == m_end)

        if full_month:
            plan.append({
                "kind": "MONTHLY",
                "symbol": symbol,
                "month": m_start,
                "startDay": use_start,
                "endDay": use_end,
                "url": monthly_url(symbol, m_start),
            })
        else:
            for day in enumerate_days(use_start, use_end):
                plan.append({
                    "kind": "DAILY",
                    "symbol": symbol,
                    "day": day,
                    "startDay": day,
                    "endDay": day,
                    "url": daily_url(symbol, day),
                })

        cur = next_month(cur)

    return plan


def parse_archive_zip(payload: bytes) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not csv_names:
            raise RuntimeError("ZIP contains no CSV")

        with zf.open(csv_names[0]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
            reader = csv.reader(text)

            for row in reader:
                if len(row) < 11:
                    continue

                open_ms = normalize_ts_ms(row[0])
                close_ms = normalize_ts_ms(row[6])

                try:
                    # Validate numeric fields but preserve source strings.
                    numeric = [
                        float(row[1]), float(row[2]), float(row[3]),
                        float(row[4]), float(row[5]), float(row[7]),
                        float(row[8]), float(row[9]), float(row[10]),
                    ]
                except (TypeError, ValueError):
                    # Header or malformed row.
                    continue

                if open_ms is None or close_ms is None:
                    continue
                if not all(math.isfinite(x) for x in numeric):
                    continue
                if numeric[3] <= 0:
                    continue

                rows.append({
                    "openTimeMs": open_ms,
                    "open": row[1],
                    "high": row[2],
                    "low": row[3],
                    "close": row[4],
                    "volume": row[5],
                    "closeTimeMs": close_ms,
                    "quoteVolume": row[7],
                    "trades": row[8],
                    "takerBuyBaseVolume": row[9],
                    "takerBuyQuoteVolume": row[10],
                    "ignore": row[11] if len(row) > 11 else "0",
                })

    return rows


def fetch_plan_item(item: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    Returns rows + source-file metadata.
    A missing monthly archive falls back to verified daily files.
    """
    if item["kind"] == "DAILY":
        payload, meta = fetch_verified_zip(item["url"])
        rows = parse_archive_zip(payload)
        return rows, [{
            **meta,
            "kind": "DAILY",
            "day": item["day"].strftime("%Y-%m-%d"),
        }]

    # MONTHLY
    try:
        payload, meta = fetch_verified_zip(item["url"])
        rows = parse_archive_zip(payload)
        return rows, [{
            **meta,
            "kind": "MONTHLY",
            "month": item["month"].strftime("%Y-%m"),
        }]
    except Exception as monthly_error:
        print(
            f"[FALLBACK] monthly archive unavailable "
            f"{item['symbol']} {item['month'].strftime('%Y-%m')}: "
            f"{monthly_error}"
        )

        rows: list[dict[str, Any]] = []
        metas: list[dict[str, Any]] = []

        for day in enumerate_days(item["startDay"], item["endDay"]):
            url = daily_url(item["symbol"], day)
            payload, meta = fetch_verified_zip(url)
            rows.extend(parse_archive_zip(payload))
            metas.append({
                **meta,
                "kind": "DAILY_FALLBACK",
                "day": day.strftime("%Y-%m-%d"),
            })

        return rows, metas


def dedupe_sort(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    by_ts: dict[int, dict[str, Any]] = {}
    duplicate_count = 0

    for row in rows:
        ts = int(row["openTimeMs"])
        if ts in by_ts:
            duplicate_count += 1
        by_ts[ts] = row

    ordered = [by_ts[k] for k in sorted(by_ts)]
    return ordered, duplicate_count


def exact_integrity(
    rows: list[dict[str, Any]],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    filtered = [
        x for x in rows
        if start_ms <= int(x["openTimeMs"]) <= end_ms
    ]
    ordered, duplicate_count = dedupe_sort(filtered)

    expected = TOTAL_DAYS * BARS_PER_DAY
    gaps = 0
    max_gap_ms = 0

    for i in range(1, len(ordered)):
        gap = int(ordered[i]["openTimeMs"]) - int(ordered[i - 1]["openTimeMs"])
        max_gap_ms = max(max_gap_ms, gap)
        if gap != INTERVAL_MS:
            gaps += 1

    first_ok = bool(ordered) and int(ordered[0]["openTimeMs"]) == start_ms
    last_ok = bool(ordered) and int(ordered[-1]["openTimeMs"]) == end_ms

    exact = (
        len(ordered) == expected
        and duplicate_count == 0
        and gaps == 0
        and first_ok
        and last_ok
    )

    return {
        "rows": ordered,
        "count": len(ordered),
        "expected": expected,
        "coveragePct": round((len(ordered) / expected * 100) if expected else 0, 6),
        "duplicates": duplicate_count,
        "nonFiveMinuteGaps": gaps,
        "maxGapMinutes": round(max_gap_ms / 60_000, 3) if max_gap_ms else 0,
        "firstTimestampExact": first_ok,
        "lastTimestampExact": last_ok,
        "exactPass": exact,
    }


CSV_HEADER = [
    "openTimeMs",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "closeTimeMs",
    "quoteVolume",
    "trades",
    "takerBuyBaseVolume",
    "takerBuyQuoteVolume",
    "ignore",
]


def canonical_csv_bytes(rows: list[dict[str, Any]]) -> bytes:
    sio = io.StringIO(newline="")
    writer = csv.DictWriter(
        sio,
        fieldnames=CSV_HEADER,
        lineterminator="\n",
        extrasaction="ignore",
    )
    writer.writeheader()
    writer.writerows(rows)
    return sio.getvalue().encode("utf-8")


def deterministic_gzip(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(
        fileobj=buf,
        mode="wb",
        compresslevel=9,
        mtime=0,
    ) as gz:
        gz.write(data)
    return buf.getvalue()


def build_symbol(
    symbol: str,
    start_day: datetime,
    end_day: datetime,
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    print(f"\n========== BUILD {symbol} ==========")
    plan = plan_archives(symbol, start_day, end_day)

    all_rows: list[dict[str, Any]] = []
    source_files: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=max(1, ARCHIVE_WORKERS)) as pool:
        futures = {
            pool.submit(fetch_plan_item, item): item
            for item in plan
        }

        for future in as_completed(futures):
            item = futures[future]
            try:
                rows, metas = future.result()
            except Exception as exc:
                raise RuntimeError(
                    f"{symbol} source fetch failed for {item['url']}: {exc}"
                ) from exc

            all_rows.extend(rows)
            source_files.extend(metas)

    integrity = exact_integrity(all_rows, start_ms, end_ms)

    print(
        f"[INTEGRITY] {symbol} rows={integrity['count']}/"
        f"{integrity['expected']} coverage={integrity['coveragePct']}% "
        f"dupes={integrity['duplicates']} "
        f"gaps={integrity['nonFiveMinuteGaps']} "
        f"maxGap={integrity['maxGapMinutes']}m "
        f"exact={integrity['exactPass']}"
    )

    if not integrity["exactPass"]:
        raise RuntimeError(
            f"{symbol} frozen dataset integrity failed: {integrity}"
        )

    canonical = canonical_csv_bytes(integrity["rows"])
    canonical_sha = sha256_bytes(canonical)
    gz_bytes = deterministic_gzip(canonical)
    gz_sha = sha256_bytes(gz_bytes)

    outfile = DATADIR / f"{symbol.replace('-', '_')}_5m.csv.gz"
    outfile.write_bytes(gz_bytes)

    source_files.sort(
        key=lambda x: (
            x.get("month", ""),
            x.get("day", ""),
            x.get("url", ""),
        )
    )

    volume_proxy_validated = symbol not in {"DOGE-USDT"}

    return {
        "symbol": symbol,
        "file": str(outfile.as_posix()),
        "format": "gzip_csv_utf8",
        "columns": CSV_HEADER,
        "rows": integrity["count"],
        "expectedRows": integrity["expected"],
        "coveragePct": integrity["coveragePct"],
        "duplicates": integrity["duplicates"],
        "nonFiveMinuteGaps": integrity["nonFiveMinuteGaps"],
        "maxGapMinutes": integrity["maxGapMinutes"],
        "firstTimestampExact": integrity["firstTimestampExact"],
        "lastTimestampExact": integrity["lastTimestampExact"],
        "integrityPass": True,
        "canonicalCsvSha256": canonical_sha,
        "gzipSha256": gz_sha,
        "gzipBytes": len(gz_bytes),
        "sourceArchiveFiles": len(source_files),
        "sourceArchiveChecksumsVerified": sum(
            1 for x in source_files if x.get("checksumVerified")
        ),
        "priceStructureProxyValidated": True,
        "normalizedVolumeProxyValidated": volume_proxy_validated,
        "sourceFiles": source_files,
    }


def main() -> int:
    print("=" * 68)
    print("V4 CLEAN CORE — FROZEN DATASET BUILDER V1")
    print("READ ONLY — NO STRATEGY / NO PAPER / NO LIVE / NO ORDERS")
    print("=" * 68)

    OUTDIR.mkdir(parents=True, exist_ok=True)
    DATADIR.mkdir(parents=True, exist_ok=True)

    latest_day = latest_complete_archive_day()

    # 201 completed UTC days:
    # [100 warmup] [100 replay] [1 outcome tail]
    dataset_start_day = latest_day - timedelta(days=TOTAL_DAYS - 1)
    replay_start_day = dataset_start_day + timedelta(days=WARMUP_DAYS)
    replay_end_day = replay_start_day + timedelta(days=REPLAY_DAYS - 1)
    outcome_tail_start_day = replay_end_day + timedelta(days=1)

    dataset_start_ms = int(dataset_start_day.timestamp() * 1000)
    dataset_end_dt = latest_day.replace(
        hour=23, minute=55, second=0, microsecond=0
    )
    dataset_end_ms = int(dataset_end_dt.timestamp() * 1000)

    expected_rows = TOTAL_DAYS * BARS_PER_DAY

    print(f"Latest complete archive day : {latest_day.date()}")
    print(f"Dataset start               : {dataset_start_day.date()}")
    print(f"Warmup                      : {WARMUP_DAYS} days")
    print(f"Replay window               : {replay_start_day.date()} -> {replay_end_day.date()} ({REPLAY_DAYS} days)")
    print(f"Outcome tail                : {outcome_tail_start_day.date()} -> {latest_day.date()} ({OUTCOME_TAIL_DAYS} day)")
    print(f"Expected rows / symbol      : {expected_rows}")

    symbol_results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for symbol in SYMBOLS:
        try:
            result = build_symbol(
                symbol,
                dataset_start_day,
                latest_day,
                dataset_start_ms,
                dataset_end_ms,
            )
            symbol_results.append(result)
        except Exception as exc:
            print(f"[FAILED] {symbol}: {exc}")
            errors.append({"symbol": symbol, "error": str(exc)})

    all_pass = (
        len(symbol_results) == len(SYMBOLS)
        and not errors
        and all(x["integrityPass"] for x in symbol_results)
    )

    # Build a dataset content root hash from immutable per-symbol canonical hashes.
    hash_material = "\n".join(
        f"{x['symbol']}:{x['canonicalCsvSha256']}"
        for x in sorted(symbol_results, key=lambda y: y["symbol"])
    ).encode("utf-8")
    root_hash = sha256_bytes(hash_material) if symbol_results else None

    dataset_id = (
        f"V4_CORE6_BINANCE_UM_5M_"
        f"{dataset_start_day.strftime('%Y%m%d')}_"
        f"{latest_day.strftime('%Y%m%d')}_"
        f"{root_hash[:12].upper() if root_hash else 'FAILED'}"
    )

    manifest = {
        "version": VERSION,
        "datasetId": dataset_id,
        "createdAt": iso_z(datetime.now(timezone.utc)),
        "status": "FROZEN_EXACT_PASS" if all_pass else "BUILD_FAILED",
        "mode": "HISTORICAL_DATA_BUILD_ONLY",
        "safety": {
            "strategyModulesImported": False,
            "scannerEnabled": False,
            "paperOrdersEnabled": False,
            "realOrdersEnabled": False,
            "orderEndpointsUsed": False,
        },
        "source": {
            "provider": SOURCE,
            "market": "USD-M Futures",
            "archiveHost": "data.binance.vision",
            "interval": INTERVAL,
            "officialChecksumVerification": "SHA256_REQUIRED_AND_VERIFIED",
        },
        "layout": {
            "totalDays": TOTAL_DAYS,
            "warmupDays": WARMUP_DAYS,
            "replayDays": REPLAY_DAYS,
            "outcomeTailDays": OUTCOME_TAIL_DAYS,
            "datasetStart": iso_z(dataset_start_day),
            "replayStart": iso_z(replay_start_day),
            "replayEnd": iso_z(
                replay_end_day.replace(hour=23, minute=55)
            ),
            "outcomeTailStart": iso_z(outcome_tail_start_day),
            "datasetEnd": iso_z(dataset_end_dt),
            "expectedRowsPerSymbol": expected_rows,
        },
        "symbols": SYMBOLS,
        "rootContentSha256": root_hash,
        "crossExchangeValidation": CROSS_VALIDATION,
        "moduleCoverage": {
            "RADAR_price_momentum_compression": "SUPPORTED_BY_PROXY",
            "RADAR_volume": "PROXY_ONLY_DOGE_NOT_VALIDATED",
            "DIRECTION_htf_price_structure": "SUPPORTED_BY_PROXY",
            "STRUCTURE_price_patterns": "SUPPORTED_BY_PROXY",
            "EXECUTION_price_geometry": "SUPPORTED_BY_PROXY",
            "FLOW_BingX_CVD": "NOT_INCLUDED",
            "FLOW_BingX_OI": "NOT_INCLUDED",
            "FLOW_BingX_funding": "NOT_INCLUDED",
            "FLOW_BingX_liquidations": "NOT_INCLUDED",
            "CATALYST_news": "NOT_INCLUDED",
        },
        "rules": [
            "Dataset bytes are frozen after build; strategy tuning must not mutate them.",
            "Do not treat Binance absolute volume as BingX venue-native volume.",
            "DOGE normalized volume proxy is not validated by the prior 30d overlap test.",
            "The outcome-tail day is for post-entry outcome resolution only and must never be visible to signal generation before its timestamp.",
            "PAPER and LIVE trading remain disabled.",
        ],
        "files": symbol_results,
        "errors": errors,
    }

    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    build_summary = {
        "version": VERSION,
        "datasetId": dataset_id,
        "status": manifest["status"],
        "symbolsRequested": len(SYMBOLS),
        "symbolsBuilt": len(symbol_results),
        "integrityPassCount": sum(
            1 for x in symbol_results if x.get("integrityPass")
        ),
        "expectedRowsPerSymbol": expected_rows,
        "rootContentSha256": root_hash,
        "errors": errors,
        "nextAction": (
            "ADAPT_REPLAY_HARNESS_TO_FROZEN_DATASET"
            if all_pass
            else "FIX_DATASET_BUILD_BEFORE_REPLAY"
        ),
    }

    SUMMARY_PATH.write_text(
        json.dumps(build_summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\n" + "=" * 68)
    print("V4 FROZEN DATASET BUILD COMPLETE")
    print(json.dumps(build_summary, indent=2, ensure_ascii=False))
    print("=" * 68)

    return 0 if all_pass else 2


if __name__ == "__main__":
    sys.exit(main())
