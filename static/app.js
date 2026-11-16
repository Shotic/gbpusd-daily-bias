const state = {
    pair: "GBPUSD",
    timeframe: "1h",
    fvgTab: "1d",
    backendMode: null,
    data: null,
    chart: null,
    candleSeries: null,
    ema20Series: null,
    ema50Series: null,
    ema200Series: null,
    priceLines: [],
};

function initChart() {
    const container = document.getElementById("chart-container");
    container.innerHTML = "";

    const chart = LightweightCharts.createChart(container, {
        layout: {
            background: { type: "solid", color: "#0b0f17" },
            textColor: "#cbd5e1",
        },
        grid: {
            vertLines: { color: "rgba(37, 48, 71, 0.45)" },
            horzLines: { color: "rgba(37, 48, 71, 0.45)" },
        },
        rightPriceScale: {
            borderColor: "#253047",
        },
        timeScale: {
            borderColor: "#253047",
            timeVisible: true,
            secondsVisible: false,
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
    });

    const candleSeries = chart.addCandlestickSeries({
        upColor: "#10b981",
        downColor: "#ef4444",
        borderUpColor: "#10b981",
        borderDownColor: "#ef4444",
        wickUpColor: "#10b981",
        wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
    });

    const ema20Series = chart.addLineSeries({
        color: "#38bdf8",
        lineWidth: 1.5,
        title: "EMA 20",
        priceLineVisible: false,
    });
    const ema50Series = chart.addLineSeries({
        color: "#f59e0b",
        lineWidth: 1.5,
        title: "EMA 50",
        priceLineVisible: false,
    });
    const ema200Series = chart.addLineSeries({
        color: "#a855f7",
        lineWidth: 2,
        title: "EMA 200",
        priceLineVisible: false,
    });

    state.chart = chart;
    state.candleSeries = candleSeries;
    state.ema20Series = ema20Series;
    state.ema50Series = ema50Series;
    state.ema200Series = ema200Series;

    const resizeObserver = new ResizeObserver(() => {
        chart.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight,
        });
    });
    resizeObserver.observe(container);
}

function clearPriceLines() {
    if (!state.candleSeries) return;
    for (const line of state.priceLines) {
        state.candleSeries.removePriceLine(line);
    }
    state.priceLines = [];
}

function addLevelLine(price, title, color, lineStyle = LightweightCharts.LineStyle.Dashed) {
    if (price === null || price === undefined || !state.candleSeries) return;
    const line = state.candleSeries.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle,
        axisLabelVisible: true,
        title,
    });
    state.priceLines.push(line);
}

function renderChart(data) {
    if (!state.chart) initChart();

    const decimals = data.pair_info.decimals || 5;
    const minMove = Number((10 ** -decimals).toFixed(decimals));
    state.candleSeries.applyOptions({
        priceFormat: { type: "price", precision: decimals, minMove },
    });

    const showEmas = document.getElementById("toggle-emas").checked;
    const showIct = document.getElementById("toggle-ict").checked;
    const showFvg = document.getElementById("toggle-fvg").checked;

    state.candleSeries.setData(data.chart_data.candles);
    state.ema20Series.setData(showEmas ? data.chart_data.ema_20 : []);
    state.ema50Series.setData(showEmas ? data.chart_data.ema_50 : []);
    state.ema200Series.setData(showEmas ? data.chart_data.ema_200 : []);

    clearPriceLines();

    if (showIct) {
        const pd = data.ict.previous_day;
        const dr = data.ict.dealing_range;
        const sess = data.ict.sessions;
        addLevelLine(pd.pdh, "PDH", "#ef4444", LightweightCharts.LineStyle.Solid);
        addLevelLine(pd.pdl, "PDL", "#10b981", LightweightCharts.LineStyle.Solid);
        addLevelLine(sess.ny_midnight_open, "NY 00:00", "#38bdf8", LightweightCharts.LineStyle.Dashed);
        addLevelLine(dr.equilibrium_50, "50% EQ", "#f59e0b", LightweightCharts.LineStyle.Dotted);
    }

    if (showFvg) {
        const tfKey = data.selected_timeframe;
        const tfFvgs = data.ict.fvgs[tfKey] || data.ict.fvgs["4h"];
        if (tfFvgs.nearest_bullish_fvg) {
            addLevelLine(
                tfFvgs.nearest_bullish_fvg.ce,
                `${tfFvgs.timeframe} Bull FVG CE`,
                "#22c55e",
                LightweightCharts.LineStyle.LargeDashed
            );
        }
        if (tfFvgs.nearest_bearish_fvg) {
            addLevelLine(
                tfFvgs.nearest_bearish_fvg.ce,
                `${tfFvgs.timeframe} Bear FVG CE`,
                "#fb7185",
                LightweightCharts.LineStyle.LargeDashed
            );
        }
    }

    state.chart.timeScale().fitContent();
}

function renderBiasHero(data) {
    const bias = data.bias_summary;
    document.getElementById("pair-title").textContent = data.pair_info.name;
    document.getElementById("chart-tf-label").textContent = data.selected_timeframe.toUpperCase();
    document.getElementById("current-price").textContent = data.current_price;
    const sourceText = data.data_source ? ` • ${data.data_source}` : "";
    document.getElementById("last-updated").textContent = `NY Time: ${data.last_updated_ny}${sourceText}`;
    document.getElementById("exec-summary").textContent = bias.narrative.executive_summary;

    const badge = document.getElementById("bias-badge");
    badge.textContent = bias.direction;
    badge.className = "bias-badge";
    if (bias.direction === "BULLISH") badge.classList.add("bullish");
    else if (bias.direction === "BEARISH") badge.classList.add("bearish");
    else badge.classList.add("neutral");

    document.getElementById("bias-score").textContent = `${bias.score > 0 ? "+" : ""}${bias.score} / 100`;
    document.getElementById("bias-confidence").textContent = `Confidence: ${bias.confidence}%`;

    const fill = document.getElementById("score-bar-fill");
    const clamped = Math.max(-100, Math.min(100, bias.score));
    const halfWidth = Math.abs(clamped) / 2;
    fill.style.width = `${halfWidth}%`;
    if (clamped >= 0) {
        fill.style.left = "50%";
        fill.style.background = "#10b981";
    } else {
        fill.style.left = `${50 - halfWidth}%`;
        fill.style.background = "#ef4444";
    }

    document.getElementById("dol-target").textContent =
        bias.dol_target !== null ? `${bias.dol_target} (${bias.dol_distance_pips} pips)` : "---";
    document.getElementById("dol-label").textContent = bias.dol_label || "---";
    document.getElementById("poi-zone").textContent = bias.poi_zone || "---";
    document.getElementById("invalidation-level").textContent =
        bias.invalidation_level !== null ? bias.invalidation_level : "---";
    document.getElementById("invalidation-reason").textContent = bias.invalidation_reason || "---";
}

function renderIctCards(data) {
    const pd = data.ict.previous_day;
    document.getElementById("val-pdh").textContent = `${pd.pdh ?? "---"} (${pd.pdh_distance_pips ?? "-"}p)`;
    document.getElementById("val-pdl").textContent = `${pd.pdl ?? "---"} (${pd.pdl_distance_pips ?? "-"}p)`;
    document.getElementById("val-pdc").textContent = pd.pdc ?? "---";
    document.getElementById("val-pw").textContent = `${pd.pwh ?? "---"} / ${pd.pwl ?? "---"}`;
    document.getElementById("liquidity-state").textContent = pd.liquidity_state;

    const dr = data.ict.dealing_range;
    document.getElementById("dr-low").textContent = `Low: ${dr.range_low ?? "---"}`;
    document.getElementById("dr-high").textContent = `High: ${dr.range_high ?? "---"}`;
    document.getElementById("dr-eq").textContent = `50% EQ: ${dr.equilibrium_50 ?? "---"}`;
    document.getElementById("dr-zone").textContent = `${dr.zone} (${dr.position_pct}%)`;
    document.getElementById("dr-marker").style.left = `${dr.position_pct}%`;

    const sess = data.ict.sessions;
    document.getElementById("val-mo").textContent = sess.ny_midnight_open ?? "Unavailable";
    document.getElementById("val-mo-rel").textContent = sess.price_vs_midnight ?? "Unavailable";
    document.getElementById("val-asian").textContent =
        sess.asian_high !== null ? `${sess.asian_low} – ${sess.asian_high}` : "Unavailable";
    document.getElementById("val-asian-status").textContent = sess.asian_status ?? "Unavailable";
    document.getElementById("val-london").textContent =
        sess.london_high !== null ? `${sess.london_low} – ${sess.london_high} (${sess.london_status})` : "Pending / Unavailable";
}

function renderTables(data) {
    // 1. 8-Factor Confluence Table
    const fBody = document.querySelector("#factors-table tbody");
    fBody.innerHTML = "";
    for (const f of data.bias_summary.factors) {
        const voteClass = f.vote.toLowerCase();
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${f.factor}</strong></td>
            <td>${f.weight}%</td>
            <td><span class="vote-pill ${voteClass}">${f.vote}</span></td>
            <td>${f.reading}</td>
        `;
        fBody.appendChild(tr);
    }

    // 2. Technicals Table
    const tBody = document.querySelector("#tech-table tbody");
    tBody.innerHTML = "";
    for (const tfKey of ["1d", "4h", "1h", "15m"]) {
        const t = data.technicals[tfKey];
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${t.timeframe}</strong></td>
            <td>${t.structure.trend}</td>
            <td>${t.ema_alignment}</td>
            <td>${t.rsi_14} (${t.rsi_state})</td>
            <td>${t.macd.state}</td>
        `;
        tBody.appendChild(tr);
    }
    const atr1d = data.technicals["1d"].atr;
    document.getElementById("adr-summary").textContent =
        `14D ADR: ${atr1d.atr_pips} pips | Today: ${atr1d.today_range_pips} pips (${atr1d.adr_consumed_pct}% consumed)`;

    // 3. FVGs Table
    renderFvgTable();

    // 4. Narrative Lists
    const fillList = (id, items) => {
        const el = document.getElementById(id);
        el.innerHTML = "";
        for (const text of items) {
            const li = document.createElement("li");
            li.textContent = text;
            el.appendChild(li);
        }
    };
    fillList("bull-list", data.bias_summary.narrative.bullish_case);
    fillList("bear-list", data.bias_summary.narrative.bearish_case);
    fillList("checklist", data.bias_summary.narrative.session_checklist);
}

function renderFvgTable() {
    if (!state.data) return;
    const fvgBox = state.data.ict.fvgs[state.fvgTab];
    const tbody = document.querySelector("#fvg-table tbody");
    tbody.innerHTML = "";

    if (!fvgBox || fvgBox.active_fvgs.length === 0) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="6" class="muted">No active unmitigated FVGs detected on ${state.fvgTab.toUpperCase()}.</td>`;
        tbody.appendChild(tr);
        return;
    }

    for (const g of fvgBox.active_fvgs) {
        const pillClass = g.type === "Bullish" ? "bullish" : "bearish";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="vote-pill ${pillClass}">${g.type}</span></td>
            <td>${g.bottom} – ${g.top}</td>
            <td><strong>${g.ce}</strong></td>
            <td>${g.size_pips}p</td>
            <td>${g.status}</td>
            <td>${g.abs_distance_pips}p</td>
        `;
        tbody.appendChild(tr);
    }
}

function showBanner(msg) {
    const el = document.getElementById("status-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
}

function hideBanner() {
    document.getElementById("status-banner").classList.add("hidden");
}

function isStaticHost() {
    return (
        window.location.hostname.endsWith("github.io") ||
        window.location.protocol === "file:"
    );
}

async function fetchAnalysis(forceRefresh = false) {
    const btn = document.getElementById("refresh-btn");
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    hideBanner();

    try {
        let payload;
        if (isStaticHost() || state.backendMode === "client") {
            state.backendMode = "client";
            payload = await window.ClientBiasEngine.runFullAnalysis(
                state.pair,
                state.timeframe,
                forceRefresh
            );
        } else {
            try {
                const url = `api/analyze?pair=${encodeURIComponent(state.pair)}&timeframe=${encodeURIComponent(state.timeframe)}&force_refresh=${forceRefresh}`;
                const resp = await fetch(url);
                if (!resp.ok) {
                    if (resp.status === 404 || resp.status === 405) {
                        throw new Error("STATIC_FALLBACK");
                    }
                    const errBody = await resp.json().catch(() => ({}));
                    throw new Error(errBody.detail || "Failed to analyze market data.");
                }
                payload = await resp.json();
                state.backendMode = "api";
            } catch (apiErr) {
                if (
                    window.ClientBiasEngine &&
                    (apiErr.message === "STATIC_FALLBACK" || apiErr instanceof TypeError || apiErr instanceof SyntaxError)
                ) {
                    state.backendMode = "client";
                    payload = await window.ClientBiasEngine.runFullAnalysis(
                        state.pair,
                        state.timeframe,
                        forceRefresh
                    );
                } else {
                    throw apiErr;
                }
            }
        }

        state.data = payload;
        renderBiasHero(payload);
        renderIctCards(payload);
        renderTables(payload);
        renderChart(payload);
    } catch (err) {
        showBanner(err.message || "Error loading analysis.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Refresh Live Data";
    }
}

async function runLlmBrief() {
    const btn = document.getElementById("llm-run-btn");
    const out = document.getElementById("llm-output");
    btn.disabled = true;
    btn.textContent = "Synthesizing...";
    out.classList.remove("hidden");
    out.textContent = "Requesting AI brief...";

    const provider = document.getElementById("llm-provider").value;
    const model = document.getElementById("llm-model").value || null;
    const apiKey = document.getElementById("llm-key").value || null;

    try {
        let payload;
        if (isStaticHost() || state.backendMode === "client") {
            if (!state.data) {
                state.data = await window.ClientBiasEngine.runFullAnalysis(state.pair, state.timeframe, false);
            }
            payload = await window.ClientBiasEngine.generateLlmBrief(state.data, provider, apiKey, model);
        } else {
            const resp = await fetch("api/ai-brief", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    pair: state.pair,
                    provider,
                    model,
                    api_key: apiKey,
                }),
            });
            payload = await resp.json();
            if (!resp.ok) {
                throw new Error(payload.detail || "LLM brief generation failed.");
            }
        }
        out.textContent = `[${payload.provider.toUpperCase()} | ${payload.model}]\n\n${payload.brief}`;
    } catch (err) {
        out.textContent = `Error: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = "Synthesize Brief";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initChart();

    document.getElementById("pair-select").addEventListener("change", (e) => {
        state.pair = e.target.value;
        fetchAnalysis(false);
    });

    document.querySelectorAll(".tf-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            state.timeframe = btn.dataset.tf;
            fetchAnalysis(false);
        });
    });

    document.querySelectorAll(".fvg-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".fvg-tab").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            state.fvgTab = btn.dataset.fvgtf;
            renderFvgTable();
        });
    });

    ["toggle-emas", "toggle-ict", "toggle-fvg"].forEach((id) => {
        document.getElementById(id).addEventListener("change", () => {
            if (state.data) renderChart(state.data);
        });
    });

    document.getElementById("refresh-btn").addEventListener("click", () => fetchAnalysis(true));
    document.getElementById("llm-run-btn").addEventListener("click", runLlmBrief);

    fetchAnalysis(false);
});
