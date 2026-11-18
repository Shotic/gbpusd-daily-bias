"""Multi-timeframe OHLC data fetcher with persistent disk cache and Kraken/Yahoo failover."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
import pytz
import yfinance as yf

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

NY_TZ = pytz.timezone("America/New_York")
CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

ALLOWED_PAIRS: dict[str, dict[str, Any]] = {
    "GBPUSD": {
        "symbol": "GBPUSD",
        "ticker": "GBPUSD=X",
        "kraken_pair": "GBPUSD",
        "name": "GBP/USD",
        "pip_size": 0.0001,
        "decimals": 5,
    },
    "GBPJPY": {
        "symbol": "GBPJPY",
        "ticker": "GBPJPY=X",
        "kraken_pair": "GBPJPY_CROSS",
        "name": "GBP/JPY",
        "pip_size": 0.01,
        "decimals": 3,
    },
    "EURUSD": {
        "symbol": "EURUSD",
        "ticker": "EURUSD=X",
        "kraken_pair": "EURUSD",
        "name": "EUR/USD",
        "pip_size": 0.0001,
        "decimals": 5,
    },
    "USDJPY": {
        "symbol": "USDJPY",
        "ticker": "USDJPY=X",
        "kraken_pair": "USDJPY",
        "name": "USD/JPY",
        "pip_size": 0.01,
        "decimals": 3,
    },
    "AUDUSD": {
        "symbol": "AUDUSD",
        "ticker": "AUDUSD=X",
        "kraken_pair": "AUDUSD",
        "name": "AUD/USD",
        "pip_size": 0.0001,
        "decimals": 5,
    },
    "USDCAD": {
        "symbol": "USDCAD",
        "ticker": "USDCAD=X",
        "kraken_pair": "USDCAD",
        "name": "USD/CAD",
        "pip_size": 0.0001,
        "decimals": 5,
    },
    "XAUUSD": {
        "symbol": "XAUUSD",
        "ticker": "GC=F",
        "kraken_pair": "PAXGUSD",
        "name": "XAU/USD (Gold)",
        "pip_size": 0.1,
        "decimals": 2,
    },
}

_CACHE_TTL_SECONDS = 180.0
_DATA_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def validate_pair(pair: str) -> dict[str, Any]:
    """Normalize and validate pair symbol against the allowed whitelist."""
    if not isinstance(pair, str):
        raise ValueError("Pair symbol must be a string.")
    cleaned = pair.strip().upper().replace("/", "").replace("-", "").replace(" ", "")
    if cleaned not in ALLOWED_PAIRS:
        allowed = ", ".join(ALLOWED_PAIRS.keys())
        raise ValueError(f"Unsupported pair '{pair}'. Allowed pairs: {allowed}")
    return dict(ALLOWED_PAIRS[cleaned])


def _normalize_ohlc(df: pd.DataFrame) -> pd.DataFrame:
    """Flatten MultiIndex columns, drop invalid rows, and convert index to NY timezone."""
    if df is None or df.empty:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close"])

    cleaned = df.copy()
    if isinstance(cleaned.columns, pd.MultiIndex):
        cleaned.columns = [col[0] for col in cleaned.columns]

    required = ["Open", "High", "Low", "Close"]
    missing = [col for col in required if col not in cleaned.columns]
    if missing:
        raise ValueError(f"Downloaded OHLC data missing required columns: {missing}")

    cleaned = cleaned[required].copy()
    for col in required:
        cleaned[col] = pd.to_numeric(cleaned[col], errors="coerce")

    cleaned = cleaned.dropna(subset=required)
    cleaned = cleaned[~cleaned.index.duplicated(keep="last")].sort_index()

    if cleaned.empty:
        return cleaned

    if cleaned.index.tz is None:
        cleaned.index = cleaned.index.tz_localize("UTC").tz_convert(NY_TZ)
    else:
        cleaned.index = cleaned.index.tz_convert(NY_TZ)

    return cleaned


def _resample_4h(df_1h: pd.DataFrame) -> pd.DataFrame:
    """Resample 1H OHLC data into 4H candles anchored in America/New_York time."""
    if df_1h.empty:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close"])

    return (
        df_1h.resample("4h", label="left", closed="left")
        .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last"})
        .dropna(subset=["Open", "High", "Low", "Close"])
    )


def _download_kraken_tf(client: httpx.Client, kraken_pair: str, interval_min: int, limit: int) -> pd.DataFrame:
    """Fetch OHLC candles from Kraken public REST API and normalize to NY time."""
    if kraken_pair == "GBPJPY_CROSS":
        df_gbp = _download_kraken_tf(client, "GBPUSD", interval_min, limit)
        df_jpy = _download_kraken_tf(client, "USDJPY", interval_min, limit)
        common_idx = df_gbp.index.intersection(df_jpy.index)
        if common_idx.empty:
            return pd.DataFrame(columns=["Open", "High", "Low", "Close"])
        return pd.DataFrame(
            {
                "Open": df_gbp.loc[common_idx, "Open"] * df_jpy.loc[common_idx, "Open"],
                "High": df_gbp.loc[common_idx, "High"] * df_jpy.loc[common_idx, "High"],
                "Low": df_gbp.loc[common_idx, "Low"] * df_jpy.loc[common_idx, "Low"],
                "Close": df_gbp.loc[common_idx, "Close"] * df_jpy.loc[common_idx, "Close"],
            },
            index=common_idx,
        ).sort_index()

    resp = client.get(
        "https://api.kraken.com/0/public/OHLC",
        params={"pair": kraken_pair, "interval": interval_min},
    )
    resp.raise_for_status()
    body = resp.json()
    errors = body.get("error") or []
    if errors:
        raise RuntimeError(f"Kraken API error for {kraken_pair}: {errors}")

    result = body.get("result") or {}
    data_keys = [k for k in result.keys() if k != "last"]
    if not data_keys:
        raise RuntimeError(f"Kraken API returned no OHLC key for {kraken_pair}")

    rows = result[data_keys[0]]
    if not rows:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close"])

    rows = rows[-limit:]
    records = [
        {
            "timestamp": int(r[0]),
            "Open": float(r[1]),
            "High": float(r[2]),
            "Low": float(r[3]),
            "Close": float(r[4]),
        }
        for r in rows
    ]
    df = pd.DataFrame(records)
    idx = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(NY_TZ)
    df = df.drop(columns=["timestamp"])
    df.index = idx
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def _fetch_from_kraken(pair_info: dict[str, Any]) -> dict[str, pd.DataFrame]:
    """Fetch native 1D, 4H, 1H, and 15m frames from Kraken public OHLC API."""
    kraken_pair = pair_info["kraken_pair"]
    with httpx.Client(timeout=12.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
        df_1d = _download_kraken_tf(client, kraken_pair, interval_min=1440, limit=180)
        df_4h = _download_kraken_tf(client, kraken_pair, interval_min=240, limit=180)
        df_1h = _download_kraken_tf(client, kraken_pair, interval_min=60, limit=360)
        df_15m = _download_kraken_tf(client, kraken_pair, interval_min=15, limit=360)

    if df_1d.empty or df_1h.empty:
        raise RuntimeError(f"Kraken returned empty OHLC frames for {kraken_pair}.")

    return {"1d": df_1d, "4h": df_4h, "1h": df_1h, "15m": df_15m}


def _download_yfinance_tf(ticker: str, period: str, interval: str) -> pd.DataFrame:
    """Download a single timeframe from yfinance without progress noise."""
    raw = yf.download(
        ticker,
        period=period,
        interval=interval,
        progress=False,
        auto_adjust=False,
        threads=False,
    )
    return _normalize_ohlc(raw)


def _fetch_from_yfinance(pair_info: dict[str, Any]) -> dict[str, pd.DataFrame]:
    """Secondary fallback via Yahoo Finance."""
    ticker = pair_info["ticker"]
    df_1d = _download_yfinance_tf(ticker, period="6mo", interval="1d")
    df_1h = _download_yfinance_tf(ticker, period="1mo", interval="1h")
    df_15m = _download_yfinance_tf(ticker, period="5d", interval="15m")

    if df_1d.empty or df_1h.empty:
        raise RuntimeError(f"Yahoo Finance returned empty data for {ticker}.")

    df_4h = _resample_4h(df_1h)
    return {"1d": df_1d, "4h": df_4h, "1h": df_1h, "15m": df_15m}


def _build_payload(
    pair_info: dict[str, Any],
    frames: dict[str, pd.DataFrame],
    data_source: str,
) -> dict[str, Any]:
    """Construct the standardized multi-timeframe market payload."""
    latest_df = frames["15m"] if not frames["15m"].empty else frames["1h"]
    current_price = float(latest_df["Close"].iloc[-1])
    last_updated_ny = latest_df.index[-1].strftime("%Y-%m-%d %H:%M %Z")
    return {
        "pair_info": pair_info,
        "current_price": current_price,
        "last_updated_ny": last_updated_ny,
        "data_source": data_source,
        "frames": frames,
    }


def _save_disk_cache(symbol: str, payload: dict[str, Any]) -> None:
    """Persist fetched OHLC frames to .cache/<SYMBOL>.json."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{symbol}.json"
    serialized_frames: dict[str, list[dict[str, Any]]] = {}
    for tf, df in payload["frames"].items():
        records = []
        for ts, row in df.iterrows():
            records.append(
                {
                    "t": int(ts.timestamp()),
                    "o": float(row["Open"]),
                    "h": float(row["High"]),
                    "l": float(row["Low"]),
                    "c": float(row["Close"]),
                }
            )
        serialized_frames[tf] = records

    blob = {
        "cached_at": time.time(),
        "data_source": payload["data_source"],
        "frames": serialized_frames,
    }
    cache_path.write_text(json.dumps(blob), encoding="utf-8")


def _load_disk_cache(
    symbol: str,
    pair_info: dict[str, Any],
    max_age_seconds: float | None,
) -> tuple[float, dict[str, Any]] | None:
    """Load cached OHLC frames from .cache/<SYMBOL>.json if present and within max_age."""
    cache_path = CACHE_DIR / f"{symbol}.json"
    if not cache_path.exists():
        return None

    try:
        blob = json.loads(cache_path.read_text(encoding="utf-8"))
        cached_at = float(blob["cached_at"])
        if max_age_seconds is not None and (time.time() - cached_at) >= max_age_seconds:
            return None

        frames: dict[str, pd.DataFrame] = {}
        for tf, records in blob["frames"].items():
            if not records:
                frames[tf] = pd.DataFrame(columns=["Open", "High", "Low", "Close"])
                continue
            df = pd.DataFrame(records).rename(
                columns={"o": "Open", "h": "High", "l": "Low", "c": "Close"}
            )
            idx = pd.to_datetime(df["t"], unit="s", utc=True).dt.tz_convert(NY_TZ)
            df = df.drop(columns=["t"])
            df.index = idx
            frames[tf] = df

        source = blob.get("data_source", "Local Disk Cache")
        if max_age_seconds is None:
            source = f"{source} (Stale Disk Cache Fallback)"
        return cached_at, _build_payload(pair_info, frames, data_source=source)
    except Exception:
        return None


def fetch_multi_timeframe_data(pair: str = "GBPUSD", force_refresh: bool = False) -> dict[str, Any]:
    """Fetch 1D, 4H, 1H, and 15m OHLC DataFrames with memory/disk cache and Kraken/Yahoo failover."""
    pair_info = validate_pair(pair)
    symbol = pair_info["symbol"]
    now = time.time()

    # Tier 1: In-memory cache & fresh disk cache (180s TTL)
    if not force_refresh:
        if symbol in _DATA_CACHE:
            cached_ts, cached_payload = _DATA_CACHE[symbol]
            if now - cached_ts < _CACHE_TTL_SECONDS:
                return cached_payload

        disk_hit = _load_disk_cache(symbol, pair_info, max_age_seconds=_CACHE_TTL_SECONDS)
        if disk_hit is not None:
            cached_ts, disk_payload = disk_hit
            _DATA_CACHE[symbol] = (cached_ts, disk_payload)
            return disk_payload

    # Tier 2: Primary live provider (Kraken Public FX OHLC API)
    errors: list[str] = []
    try:
        frames = _fetch_from_kraken(pair_info)
        payload = _build_payload(pair_info, frames, data_source="Kraken FX Live")
        _DATA_CACHE[symbol] = (now, payload)
        _save_disk_cache(symbol, payload)
        return payload
    except Exception as exc:
        errors.append(f"Kraken: {exc}")

    # Tier 3a: Secondary live failover (Yahoo Finance)
    try:
        frames = _fetch_from_yfinance(pair_info)
        payload = _build_payload(pair_info, frames, data_source="Yahoo Finance Live")
        _DATA_CACHE[symbol] = (now, payload)
        _save_disk_cache(symbol, payload)
        return payload
    except Exception as exc:
        errors.append(f"Yahoo Finance: {exc}")

    # Tier 3b: Stale disk cache fallback so rate-limits/offline outages don't 502 if snapshot exists
    stale_hit = _load_disk_cache(symbol, pair_info, max_age_seconds=None)
    if stale_hit is not None:
        _, stale_payload = stale_hit
        _DATA_CACHE[symbol] = (now, stale_payload)
        return stale_payload

    raise RuntimeError("Failed to fetch live market data (" + "; ".join(errors) + ").")
