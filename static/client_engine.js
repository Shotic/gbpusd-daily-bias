/**
 * Standalone Client-Side ICT & Technicals Daily Bias Engine.
 * Mirrors engine/data_fetcher.py, engine/ict_concepts.py, engine/technicals.py,
 * and engine/bias_ai.py so the dashboard runs 24/7 on static hosts like GitHub Pages.
 */
(function (root) {
    "use strict";

    const ALLOWED_PAIRS = {
        GBPUSD: { symbol: "GBPUSD", kraken_pair: "GBPUSD", name: "GBP/USD", pip_size: 0.0001, decimals: 5 },
        EURUSD: { symbol: "EURUSD", kraken_pair: "EURUSD", name: "EUR/USD", pip_size: 0.0001, decimals: 5 },
        USDJPY: { symbol: "USDJPY", kraken_pair: "USDJPY", name: "USD/JPY", pip_size: 0.01, decimals: 3 },
        AUDUSD: { symbol: "AUDUSD", kraken_pair: "AUDUSD", name: "AUD/USD", pip_size: 0.0001, decimals: 5 },
        USDCAD: { symbol: "USDCAD", kraken_pair: "USDCAD", name: "USD/CAD", pip_size: 0.0001, decimals: 5 },
        XAUUSD: { symbol: "XAUUSD", kraken_pair: "PAXGUSD", name: "XAU/USD (Gold)", pip_size: 0.1, decimals: 2 },
    };

    const ALLOWED_TIMEFRAMES = ["1d", "4h", "1h", "15m"];
    const CACHE_TTL_MS = 180 * 1000;
    const MEM_CACHE = new Map();

    const NY_FORMATTER = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
    });

    function roundTo(val, decimals) {
        if (val === null || val === undefined || Number.isNaN(val)) return null;
        const factor = 10 ** decimals;
        return Math.round(val * factor) / factor;
    }

    function clip(val, minVal, maxVal) {
        return Math.max(minVal, Math.min(maxVal, val));
    }

    function getNyParts(unixSec) {
        const parts = NY_FORMATTER.formatToParts(new Date(unixSec * 1000));
        const map = {};
        for (const p of parts) {
            if (p.type !== "literal") map[p.type] = p.value;
        }
        const hourNum = Number(map.hour) === 24 ? 0 : Number(map.hour);
        const minuteNum = Number(map.minute);
        const hourStr = String(hourNum).padStart(2, "0");
        const minStr = String(minuteNum).padStart(2, "0");
        const dateStr = `${map.year}-${map.month}-${map.day}`;
        return {
            dateStr,
            hour: hourNum,
            minute: minuteNum,
            minutesOfDay: hourNum * 60 + minuteNum,
            timestampStr: `${dateStr} ${hourStr}:${minStr}`,
            tzName: map.timeZoneName || "EST",
        };
    }

    function prevCalendarDate(dateStr) {
        const [y, m, d] = dateStr.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d) - 86400 * 1000);
        const yy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(dt.getUTCDate()).padStart(2, "0");
        return `${yy}-${mm}-${dd}`;
    }

    function validatePair(pair) {
        if (typeof pair !== "string") {
            throw new Error("Pair symbol must be a string.");
        }
        const cleaned = pair.trim().toUpperCase().replace(/[/- ]/g, "");
        if (!ALLOWED_PAIRS[cleaned]) {
            throw new Error(`Unsupported pair '${pair}'. Allowed pairs: ${Object.keys(ALLOWED_PAIRS).join(", ")}`);
        }
        return { ...ALLOWED_PAIRS[cleaned] };
    }

    async function fetchKrakenTf(krakenPair, intervalMin, limit) {
        const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(krakenPair)}&interval=${intervalMin}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Kraken HTTP ${resp.status}`);
        }
        const body = await resp.json();
        if (body.error && body.error.length > 0) {
            throw new Error(`Kraken error: ${body.error.join(", ")}`);
        }
        const result = body.result || {};
        const key = Object.keys(result).find((k) => k !== "last");
        if (!key || !Array.isArray(result[key])) {
            throw new Error(`Kraken returned no OHLC data for ${krakenPair}`);
        }

        const dedup = new Map();
        for (const r of result[key].slice(-limit)) {
            const t = Number(r[0]);
            const o = Number(r[1]);
            const h = Number(r[2]);
            const l = Number(r[3]);
            const c = Number(r[4]);
            if (Number.isFinite(t) && Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)) {
                dedup.set(t, { time: t, open: o, high: h, low: l, close: c });
            }
        }
        return Array.from(dedup.values()).sort((a, b) => a.time - b.time);
    }

    function readLocalStorage(symbol, allowStale) {
        try {
            if (typeof localStorage === "undefined") return null;
            const raw = localStorage.getItem(`ict_bias_cache_${symbol}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!allowStale && Date.now() - parsed.cachedAt >= CACHE_TTL_MS) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function writeLocalStorage(symbol, payload) {
        try {
            if (typeof localStorage === "undefined") return;
            localStorage.setItem(
                `ict_bias_cache_${symbol}`,
                JSON.stringify({ cachedAt: Date.now(), payload })
            );
        } catch {
            // Ignore storage quota errors in private browsing
        }
    }

    async function fetchMultiTimeframeData(pair = "GBPUSD", forceRefresh = false) {
        const pairInfo = validatePair(pair);
        const symbol = pairInfo.symbol;
        const now = Date.now();

        if (!forceRefresh) {
            const mem = MEM_CACHE.get(symbol);
            if (mem && now - mem.cachedAt < CACHE_TTL_MS) {
                return mem.payload;
            }
            const stored = readLocalStorage(symbol, false);
            if (stored && stored.payload) {
                MEM_CACHE.set(symbol, stored);
                return stored.payload;
            }
        }

        try {
            const [d1, h4, h1, m15] = await Promise.all([
                fetchKrakenTf(pairInfo.kraken_pair, 1440, 180),
                fetchKrakenTf(pairInfo.kraken_pair, 240, 180),
                fetchKrakenTf(pairInfo.kraken_pair, 60, 360),
                fetchKrakenTf(pairInfo.kraken_pair, 15, 360),
            ]);

            if (!d1.length || !h1.length) {
                throw new Error(`Empty OHLC data returned for ${pairInfo.name}`);
            }

            const latestSeries = m15.length ? m15 : h1;
            const latestBar = latestSeries[latestSeries.length - 1];
            const nyInfo = getNyParts(latestBar.time);

            const payload = {
                pair_info: pairInfo,
                current_price: latestBar.close,
                last_updated_ny: `${nyInfo.timestampStr} ${nyInfo.tzName}`,
                data_source: "Kraken FX Live (Browser)",
                frames: { "1d": d1, "4h": h4, "1h": h1, "15m": m15 },
            };

            MEM_CACHE.set(symbol, { cachedAt: now, payload });
            writeLocalStorage(symbol, payload);
            return payload;
        } catch (err) {
            const stale = readLocalStorage(symbol, true);
            if (stale && stale.payload) {
                const fallback = {
                    ...stale.payload,
                    data_source: `${stale.payload.data_source} (Stale Browser Cache)`,
                };
                MEM_CACHE.set(symbol, { cachedAt: now, payload: fallback });
                return fallback;
            }
            throw new Error(`Failed to fetch live FX data from Kraken (${err.message})`);
        }
    }

    /**
     * O(N) time & O(N) space Fair Value Gap detection + mitigation classification.
     */
    function detectFvgsON(candles, pipSize, timeframe, minPips = 1.5, decimals = 5, maxGaps = 8) {
        const empty = {
            timeframe,
            active_bullish_count: 0,
            active_bearish_count: 0,
            mitigated_count: 0,
            active_fvgs: [],
            nearest_bullish_fvg: null,
            nearest_bearish_fvg: null,
        };
        if (!Array.isArray(candles) || candles.length < 3 || pipSize <= 0) {
            return empty;
        }

        const n = candles.length;
        const currentPrice = candles[n - 1].close;
        const activeFvgs = [];
        let mitigatedCount = 0;

        let runningMinLow = candles[n - 1].low;
        let runningMaxHigh = candles[n - 1].high;

        for (let i = n - 2; i >= 2; i--) {
            const futureMinLow = runningMinLow;
            const futureMaxHigh = runningMaxHigh;

            const bullGap = candles[i].low - candles[i - 2].high;
            const bullPips = bullGap / pipSize;
            if (bullGap > 0 && bullPips >= minPips) {
                const top = candles[i].low;
                const bottom = candles[i - 2].high;
                const ce = (top + bottom) / 2.0;

                if (futureMinLow <= bottom) {
                    mitigatedCount += 1;
                } else {
                    let status = "Untapped (Fresh)";
                    if (futureMinLow <= ce) status = "Partially Mitigated (CE Tested)";
                    else if (futureMinLow < top) status = "Partially Tapped";

                    const distPips = (currentPrice - ce) / pipSize;
                    activeFvgs.push({
                        type: "Bullish",
                        timeframe,
                        timestamp: getNyParts(candles[i - 1].time).timestampStr,
                        unix_time: candles[i - 1].time,
                        top: roundTo(top, decimals),
                        ce: roundTo(ce, decimals),
                        bottom: roundTo(bottom, decimals),
                        size_pips: roundTo(bullPips, 1),
                        status,
                        distance_pips: roundTo(distPips, 1),
                        abs_distance_pips: roundTo(Math.abs(distPips), 1),
                    });
                }
            }

            const bearGap = candles[i - 2].low - candles[i].high;
            const bearPips = bearGap / pipSize;
            if (bearGap > 0 && bearPips >= minPips) {
                const top = candles[i - 2].low;
                const bottom = candles[i].high;
                const ce = (top + bottom) / 2.0;

                if (futureMaxHigh >= top) {
                    mitigatedCount += 1;
                } else {
                    let status = "Untapped (Fresh)";
                    if (futureMaxHigh >= ce) status = "Partially Mitigated (CE Tested)";
                    else if (futureMaxHigh > bottom) status = "Partially Tapped";

                    const distPips = (ce - currentPrice) / pipSize;
                    activeFvgs.push({
                        type: "Bearish",
                        timeframe,
                        timestamp: getNyParts(candles[i - 1].time).timestampStr,
                        unix_time: candles[i - 1].time,
                        top: roundTo(top, decimals),
                        ce: roundTo(ce, decimals),
                        bottom: roundTo(bottom, decimals),
                        size_pips: roundTo(bearPips, 1),
                        status,
                        distance_pips: roundTo(distPips, 1),
                        abs_distance_pips: roundTo(Math.abs(distPips), 1),
                    });
                }
            }

            if (candles[i].low < runningMinLow) runningMinLow = candles[i].low;
            if (candles[i].high > runningMaxHigh) runningMaxHigh = candles[i].high;
        }

        activeFvgs.sort((a, b) => a.abs_distance_pips - b.abs_distance_pips);
        const bullish = activeFvgs.filter((g) => g.type === "Bullish");
        const bearish = activeFvgs.filter((g) => g.type === "Bearish");

        return {
            timeframe,
            active_bullish_count: bullish.length,
            active_bearish_count: bearish.length,
            mitigated_count: mitigatedCount,
            active_fvgs: activeFvgs.slice(0, maxGaps),
            nearest_bullish_fvg: bullish[0] || null,
            nearest_bearish_fvg: bearish[0] || null,
        };
    }

    function analyzePreviousDayAndWeek(df1d, df15m, currentPrice, pipSize, decimals = 5) {
        if (!df1d || df1d.length < 2 || pipSize <= 0) {
            return {
                pdh: null, pdl: null, pdc: null, pwh: null, pwl: null,
                today_high: null, today_low: null, pdh_distance_pips: null,
                pdl_distance_pips: null, pdh_swept: false, pdl_swept: false,
                liquidity_state: "Insufficient Daily Data", bias_signal: 0.0,
            };
        }

        const prevDay = df1d[df1d.length - 2];
        const todayBar = df1d[df1d.length - 1];
        const pdh = prevDay.high;
        const pdl = prevDay.low;
        const pdc = prevDay.close;
        const prevDate = getNyParts(prevDay.time).dateStr;

        let todayHigh = todayBar.high;
        let todayLow = todayBar.low;
        if (df15m && df15m.length > 0) {
            const latestDate = getNyParts(df15m[df15m.length - 1].time).dateStr;
            for (const c of df15m) {
                if (getNyParts(c.time).dateStr === latestDate) {
                    if (c.high > todayHigh) todayHigh = c.high;
                    if (c.low < todayLow) todayLow = c.low;
                }
            }
        }

        const startIdx = Math.max(0, df1d.length - 6);
        const lookback = df1d.slice(startIdx, df1d.length - 1);
        const pwh = Math.max(...lookback.map((c) => c.high));
        const pwl = Math.min(...lookback.map((c) => c.low));

        const pdhSwept = todayHigh > pdh;
        const pdlSwept = todayLow < pdl;
        const pdhDistPips = (pdh - currentPrice) / pipSize;
        const pdlDistPips = (currentPrice - pdl) / pipSize;

        let state = "Inside Day (Mid-Range Equilibrium)";
        let signal = 0.0;

        if (pdhSwept && pdlSwept) {
            if (currentPrice < pdl) {
                state = "Outside Sweep -> Bearish Acceptance Below PDL";
                signal = -0.8;
            } else if (currentPrice > pdh) {
                state = "Outside Sweep -> Bullish Acceptance Above PDH";
                signal = 0.8;
            } else {
                state = "Double Liquidity Sweep (PDH & PDL Tapped - Indecisive)";
                signal = 0.0;
            }
        } else if (pdhSwept && currentPrice < pdh) {
            state = "PDH Sweep & Rejection (Bearish Turtle Soup)";
            signal = -0.85;
        } else if (pdhSwept && currentPrice >= pdh) {
            state = "PDH Breakout & Acceptance (Bullish Expansion)";
            signal = 0.75;
        } else if (pdlSwept && currentPrice > pdl) {
            state = "PDL Sweep & Rejection (Bullish Turtle Soup)";
            signal = 0.85;
        } else if (pdlSwept && currentPrice <= pdl) {
            state = "PDL Breakdown & Acceptance (Bearish Expansion)";
            signal = -0.75;
        } else if (pdhDistPips < pdlDistPips) {
            state = "Inside Day (Price Closer to PDH Buy-Side Liquidity)";
            signal = 0.15;
        } else if (pdlDistPips < pdhDistPips) {
            state = "Inside Day (Price Closer to PDL Sell-Side Liquidity)";
            signal = -0.15;
        }

        return {
            prev_date: prevDate,
            pdh: roundTo(pdh, decimals),
            pdl: roundTo(pdl, decimals),
            pdc: roundTo(pdc, decimals),
            pwh: roundTo(pwh, decimals),
            pwl: roundTo(pwl, decimals),
            today_high: roundTo(todayHigh, decimals),
            today_low: roundTo(todayLow, decimals),
            pdh_distance_pips: roundTo(pdhDistPips, 1),
            pdl_distance_pips: roundTo(pdlDistPips, 1),
            pdh_swept: pdhSwept,
            pdl_swept: pdlSwept,
            liquidity_state: state,
            bias_signal: roundTo(signal, 2),
        };
    }

    function analyzeDealingRangeAndSessions(df1d, df15m, currentPrice, pipSize, decimals = 5) {
        let dealingRange = {
            range_high: null,
            range_low: null,
            equilibrium_50: null,
            position_pct: 50.0,
            zone: "Equilibrium",
            ipda_5d_high: null,
            ipda_5d_low: null,
        };

        if (df1d && df1d.length > 0) {
            const w20 = df1d.slice(-20);
            const rHigh = Math.max(...w20.map((c) => c.high));
            const rLow = Math.min(...w20.map((c) => c.low));
            const eq = (rHigh + rLow) / 2.0;
            const span = rHigh - rLow;
            const posPct = clip(span > 0 ? ((currentPrice - rLow) / span) * 100.0 : 50.0, 0.0, 100.0);

            let zone = "Equilibrium";
            if (posPct >= 55.0) zone = "Premium";
            else if (posPct <= 45.0) zone = "Discount";

            const w5 = df1d.slice(-5);
            dealingRange = {
                range_high: roundTo(rHigh, decimals),
                range_low: roundTo(rLow, decimals),
                equilibrium_50: roundTo(eq, decimals),
                position_pct: roundTo(posPct, 1),
                zone,
                ipda_5d_high: roundTo(Math.max(...w5.map((c) => c.high)), decimals),
                ipda_5d_low: roundTo(Math.min(...w5.map((c) => c.low)), decimals),
            };
        }

        const sessions = {
            ny_midnight_open: null,
            price_vs_midnight: "Unavailable",
            midnight_diff_pips: null,
            asian_high: null,
            asian_low: null,
            asian_status: "Unavailable",
            london_high: null,
            london_low: null,
            london_status: "Unavailable",
        };

        if (df15m && df15m.length > 0 && pipSize > 0) {
            const decorated = df15m.map((c) => ({ c, ny: getNyParts(c.time) }));
            const latestDate = decorated[decorated.length - 1].ny.dateStr;
            const prevDate = prevCalendarDate(latestDate);

            const midnightBar = decorated.find((d) => d.ny.dateStr === latestDate && d.ny.minutesOfDay >= 0);
            if (midnightBar) {
                const mo = midnightBar.c.open;
                sessions.ny_midnight_open = roundTo(mo, decimals);
                sessions.midnight_diff_pips = roundTo((currentPrice - mo) / pipSize, 1);
                sessions.price_vs_midnight =
                    currentPrice >= mo
                        ? "Above Midnight Open (Bullish Expansion / Premium)"
                        : "Below Midnight Open (Bearish Expansion / Discount)";
            }

            const asianBars = decorated.filter(
                (d) =>
                    (d.ny.dateStr === prevDate && d.ny.minutesOfDay >= 20 * 60) ||
                    (d.ny.dateStr === latestDate && d.ny.minutesOfDay < 0)
            );
            if (asianBars.length > 0) {
                const aHigh = Math.max(...asianBars.map((d) => d.c.high));
                const aLow = Math.min(...asianBars.map((d) => d.c.low));
                const postAsian = decorated.filter((d) => d.ny.dateStr === latestDate && d.ny.minutesOfDay >= 0);
                const sweptHigh = postAsian.length > 0 && Math.max(...postAsian.map((d) => d.c.high)) > aHigh;
                const sweptLow = postAsian.length > 0 && Math.min(...postAsian.map((d) => d.c.low)) < aLow;

                let aStatus = "Asian Range Intact";
                if (sweptHigh && sweptLow) aStatus = "Both Asian High & Low Swept";
                else if (sweptHigh) aStatus = "Asian High (BSL) Swept";
                else if (sweptLow) aStatus = "Asian Low (SSL) Swept";

                sessions.asian_high = roundTo(aHigh, decimals);
                sessions.asian_low = roundTo(aLow, decimals);
                sessions.asian_status = aStatus;
            }

            const londonBars = decorated.filter(
                (d) => d.ny.dateStr === latestDate && d.ny.minutesOfDay >= 2 * 60 && d.ny.minutesOfDay < 5 * 60
            );
            if (londonBars.length > 0) {
                const lHigh = Math.max(...londonBars.map((d) => d.c.high));
                const lLow = Math.min(...londonBars.map((d) => d.c.low));
                sessions.london_high = roundTo(lHigh, decimals);
                sessions.london_low = roundTo(lLow, decimals);
                sessions.london_status = `Range ${roundTo((lHigh - lLow) / pipSize, 1)} pips`;
            }
        }

        return { dealing_range: dealingRange, sessions };
    }

    function computeEmaArray(values, span) {
        if (!values.length) return [];
        const alpha = 2.0 / (span + 1.0);
        const out = [values[0]];
        for (let i = 1; i < values.length; i++) {
            out.push(alpha * values[i] + (1.0 - alpha) * out[i - 1]);
        }
        return out;
    }

    function computeRsi(closes, period = 14) {
        if (!closes.length) return [];
        const alpha = 1.0 / period;
        let avgGain = 0;
        let avgLoss = 0;
        const rsi = [50.0];

        for (let i = 1; i < closes.length; i++) {
            const delta = closes[i] - closes[i - 1];
            const gain = delta > 0 ? delta : 0;
            const loss = delta < 0 ? -delta : 0;
            avgGain = alpha * gain + (1 - alpha) * avgGain;
            avgLoss = alpha * loss + (1 - alpha) * avgLoss;

            if (i < period - 1) {
                rsi.push(50.0);
            } else if (avgGain === 0 && avgLoss === 0) {
                rsi.push(50.0);
            } else if (avgLoss === 0) {
                rsi.push(100.0);
            } else {
                const rs = avgGain / avgLoss;
                rsi.push(100.0 - 100.0 / (1.0 + rs));
            }
        }
        return rsi;
    }

    function computeMacd(closes, fast = 12, slow = 26, signal = 9) {
        if (closes.length < 2) {
            return { macd: 0.0, signal: 0.0, histogram: 0.0, state: "Neutral" };
        }
        const emaFast = computeEmaArray(closes, fast);
        const emaSlow = computeEmaArray(closes, slow);
        const macdLine = emaFast.map((v, idx) => v - emaSlow[idx]);
        const signalLine = computeEmaArray(macdLine, signal);
        const hist = macdLine.map((v, idx) => v - signalLine[idx]);

        const currHist = hist[hist.length - 1];
        const prevHist = hist[hist.length - 2];

        let state = "Neutral";
        if (currHist > 0 && prevHist <= 0) state = "Bullish Crossover";
        else if (currHist < 0 && prevHist >= 0) state = "Bearish Crossover";
        else if (currHist > 0) state = "Bullish Momentum";
        else if (currHist < 0) state = "Bearish Momentum";

        return {
            macd: roundTo(macdLine[macdLine.length - 1], 6),
            signal: roundTo(signalLine[signalLine.length - 1], 6),
            histogram: roundTo(currHist, 6),
            state,
        };
    }

    function computeAtr(candles, period = 14, pipSize = 0.0001, decimals = 5) {
        if (!candles || !candles.length || pipSize <= 0) {
            return { atr: 0.0, atr_pips: 0.0, today_range_pips: 0.0, adr_consumed_pct: 0.0 };
        }
        const alpha = 1.0 / period;
        let atrVal = candles[0].high - candles[0].low;
        for (let i = 1; i < candles.length; i++) {
            const c = candles[i];
            const prevClose = candles[i - 1].close;
            const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
            atrVal = alpha * tr + (1 - alpha) * atrVal;
        }
        const atrPips = atrVal / pipSize;
        const last = candles[candles.length - 1];
        const todayRangePips = (last.high - last.low) / pipSize;
        const adrPct = atrPips > 0 ? (todayRangePips / atrPips) * 100.0 : 0.0;

        return {
            atr: roundTo(atrVal, decimals),
            atr_pips: roundTo(atrPips, 1),
            today_range_pips: roundTo(todayRangePips, 1),
            adr_consumed_pct: roundTo(adrPct, 1),
        };
    }

    function detectMarketStructure(candles, swingWindow = 3, decimals = 5) {
        const def = {
            trend: "RANGING / CONSOLIDATION",
            event: "Consolidating",
            last_swing_high: null,
            prev_swing_high: null,
            last_swing_low: null,
            prev_swing_low: null,
            signal: 0.0,
        };
        if (!candles || candles.length < swingWindow * 2 + 1) {
            return def;
        }
        const swingHighs = [];
        const swingLows = [];
        for (let i = swingWindow; i < candles.length - swingWindow; i++) {
            let maxH = -Infinity;
            let minL = Infinity;
            for (let j = i - swingWindow; j <= i + swingWindow; j++) {
                if (candles[j].high > maxH) maxH = candles[j].high;
                if (candles[j].low < minL) minL = candles[j].low;
            }
            if (candles[i].high === maxH) {
                if (!swingHighs.length || swingHighs[swingHighs.length - 1] !== candles[i].high) {
                    swingHighs.push(candles[i].high);
                }
            }
            if (candles[i].low === minL) {
                if (!swingLows.length || swingLows[swingLows.length - 1] !== candles[i].low) {
                    swingLows.push(candles[i].low);
                }
            }
        }

        if (swingHighs.length < 2 || swingLows.length < 2) {
            return def;
        }

        const lastSh = swingHighs[swingHighs.length - 1];
        const prevSh = swingHighs[swingHighs.length - 2];
        const lastSl = swingLows[swingLows.length - 1];
        const prevSl = swingLows[swingLows.length - 2];
        const currClose = candles[candles.length - 1].close;

        const hh = lastSh > prevSh;
        const hl = lastSl > prevSl;
        const lh = lastSh < prevSh;
        const ll = lastSl < prevSl;

        let event = "Trading Within Swing Structure";
        let bosBonus = 0.0;
        if (currClose > lastSh) {
            event = "Bullish BOS (Close Above Last Swing High)";
            bosBonus = 0.25;
        } else if (currClose < lastSl) {
            event = "Bearish BOS (Close Below Last Swing Low)";
            bosBonus = -0.25;
        }

        let trend = "RANGING / CONSOLIDATION";
        let base = 0.0;
        if (hh && hl) {
            trend = "BULLISH (HH/HL)";
            base = 0.75;
        } else if (lh && ll) {
            trend = "BEARISH (LH/LL)";
            base = -0.75;
        } else if (hh && ll) {
            trend = "EXPANSION / VOLATILE";
            base = currClose >= (lastSh + lastSl) / 2.0 ? 0.15 : -0.15;
        }

        return {
            trend,
            event,
            last_swing_high: roundTo(lastSh, decimals),
            prev_swing_high: roundTo(prevSh, decimals),
            last_swing_low: roundTo(lastSl, decimals),
            prev_swing_low: roundTo(prevSl, decimals),
            signal: roundTo(clip(base + bosBonus, -1.0, 1.0), 2),
        };
    }

    function analyzeTechnicals(candles, pipSize, timeframe, decimals = 5) {
        if (!candles || !candles.length) {
            return {
                timeframe,
                ema_20: null,
                ema_50: null,
                ema_200: null,
                ema_alignment: "Unavailable",
                ema_signal: 0.0,
                rsi_14: 50.0,
                rsi_state: "Neutral",
                macd: { macd: 0.0, signal: 0.0, histogram: 0.0, state: "Neutral" },
                atr: { atr: 0.0, atr_pips: 0.0, today_range_pips: 0.0, adr_consumed_pct: 0.0 },
                structure: detectMarketStructure(candles, 3, decimals),
                momentum_signal: 0.0,
            };
        }

        const closes = candles.map((c) => c.close);
        const currClose = closes[closes.length - 1];
        const ema20Arr = computeEmaArray(closes, 20);
        const ema50Arr = computeEmaArray(closes, 50);
        const ema200Arr = computeEmaArray(closes, 200);
        const ema20 = ema20Arr[ema20Arr.length - 1];
        const ema50 = ema50Arr[ema50Arr.length - 1];
        const ema200 = ema200Arr[ema200Arr.length - 1];

        let emaAlign = "Neutral / Flat";
        let emaSig = 0.0;
        if (currClose > ema20 && ema20 > ema50 && ema50 > ema200) {
            emaAlign = "Strong Bullish Stack (Price > 20 > 50 > 200)";
            emaSig = 1.0;
        } else if (currClose < ema20 && ema20 < ema50 && ema50 < ema200) {
            emaAlign = "Strong Bearish Stack (Price < 20 < 50 < 200)";
            emaSig = -1.0;
        } else if (currClose > ema50 && ema20 >= ema50) {
            emaAlign = "Bullish Trend (Price & 20 EMA > 50 EMA)";
            emaSig = 0.6;
        } else if (currClose < ema50 && ema20 <= ema50) {
            emaAlign = "Bearish Trend (Price & 20 EMA < 50 EMA)";
            emaSig = -0.6;
        } else if (currClose > ema200) {
            emaAlign = "Mixed Above 200 EMA";
            emaSig = 0.2;
        } else if (currClose < ema200) {
            emaAlign = "Mixed Below 200 EMA";
            emaSig = -0.2;
        }

        const rsiArr = computeRsi(closes, 14);
        const rsiVal = rsiArr[rsiArr.length - 1];
        let rsiState = "Neutral (45-55)";
        let rsiSig = 0.0;
        if (rsiVal >= 70.0) {
            rsiState = "Overbought (>=70)";
            rsiSig = 0.35;
        } else if (rsiVal >= 55.0) {
            rsiState = "Bullish Momentum (55-70)";
            rsiSig = 0.75;
        } else if (rsiVal <= 30.0) {
            rsiState = "Oversold (<=30)";
            rsiSig = -0.35;
        } else if (rsiVal <= 45.0) {
            rsiState = "Bearish Momentum (30-45)";
            rsiSig = -0.75;
        }

        const macdRes = computeMacd(closes);
        const macdSig = macdRes.histogram > 0 ? 0.75 : macdRes.histogram < 0 ? -0.75 : 0.0;
        const momentumSig = clip((rsiSig + macdSig) / 2.0, -1.0, 1.0);

        return {
            timeframe,
            ema_20: roundTo(ema20, decimals),
            ema_50: roundTo(ema50, decimals),
            ema_200: roundTo(ema200, decimals),
            ema_alignment: emaAlign,
            ema_signal: roundTo(emaSig, 2),
            rsi_14: roundTo(rsiVal, 1),
            rsi_state: rsiState,
            macd: macdRes,
            atr: computeAtr(candles, 14, pipSize, decimals),
            structure: detectMarketStructure(candles, 3, decimals),
            momentum_signal: roundTo(momentumSig, 2),
        };
    }

    function voteLabel(sig) {
        if (sig >= 0.2) return "Bullish";
        if (sig <= -0.2) return "Bearish";
        return "Neutral";
    }

    function computeDailyBias(ictData, techData, pairInfo, currentPrice) {
        const decimals = pairInfo.decimals || 5;
        const pipSize = pairInfo.pip_size || 0.0001;

        const t1d = techData["1d"];
        const t4h = techData["4h"];
        const t1h = techData["1h"];
        const pd = ictData.previous_day;
        const dr = ictData.dealing_range;
        const sessions = ictData.sessions;
        const fvg1d = ictData.fvgs["1d"];
        const fvg4h = ictData.fvgs["4h"];

        const factors = [];

        const s1d = t1d.structure;
        factors.push({
            factor: "1D Market Structure (HH/HL vs LH/LL)",
            weight: 20,
            signal: s1d.signal,
            vote: voteLabel(s1d.signal),
            reading: `${s1d.trend} — ${s1d.event}`,
        });

        const s4h = t4h.structure;
        const s1h = t1h.structure;
        const intradaySig = roundTo(0.65 * s4h.signal + 0.35 * s1h.signal, 2);
        factors.push({
            factor: "4H & 1H Intraday Order Flow",
            weight: 15,
            signal: intradaySig,
            vote: voteLabel(intradaySig),
            reading: `4H: ${s4h.trend} | 1H: ${s1h.trend}`,
        });

        const pdSig = pd.bias_signal || 0.0;
        factors.push({
            factor: "PDH / PDL Liquidity Sweep & Acceptance",
            weight: 20,
            signal: pdSig,
            vote: voteLabel(pdSig),
            reading: pd.liquidity_state || "Unavailable",
        });

        const posPct = dr.position_pct ?? 50.0;
        const zone = dr.zone || "Equilibrium";
        let drSig = 0.0;
        if (posPct <= 45.0) drSig = roundTo(Math.min(1.0, ((50.0 - posPct) / 50.0) * 1.4), 2);
        else if (posPct >= 55.0) drSig = roundTo(Math.max(-1.0, ((50.0 - posPct) / 50.0) * 1.4), 2);
        factors.push({
            factor: "20D Dealing Range (Premium / Discount)",
            weight: 10,
            signal: drSig,
            vote: voteLabel(drSig),
            reading: `${zone} (${posPct.toFixed(1)}% of 20D range, EQ ${dr.equilibrium_50})`,
        });

        const bull1d = fvg1d.nearest_bullish_fvg;
        const bear1d = fvg1d.nearest_bearish_fvg;
        const bull4h = fvg4h.nearest_bullish_fvg;
        const bear4h = fvg4h.nearest_bearish_fvg;
        let fvgSig = 0.0;
        const fvgNotes = [];

        if (bull4h || bull1d) {
            const refBull = bull1d || bull4h;
            if (currentPrice >= refBull.bottom) {
                fvgSig += 0.5;
                fvgNotes.push(`Support ${refBull.timeframe} Bull FVG (${refBull.bottom}–${refBull.top})`);
            }
        }
        if (bear4h || bear1d) {
            const refBear = bear1d || bear4h;
            if (currentPrice <= refBear.top) {
                fvgSig -= 0.5;
                fvgNotes.push(`Overhead ${refBear.timeframe} Bear FVG (${refBear.bottom}–${refBear.top})`);
            }
        }

        for (const g of [...fvg4h.active_fvgs, ...fvg1d.active_fvgs]) {
            if (g.bottom <= currentPrice && currentPrice <= g.top) {
                if (g.type === "Bullish") {
                    fvgSig = Math.min(1.0, fvgSig + 0.4);
                    fvgNotes.push(`Price INSIDE ${g.timeframe} Bullish FVG`);
                } else {
                    fvgSig = Math.max(-1.0, fvgSig - 0.4);
                    fvgNotes.push(`Price INSIDE ${g.timeframe} Bearish FVG`);
                }
                break;
            }
        }

        fvgSig = roundTo(clip(fvgSig, -1.0, 1.0), 2);
        factors.push({
            factor: "Unmitigated 1D / 4H Fair Value Gaps",
            weight: 15,
            signal: fvgSig,
            vote: voteLabel(fvgSig),
            reading: fvgNotes.length ? fvgNotes.join("; ") : "No close unmitigated 1D/4H FVG magnet",
        });

        const mo = sessions.ny_midnight_open;
        let moSig = mo !== null ? (currentPrice >= mo ? 0.6 : -0.6) : 0.0;
        if ((sessions.asian_status || "").includes("Asian High (BSL) Swept")) moSig = roundTo(Math.max(-1.0, moSig - 0.3), 2);
        else if ((sessions.asian_status || "").includes("Asian Low (SSL) Swept")) moSig = roundTo(Math.min(1.0, moSig + 0.3), 2);
        factors.push({
            factor: "NY Midnight Open & Asian Liquidity",
            weight: 5,
            signal: moSig,
            vote: voteLabel(moSig),
            reading: `${sessions.price_vs_midnight || "N/A"} | ${sessions.asian_status || "N/A"}`,
        });

        const emaSig = roundTo(0.65 * t1d.ema_signal + 0.35 * t1h.ema_signal, 2);
        factors.push({
            factor: "EMA Trend Stack (20 / 50 / 200)",
            weight: 10,
            signal: emaSig,
            vote: voteLabel(emaSig),
            reading: `1D: ${t1d.ema_alignment} | 1H: ${t1h.ema_alignment}`,
        });

        const momSig = roundTo(0.6 * t1d.momentum_signal + 0.4 * t4h.momentum_signal, 2);
        factors.push({
            factor: "Momentum (1D & 4H RSI-14 / MACD)",
            weight: 5,
            signal: momSig,
            vote: voteLabel(momSig),
            reading: `1D RSI ${t1d.rsi_14} (${t1d.macd.state}) | 4H RSI ${t4h.rsi_14}`,
        });

        const totalScore = roundTo(factors.reduce((acc, f) => acc + f.weight * f.signal, 0), 1);
        let direction = "NEUTRAL / RANGING";
        if (totalScore >= 18.0) direction = "BULLISH";
        else if (totalScore <= -18.0) direction = "BEARISH";

        const confidence = roundTo(Math.min(95.0, 50.0 + Math.abs(totalScore) / 2.0), 1);

        const { pdh, pdl, pwh, pwl } = pd;
        let dolTarget = null;
        let dolLabel = "";
        let poiZone = "";
        let invalidation = null;
        let invalidationReason = "";

        if (direction === "BULLISH") {
            dolTarget = pdh !== null && currentPrice < pdh ? pdh : pwh;
            dolLabel = dolTarget === pdh ? "PDH (Buy-Side Liquidity)" : "PWH (Weekly Buy-Side Liquidity)";
            if (bear4h && bear4h.ce > currentPrice && (dolTarget === null || bear4h.ce < dolTarget)) {
                dolTarget = bear4h.ce;
                dolLabel = `4H Bearish FVG CE (${bear4h.ce})`;
            }
            const poi = bull4h || fvg1d.nearest_bullish_fvg || ictData.fvgs["1h"].nearest_bullish_fvg;
            poiZone = poi
                ? `${poi.timeframe} Bullish FVG: ${poi.bottom} – ${poi.top} (50% CE: ${poi.ce})`
                : `NY Midnight Open (${mo}) / PDL Sweep Zone (${pdl})`;
            invalidation = pdl !== null ? pdl : t4h.structure.last_swing_low;
            invalidationReason = "Daily/4H close below PDL / Bullish swing low breaks bullish order flow.";
        } else if (direction === "BEARISH") {
            dolTarget = pdl !== null && currentPrice > pdl ? pdl : pwl;
            dolLabel = dolTarget === pdl ? "PDL (Sell-Side Liquidity)" : "PWL (Weekly Sell-Side Liquidity)";
            if (bull4h && bull4h.ce < currentPrice && (dolTarget === null || bull4h.ce > dolTarget)) {
                dolTarget = bull4h.ce;
                dolLabel = `4H Bullish FVG CE (${bull4h.ce})`;
            }
            const poi = bear4h || fvg1d.nearest_bearish_fvg || ictData.fvgs["1h"].nearest_bearish_fvg;
            poiZone = poi
                ? `${poi.timeframe} Bearish FVG: ${poi.bottom} – ${poi.top} (50% CE: ${poi.ce})`
                : `NY Midnight Open (${mo}) / PDH Rejection Zone (${pdh})`;
            invalidation = pdh !== null ? pdh : t4h.structure.last_swing_high;
            invalidationReason = "Daily/4H close above PDH / Bearish swing high invalidates bearish draw.";
        } else {
            const distH = Math.abs((pdh ?? currentPrice) - currentPrice);
            const distL = Math.abs((pdl ?? currentPrice) - currentPrice);
            dolTarget = distH <= distL ? pdh : pdl;
            dolLabel = `Range Boundary (${dolTarget === pdh ? "PDH" : "PDL"})`;
            poiZone = `Wait for sweep of PDH (${pdh}) or PDL (${pdl}) with 15m Market Structure Shift`;
            invalidation = dr.equilibrium_50;
            invalidationReason = "Mixed HTF/LTF confluence — wait for clean displacement outside PDH/PDL.";
        }

        const dolPips = dolTarget !== null ? roundTo(Math.abs(dolTarget - currentPrice) / pipSize, 1) : null;
        const bullPts = factors.filter((f) => f.signal > 0.15).map((f) => `${f.factor}: ${f.reading}`);
        const bearPts = factors.filter((f) => f.signal < -0.15).map((f) => `${f.factor}: ${f.reading}`);

        const signPrefix = totalScore > 0 ? "+" : "";
        const execSummary =
            `${pairInfo.name} holds a ${direction} daily bias (score ${signPrefix}${totalScore.toFixed(1)}/100, ` +
            `confidence ${confidence.toFixed(1)}%). Price is at ${roundTo(currentPrice, decimals)} in the ` +
            `${zone} zone (${posPct.toFixed(1)}% of the 20-day dealing range). ` +
            `Liquidity state: ${pd.liquidity_state}.`;

        return {
            direction,
            score: totalScore,
            confidence,
            dol_target: dolTarget !== null ? roundTo(dolTarget, decimals) : null,
            dol_label: dolLabel,
            dol_distance_pips: dolPips,
            poi_zone: poiZone,
            invalidation_level: invalidation !== null ? roundTo(invalidation, decimals) : null,
            invalidation_reason: invalidationReason,
            factors,
            narrative: {
                executive_summary: execSummary,
                bullish_case: bullPts.length ? bullPts : ["No strong bullish confluences currently active."],
                bearish_case: bearPts.length ? bearPts : ["No strong bearish confluences currently active."],
                session_checklist: [
                    `Mark PDH (${pdh}) and PDL (${pdl}) on your chart before London/NY Killzone.`,
                    `Watch NY Midnight Open (${mo}) for Judas Swing manipulation against the ${direction} bias.`,
                    `Primary POI to monitor: ${poiZone}.`,
                    `Confirm 15m/5m displacement + FVG before entry; invalidate if price closes beyond ${invalidation}.`,
                ],
            },
        };
    }

    function buildChartData(candles, decimals, maxBars = 180) {
        if (!candles || !candles.length) {
            return { candles: [], ema_20: [], ema_50: [], ema_200: [] };
        }
        const closes = candles.map((c) => c.close);
        const e20 = computeEmaArray(closes, 20);
        const e50 = computeEmaArray(closes, 50);
        const e200 = computeEmaArray(closes, 200);

        const start = Math.max(0, candles.length - maxBars);
        const outCandles = [];
        const outE20 = [];
        const outE50 = [];
        const outE200 = [];

        for (let i = start; i < candles.length; i++) {
            const c = candles[i];
            outCandles.push({
                time: c.time,
                open: roundTo(c.open, decimals),
                high: roundTo(c.high, decimals),
                low: roundTo(c.low, decimals),
                close: roundTo(c.close, decimals),
            });
            outE20.push({ time: c.time, value: roundTo(e20[i], decimals) });
            outE50.push({ time: c.time, value: roundTo(e50[i], decimals) });
            outE200.push({ time: c.time, value: roundTo(e200[i], decimals) });
        }

        return { candles: outCandles, ema_20: outE20, ema_50: outE50, ema_200: outE200 };
    }

    async function runFullAnalysis(pair = "GBPUSD", timeframe = "1h", forceRefresh = false) {
        const tf = timeframe.trim().toLowerCase();
        if (!ALLOWED_TIMEFRAMES.includes(tf)) {
            throw new Error(`Unsupported timeframe '${timeframe}'. Allowed: ${ALLOWED_TIMEFRAMES.join(", ")}`);
        }

        const market = await fetchMultiTimeframeData(pair, forceRefresh);
        const pairInfo = market.pair_info;
        const pipSize = pairInfo.pip_size;
        const decimals = pairInfo.decimals;
        const currentPrice = market.current_price;
        const frames = market.frames;

        const fvgs = {
            "1d": detectFvgsON(frames["1d"], pipSize, "1D", 3.0, decimals),
            "4h": detectFvgsON(frames["4h"], pipSize, "4H", 2.0, decimals),
            "1h": detectFvgsON(frames["1h"], pipSize, "1H", 1.5, decimals),
            "15m": detectFvgsON(frames["15m"], pipSize, "15m", 1.0, decimals),
        };

        const previousDay = analyzePreviousDayAndWeek(frames["1d"], frames["15m"], currentPrice, pipSize, decimals);
        const drSessions = analyzeDealingRangeAndSessions(frames["1d"], frames["15m"], currentPrice, pipSize, decimals);

        const ictData = {
            previous_day: previousDay,
            dealing_range: drSessions.dealing_range,
            sessions: drSessions.sessions,
            fvgs,
        };

        const technicals = {
            "1d": analyzeTechnicals(frames["1d"], pipSize, "1D", decimals),
            "4h": analyzeTechnicals(frames["4h"], pipSize, "4H", decimals),
            "1h": analyzeTechnicals(frames["1h"], pipSize, "1H", decimals),
            "15m": analyzeTechnicals(frames["15m"], pipSize, "15m", decimals),
        };

        const biasSummary = computeDailyBias(ictData, technicals, pairInfo, currentPrice);
        const chartData = buildChartData(frames[tf], decimals);

        return {
            pair_info: pairInfo,
            selected_timeframe: tf,
            current_price: roundTo(currentPrice, decimals),
            last_updated_ny: market.last_updated_ny,
            data_source: market.data_source,
            available_pairs: Object.entries(ALLOWED_PAIRS).map(([k, v]) => ({ symbol: k, name: v.name })),
            bias_summary: biasSummary,
            ict: ictData,
            technicals,
            chart_data: chartData,
        };
    }

    async function generateLlmBrief(analysisPayload, provider = "groq", apiKey = null, model = null) {
        const providerClean = (provider || "groq").trim().toLowerCase();
        const bias = analysisPayload.bias_summary;
        const ict = analysisPayload.ict;
        const compact = {
            pair: analysisPayload.pair_info.name,
            current_price: analysisPayload.current_price,
            last_updated_ny: analysisPayload.last_updated_ny,
            quantitative_bias: {
                direction: bias.direction,
                score: bias.score,
                confidence: bias.confidence,
                dol_target: bias.dol_target,
                dol_label: bias.dol_label,
                poi_zone: bias.poi_zone,
                invalidation_level: bias.invalidation_level,
            },
            previous_day: ict.previous_day,
            dealing_range: ict.dealing_range,
            sessions: ict.sessions,
            nearest_fvgs: {
                "1d": {
                    nearest_bullish: ict.fvgs["1d"].nearest_bullish_fvg,
                    nearest_bearish: ict.fvgs["1d"].nearest_bearish_fvg,
                },
                "4h": {
                    nearest_bullish: ict.fvgs["4h"].nearest_bullish_fvg,
                    nearest_bearish: ict.fvgs["4h"].nearest_bearish_fvg,
                },
                "1h": {
                    nearest_bullish: ict.fvgs["1h"].nearest_bullish_fvg,
                    nearest_bearish: ict.fvgs["1h"].nearest_bearish_fvg,
                },
            },
            technicals_1d_4h: {
                "1d": analysisPayload.technicals["1d"],
                "4h": analysisPayload.technicals["4h"],
            },
        };

        const systemPrompt =
            "You are an institutional ICT (Inner Circle Trader) and quantitative forex strategist. " +
            "Analyze ONLY the exact numerical JSON data provided below. Do not invent price levels. " +
            "Produce a concise, actionable pre-session Daily Bias Brief covering:\n" +
            "1. Daily Bias Verdict (Bullish/Bearish/Neutral) and Why\n" +
            "2. Key Liquidity Draws (PDH/PDL/PWH/PWL & Asian Range)\n" +
            "3. Optimal Point of Interest (FVG / Consequent Encroachment / Midnight Open)\n" +
            "4. Technical Alignment (EMAs, RSI, MACD, ADR%)\n" +
            "5. Exact Invalidation Condition.";
        const userPrompt = `Analyze this live forex market snapshot:\n${JSON.stringify(compact, null, 2)}`;

        if (providerClean === "ollama") {
            const chosenModel = (model || "llama3.2").trim();
            const resp = await fetch("http://localhost:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: chosenModel,
                    stream: false,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                }),
            });
            if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status} (ensure local Ollama allows origin)`);
            const data = await resp.json();
            return { provider: "ollama", model: chosenModel, brief: data.message?.content || "" };
        }

        const key = (apiKey || "").trim();
        if (!key) {
            throw new Error(`Missing API key for ${providerClean}. Enter your free-tier key above.`);
        }

        if (providerClean === "groq") {
            const chosenModel = (model || "llama-3.3-70b-versatile").trim();
            const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: chosenModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                }),
            });
            if (!resp.ok) throw new Error(`Groq HTTP ${resp.status}: ${await resp.text()}`);
            const data = await resp.json();
            return { provider: "groq", model: chosenModel, brief: data.choices[0].message.content };
        }

        if (providerClean === "openrouter") {
            const chosenModel = (model || "meta-llama/llama-3.3-70b-instruct:free").trim();
            const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: chosenModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                }),
            });
            if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${await resp.text()}`);
            const data = await resp.json();
            return { provider: "openrouter", model: chosenModel, brief: data.choices[0].message.content };
        }

        if (providerClean === "gemini") {
            const chosenModel = (model || "gemini-2.0-flash").trim();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(key)}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ parts: [{ text: userPrompt }] }],
                }),
            });
            if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
            const data = await resp.json();
            return {
                provider: "gemini",
                model: chosenModel,
                brief: data.candidates[0].content.parts[0].text,
            };
        }

        throw new Error(`Unsupported LLM provider '${provider}'.`);
    }

    root.ClientBiasEngine = {
        ALLOWED_PAIRS,
        validatePair,
        detectFvgsON,
        analyzePreviousDayAndWeek,
        analyzeDealingRangeAndSessions,
        analyzeTechnicals,
        computeDailyBias,
        fetchMultiTimeframeData,
        runFullAnalysis,
        generateLlmBrief,
    };
})(typeof window !== "undefined" ? window : globalThis);
