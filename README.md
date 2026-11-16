# GBP/USD ICT & Technicals AI Daily Bias Dashboard

A dual-mode (**24/7 GitHub Pages static web app** + **local FastAPI server**) dashboard that analyzes **GBP/USD** (and other major pairs) across **1D, 4H, 1H, and 15m** timeframes in `America/New_York` time to determine the **Daily Bias** using ICT concepts and standard technical indicators.

## Architecture (Dual-Mode)

- **GitHub Pages / Static Mode (`index.html` + `static/client_engine.js`)**: Runs 100% client-side in your browser 24/7 with zero backend sleep, pulling live FX OHLC candles via CORS directly from Kraken's public REST API and caching in `localStorage`.
- **Local FastAPI Mode (`main.py` + `engine/`)**: Runs locally with a 3-tier fetcher (in-memory + `.cache/<SYMBOL>.json`, Kraken primary, Yahoo Finance failover) and server-side LLM proxy.

## Folder Structure

```text
gbpusd-daily-bias/
├── index.html                   # GitHub Pages / root dashboard HTML (relative asset paths)
├── .nojekyll                    # Ensures GitHub Pages serves all static files directly
├── main.py                      # FastAPI server & REST endpoints (/api/analyze, /api/ai-brief)
├── requirements.txt             # Pinned Python 3.12 dependencies
├── engine/
│   ├── data_fetcher.py          # Multi-timeframe Kraken/Yahoo OHLC fetcher + disk cache
│   ├── ict_concepts.py          # O(N) FVG detector + mitigation tracker, PDH/PDL sweeps, Dealing Range, NY sessions
│   ├── technicals.py            # Vectorized EMA (20/50/200), Wilder RSI (14), MACD (12,26,9), ATR/ADR, Swing Structure
│   └── bias_ai.py               # 8-factor weighted confluence scoring + optional free/local LLM brief generator
├── static/
│   ├── index.html               # Mirror of root HTML
│   ├── styles.css               # Dark terminal theme
│   ├── client_engine.js         # Browser-native port of the full ICT + Technicals + Confluence engine
│   └── app.js                   # Lightweight Charts rendering & automatic API / static fallback
└── tests/
    ├── test_analyzer.py         # Pytest unit & live integration tests
    └── test_client_engine.mjs   # Node.js verification for static/client_engine.js
```

## Running Locally (Windows PowerShell)

> Note: On Windows systems where `python` opens the Microsoft Store alias, use `py` (the Python Launcher).

```powershell
cd C:\Users\Jacob\.gemini\antigravity\scratch\gbpusd-daily-bias
py -m pip install -r requirements.txt
py main.py
```

Then open `http://127.0.0.1:8000` in your browser.

## Running Tests

```powershell
py -m pytest tests/test_analyzer.py -v
node tests/test_client_engine.mjs
```
