"""FastAPI server for the GBP/USD ICT & Technicals AI Daily Bias Dashboard."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine.bias_ai import compute_daily_bias, generate_llm_brief
from engine.data_fetcher import ALLOWED_PAIRS, fetch_multi_timeframe_data
from engine.ict_concepts import (
    analyze_dealing_range_and_sessions,
    analyze_previous_day_and_week,
    detect_fvgs_o_n,
)
from engine.technicals import analyze_technicals, compute_ema

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

ALLOWED_TIMEFRAMES = ("1d", "4h", "1h", "15m")

app = FastAPI(
    title="ICT & Technicals AI Daily Bias Analyzer",
    version="1.0.0",
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class AiBriefRequest(BaseModel):
    pair: str = Field(default="GBPUSD", max_length=20)
    provider: str = Field(default="ollama", max_length=20)
    api_key: str | None = Field(default=None, max_length=300)
    model: str | None = Field(default=None, max_length=120)


def _build_chart_data(
    df: Any,
    decimals: int,
    max_bars: int = 180,
) -> dict[str, Any]:
    """Serialize OHLC candles and EMA 20/50/200 series for TradingView Lightweight Charts."""
    if df is None or df.empty:
        return {"candles": [], "ema_20": [], "ema_50": [], "ema_200": []}

    close = df["Close"]
    ema20 = compute_ema(close, 20)
    ema50 = compute_ema(close, 50)
    ema200 = compute_ema(close, 200)

    sliced = df.tail(max_bars)
    candles = []
    ema20_pts = []
    ema50_pts = []
    ema200_pts = []

    for ts, row in sliced.iterrows():
        unix_ts = int(ts.timestamp())
        candles.append(
            {
                "time": unix_ts,
                "open": round(float(row["Open"]), decimals),
                "high": round(float(row["High"]), decimals),
                "low": round(float(row["Low"]), decimals),
                "close": round(float(row["Close"]), decimals),
            }
        )
        ema20_pts.append({"time": unix_ts, "value": round(float(ema20.loc[ts]), decimals)})
        ema50_pts.append({"time": unix_ts, "value": round(float(ema50.loc[ts]), decimals)})
        ema200_pts.append({"time": unix_ts, "value": round(float(ema200.loc[ts]), decimals)})

    return {
        "candles": candles,
        "ema_20": ema20_pts,
        "ema_50": ema50_pts,
        "ema_200": ema200_pts,
    }


def run_full_analysis(pair: str = "GBPUSD", timeframe: str = "1h", force_refresh: bool = False) -> dict[str, Any]:
    """Execute complete ICT + Technical + Confluence Daily Bias analysis."""
    tf = timeframe.strip().lower()
    if tf not in ALLOWED_TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe '{timeframe}'. Allowed: {', '.join(ALLOWED_TIMEFRAMES)}")

    market = fetch_multi_timeframe_data(pair=pair, force_refresh=force_refresh)
    pair_info = market["pair_info"]
    pip_size = pair_info["pip_size"]
    decimals = pair_info["decimals"]
    current_price = market["current_price"]
    frames = market["frames"]

    # ICT FVG detection across all 4 timeframes using O(N) algorithm
    fvgs = {
        "1d": detect_fvgs_o_n(frames["1d"], pip_size, "1D", min_pips=3.0, decimals=decimals),
        "4h": detect_fvgs_o_n(frames["4h"], pip_size, "4H", min_pips=2.0, decimals=decimals),
        "1h": detect_fvgs_o_n(frames["1h"], pip_size, "1H", min_pips=1.5, decimals=decimals),
        "15m": detect_fvgs_o_n(frames["15m"], pip_size, "15m", min_pips=1.0, decimals=decimals),
    }

    previous_day = analyze_previous_day_and_week(
        frames["1d"], frames["15m"], current_price, pip_size, decimals=decimals
    )
    dr_sessions = analyze_dealing_range_and_sessions(
        frames["1d"], frames["15m"], current_price, pip_size, decimals=decimals
    )

    ict_data = {
        "previous_day": previous_day,
        "dealing_range": dr_sessions["dealing_range"],
        "sessions": dr_sessions["sessions"],
        "fvgs": fvgs,
    }

    technicals = {
        "1d": analyze_technicals(frames["1d"], pip_size, "1D", decimals=decimals),
        "4h": analyze_technicals(frames["4h"], pip_size, "4H", decimals=decimals),
        "1h": analyze_technicals(frames["1h"], pip_size, "1H", decimals=decimals),
        "15m": analyze_technicals(frames["15m"], pip_size, "15m", decimals=decimals),
    }

    bias_summary = compute_daily_bias(ict_data, technicals, pair_info, current_price)
    chart_data = _build_chart_data(frames[tf], decimals=decimals)

    return {
        "pair_info": pair_info,
        "selected_timeframe": tf,
        "current_price": round(current_price, decimals),
        "last_updated_ny": market["last_updated_ny"],
        "data_source": market["data_source"],
        "available_pairs": [{"symbol": k, "name": v["name"]} for k, v in ALLOWED_PAIRS.items()],
        "bias_summary": bias_summary,
        "ict": ict_data,
        "technicals": technicals,
        "chart_data": chart_data,
    }


@app.get("/")
async def serve_dashboard() -> FileResponse:
    """Serve the dashboard HTML from root index.html (falling back to static/index.html)."""
    root_index = BASE_DIR / "index.html"
    if root_index.exists():
        return FileResponse(str(root_index))
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    """Return empty 204 for browser favicon requests to prevent 404 log noise."""
    return Response(status_code=204)


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    """Return service health status."""
    return {"status": "ok", "default_pair": "GBPUSD"}


@app.get("/api/analyze")
async def analyze_pair(
    pair: str = Query(default="GBPUSD", max_length=20),
    timeframe: str = Query(default="1h", max_length=10),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Analyze a forex pair across 1D/4H/1H/15m for ICT & Technical Daily Bias."""
    try:
        return run_full_analysis(pair=pair, timeframe=timeframe, force_refresh=force_refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Market data analysis failed: {exc}") from exc


@app.post("/api/ai-brief")
async def create_ai_brief(req: AiBriefRequest) -> dict[str, Any]:
    """Generate an optional free/local LLM pre-session brief using exact computed metrics."""
    try:
        analysis = run_full_analysis(pair=req.pair, timeframe="1h", force_refresh=False)
        return await generate_llm_brief(
            analysis_payload=analysis,
            provider=req.provider,
            api_key=req.api_key,
            model=req.model,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"LLM provider returned HTTP {exc.response.status_code}: {exc.response.text[:250]}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not connect to LLM provider ({req.provider}): {exc}",
        ) from exc


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
