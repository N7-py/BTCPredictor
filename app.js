/**
 * BTC Movement Predictor - Main Application
 * 
 * Integrates:
 * - Binance public API for real-time OHLCV kline data
 * - Technical Indicators library (indicators.js)
 * - Prediction engine (predictor.js)
 * - TradingView Lightweight Charts for visualization
 */

const App = {
    // State
    currentTimeframe: '30m',
    chartTimeframe: '1m',
    frozenPrice: null,
    frozenTime: null,
    currentPrice: null,
    klineData: {},       // Cached kline data per timeframe
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    ws: null,
    predictionInterval: null,
    priceWs: null,
    ticker24h: null,

    // Polymarket state
    pmPriceToBeat: null,
    pmWindowStart: null,    // Unix timestamp of current 5m window start
    pmWindowEnd: null,      // Unix timestamp of current 5m window end
    pmEventId: null,
    pmCountdownInterval: null,
    pmRefreshInterval: null,
    pmOddsUp: null,
    pmOddsDown: null,

    // Prediction Tracker state (tracks target price analysis accuracy for Polymarket 5m)
    pmTracker: {
        active: false,              // Whether auto-tracking is enabled
        currentPrediction: null,    // Current window's prediction (with full snapshot)
        results: [],                // Array of detailed result objects
        successRate: null,          // Calculated after 10 results
        predictionLog: [],          // Full detailed log with indicator snapshots
        indicatorAccuracy: {},      // Per-indicator accuracy tracking: { name: { right, wrong, total } }
        factorAccuracy: {},         // Per-factor accuracy tracking: { name: { right, wrong, total, avgScore } }
        learningInsights: [],       // Generated insights about wrong predictions
        weightAdjustments: [],      // History of weight changes
        learningCycles: 0,          // Number of times self-learning has run
        analysisScheduled: false,   // Whether 20s analysis is scheduled for this window
        dataReady: false            // Whether new window data has been fetched
    },

    // Polymarket API config
    // When running via server.js, uses local proxy /api/pm/ (no CORS issues)
    // Falls back to external CORS proxies if opened as file://
    GAMMA_API: 'https://gamma-api.polymarket.com',
    LOCAL_PM_PROXY: '/api/pm',
    CORS_PROXIES: [
        'https://api.allorigins.win/raw?url=',
        'https://api.codetabs.com/v1/proxy?quest=',
    ],
    pmUseLocalProxy: false,  // Set to true after detecting local proxy

    // Binance API (with fallback mirrors for regions where binance.com is blocked)
    BINANCE_REST: 'https://api.binance.com/api/v3',
    BINANCE_REST_FALLBACKS: [
        'https://api1.binance.com/api/v3',
        'https://api2.binance.com/api/v3',
        'https://api3.binance.com/api/v3',
        'https://api4.binance.com/api/v3'
    ],
    BINANCE_WS: 'wss://stream.binance.com:9443/ws',
    BINANCE_WS_FALLBACKS: [
        'wss://stream.binance.com:443/ws'
    ],
    apiBaseUrl: null, // Resolved working API base
    wsBaseUrl: null,  // Resolved working WS base

    // Timeframe to Binance interval mapping
    // Note: Binance has no native 10m interval, so we fetch 5m and aggregate
    tfMap: {
        '1m': '1m',
        '5m': '5m',
        '10m': '5m',   // Fetch 5m, then aggregate pairs into 10m
        '15m': '15m',  // Used by chart timeframe selector
        '30m': '30m',
        '1h': '1h',
        '4h': '4h',
        '1d': '1d'
    },

    // Number of klines to fetch per timeframe (need enough for indicators)
    klineLimit: {
        '1m': 300,
        '5m': 300,
        '10m': 600,    // Fetch 600 x 5m = 300 x 10m candles
        '15m': 250,
        '30m': 250,
        '1h': 250,
        '4h': 200,
        '1d': 200
    },

    // ===== Initialization =====

    async init() {
        console.log('[BTC Predictor] Initializing...');

        // Setup UI event listeners
        this.setupEventListeners();

        // Initialize chart
        this.initChart();

        // Find a working API endpoint
        await this.resolveApiEndpoint();

        // Fetch initial data
        await this.fetchKlines(this.currentTimeframe);
        await this.fetchKlines(this.chartTimeframe);
        // Pre-fetch 5m data for target price predictions
        if (this.currentTimeframe !== '5m' && this.chartTimeframe !== '5m') {
            await this.fetchKlines('5m');
        }

        // Fetch 24h ticker
        await this.fetch24hTicker();

        // Connect WebSocket for real-time price
        this.connectWebSocket();

        // Start prediction loop
        this.startPredictionLoop();

        // Load chart data
        this.updateChart();

        // Initialize Polymarket integration
        this.initPolymarket();

        console.log('[BTC Predictor] Ready!');
    },

    /** Try each API endpoint until one works */
    async resolveApiEndpoint() {
        const endpoints = [this.BINANCE_REST, ...this.BINANCE_REST_FALLBACKS];
        for (const url of endpoints) {
            try {
                const resp = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(5000) });
                if (resp.ok) {
                    this.apiBaseUrl = url;
                    console.log('[API] Using endpoint:', url);
                    return;
                }
            } catch (e) {
                console.warn('[API] Endpoint failed:', url);
            }
        }
        // Default to primary
        this.apiBaseUrl = this.BINANCE_REST;
        console.warn('[API] All endpoints failed, using default');
    },

    // ===== Event Listeners =====

    setupEventListeners() {
        // Prediction timeframe buttons
        document.querySelectorAll('.tf-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentTimeframe = e.target.dataset.tf;
                document.getElementById('predictionTfBadge').textContent = this.currentTimeframe;
                this.onTimeframeChange();
            });
        });

        // Chart timeframe buttons
        document.querySelectorAll('.chart-tf-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.chartTimeframe = e.target.dataset.chartTf;
                this.onChartTimeframeChange();
            });
        });

        // Freeze button
        document.getElementById('freezeBtn').addEventListener('click', () => this.freezePrice());
        document.getElementById('unfreezeBtn').addEventListener('click', () => this.unfreezePrice());

        // Manual price prediction
        document.getElementById('manualPredictBtn').addEventListener('click', () => this.predictManualPrice());
        document.getElementById('manualPriceInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.predictManualPrice();
        });

        // Polymarket "Use as Target Price" button
        document.getElementById('pmUseBtn').addEventListener('click', () => this.usePolymarketPrice());
    },

    // ===== Data Fetching =====

    async fetchKlines(timeframe) {
        const interval = this.tfMap[timeframe];
        const limit = this.klineLimit[timeframe];
        const baseUrl = this.apiBaseUrl || this.BINANCE_REST;
        const url = `${baseUrl}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            let klines = data.map(k => ({
                time: k[0] / 1000,        // Unix timestamp in seconds
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                closeTime: k[6],
                quoteVolume: parseFloat(k[7]),
                trades: k[8]
            }));

            // Aggregate 5m candles into 10m if needed
            if (timeframe === '10m') {
                klines = this.aggregate5mTo10m(klines);
            }

            this.klineData[timeframe] = klines;

            // Update current price from the latest kline
            const latest = this.klineData[timeframe][this.klineData[timeframe].length - 1];
            if (latest) {
                this.currentPrice = latest.close;
                this.updatePriceDisplay(latest.close);
            }

            return this.klineData[timeframe];
        } catch (err) {
            console.error(`[Fetch Error] ${timeframe}:`, err);
            this.setConnectionStatus('error', 'API Error');
            return null;
        }
    },

    async fetch24hTicker() {
        try {
            const baseUrl = this.apiBaseUrl || this.BINANCE_REST;
            const response = await fetch(`${baseUrl}/ticker/24hr?symbol=BTCUSDT`);
            this.ticker24h = await response.json();
            this.update24hStats();
        } catch (err) {
            console.error('[24h Ticker Error]:', err);
        }
    },

    // ===== WebSocket =====

    connectWebSocket() {
        // Close existing connections
        if (this.priceWs) {
            this.priceWs.close();
        }

        const streamName = `btcusdt@ticker`;
        const wsUrl = `${this.BINANCE_WS}/${streamName}`;

        try {
            this.priceWs = new WebSocket(wsUrl);

            this.priceWs.onopen = () => {
                console.log('[WS] Connected to Binance');
                this.setConnectionStatus('connected', 'Live');
            };

            this.priceWs.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.onTickerUpdate(data);
            };

            this.priceWs.onerror = (err) => {
                console.error('[WS Error]:', err);
                this.setConnectionStatus('error', 'WS Error');
            };

            this.priceWs.onclose = () => {
                console.log('[WS] Disconnected, reconnecting in 3s...');
                this.setConnectionStatus('error', 'Reconnecting...');
                setTimeout(() => this.connectWebSocket(), 3000);
            };
        } catch (err) {
            console.error('[WS] Connection failed:', err);
            this.setConnectionStatus('error', 'Connection Failed');
            setTimeout(() => this.connectWebSocket(), 5000);
        }

        // Also connect kline WebSocket for chart updates
        this.connectKlineWs();
    },

    connectKlineWs() {
        if (this.ws) {
            this.ws.close();
        }

        const interval = this.tfMap[this.chartTimeframe];
        const streamName = `btcusdt@kline_${interval}`;
        const wsUrl = `${this.BINANCE_WS}/${streamName}`;

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.k) {
                    this.onKlineUpdate(data.k);
                }
            };

            this.ws.onerror = (err) => {
                console.error('[Kline WS Error]:', err);
            };

            this.ws.onclose = () => {
                setTimeout(() => this.connectKlineWs(), 3000);
            };
        } catch (err) {
            console.error('[Kline WS] Connection failed:', err);
        }
    },

    onTickerUpdate(data) {
        const price = parseFloat(data.c); // Current price
        this.currentPrice = price;
        this.updatePriceDisplay(price);

        // Update 24h data
        this.ticker24h = {
            ...this.ticker24h,
            lastPrice: data.c,
            priceChange: data.p,
            priceChangePercent: data.P,
            highPrice: data.h,
            lowPrice: data.l,
            volume: data.v,
            quoteVolume: data.q
        };
        this.update24hStats();

        // Update frozen delta
        if (this.frozenPrice !== null) {
            this.updateFrozenDelta();
        }

        // Update last update time
        document.getElementById('lastUpdate').textContent =
            new Date().toLocaleTimeString();
    },

    onKlineUpdate(kline) {
        if (!this.candleSeries) return;

        const candle = {
            time: kline.t / 1000,
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c)
        };

        const volume = {
            time: kline.t / 1000,
            value: parseFloat(kline.v),
            color: parseFloat(kline.c) >= parseFloat(kline.o)
                ? 'rgba(16, 185, 129, 0.3)'
                : 'rgba(239, 68, 68, 0.3)'
        };

        this.candleSeries.update(candle);
        this.volumeSeries.update(volume);

        // Update cached kline data for the chart timeframe
        if (this.klineData[this.chartTimeframe]) {
            const data = this.klineData[this.chartTimeframe];
            const lastKline = data[data.length - 1];
            if (lastKline && lastKline.time === candle.time) {
                // Update existing candle
                lastKline.open = candle.open;
                lastKline.high = candle.high;
                lastKline.low = candle.low;
                lastKline.close = candle.close;
                lastKline.volume = parseFloat(kline.v);
            } else {
                // New candle
                data.push({
                    time: candle.time,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    volume: parseFloat(kline.v)
                });
                // Keep array bounded
                if (data.length > 500) data.shift();
            }
        }
    },

    /**
     * Aggregate 5m klines into 10m klines
     * Pairs consecutive 5m candles: [0,1], [2,3], [4,5], ...
     */
    aggregate5mTo10m(klines5m) {
        const result = [];
        // Align to 10-minute boundaries (timestamp divisible by 600)
        let i = 0;
        // Find first candle aligned to 10m boundary
        while (i < klines5m.length && (klines5m[i].time % 600) !== 0) {
            i++;
        }
        for (; i < klines5m.length - 1; i += 2) {
            const a = klines5m[i];
            const b = klines5m[i + 1];
            result.push({
                time: a.time,
                open: a.open,
                high: Math.max(a.high, b.high),
                low: Math.min(a.low, b.low),
                close: b.close,
                volume: a.volume + b.volume,
                quoteVolume: (a.quoteVolume || 0) + (b.quoteVolume || 0),
                trades: (a.trades || 0) + (b.trades || 0)
            });
        }
        return result;
    },

    // ===== Chart =====

    initChart() {
        const container = document.getElementById('chartContainer');

        this.chart = LightweightCharts.createChart(container, {
            layout: {
                background: { type: 'solid', color: '#1a2235' },
                textColor: '#9ca3af',
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace"
            },
            grid: {
                vertLines: { color: 'rgba(42, 53, 80, 0.5)' },
                horzLines: { color: 'rgba(42, 53, 80, 0.5)' }
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: 'rgba(247, 147, 26, 0.4)' },
                horzLine: { color: 'rgba(247, 147, 26, 0.4)' }
            },
            rightPriceScale: {
                borderColor: '#2a3550',
                scaleMargins: { top: 0.1, bottom: 0.25 }
            },
            timeScale: {
                borderColor: '#2a3550',
                timeVisible: true,
                secondsVisible: false
            },
            handleScroll: { vertTouchDrag: false }
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#ef4444',
            borderUpColor: '#10b981',
            borderDownColor: '#ef4444',
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444'
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            scaleMargins: { top: 0.8, bottom: 0 }
        });

        // Resize handler
        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                this.chart.applyOptions({ width, height });
            }
        });
        resizeObserver.observe(container);
    },

    async updateChart() {
        if (!this.klineData[this.chartTimeframe]) {
            await this.fetchKlines(this.chartTimeframe);
        }

        const data = this.klineData[this.chartTimeframe];
        if (!data || data.length === 0) return;

        const candles = data.map(k => ({
            time: k.time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close
        }));

        const volumes = data.map(k => ({
            time: k.time,
            value: k.volume,
            color: k.close >= k.open
                ? 'rgba(16, 185, 129, 0.3)'
                : 'rgba(239, 68, 68, 0.3)'
        }));

        this.candleSeries.setData(candles);
        this.volumeSeries.setData(volumes);

        // Add frozen price line if frozen
        if (this.frozenPrice !== null) {
            this.addFrozenPriceLine();
        }
    },

    addFrozenPriceLine() {
        if (!this.candleSeries) return;

        // Remove existing price lines
        this.candleSeries.createPriceLine({
            price: this.frozenPrice,
            color: '#3b82f6',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Frozen'
        });
    },

    // ===== Prediction Engine =====

    async onTimeframeChange() {
        // Fetch klines for the new prediction timeframe
        await this.fetchKlines(this.currentTimeframe);
        this.runPrediction();
    },

    async onChartTimeframeChange() {
        // Fetch and update chart
        await this.fetchKlines(this.chartTimeframe);
        this.updateChart();
        this.connectKlineWs(); // Reconnect kline WS for new interval
    },

    startPredictionLoop() {
        // Run prediction immediately
        this.runPrediction();

        // Then run every 5 seconds
        this.predictionInterval = setInterval(() => {
            this.runPrediction();
        }, 5000);

        // Refresh kline data periodically
        setInterval(async () => {
            await this.fetchKlines(this.currentTimeframe);
            if (this.currentTimeframe !== this.chartTimeframe) {
                await this.fetchKlines(this.chartTimeframe);
            }
        }, 30000); // Every 30 seconds

        // Refresh 24h ticker
        setInterval(() => this.fetch24hTicker(), 60000);
    },

    runPrediction() {
        const data = this.klineData[this.currentTimeframe];
        if (!data || data.length < 30) {
            console.warn('[Prediction] Insufficient data for', this.currentTimeframe);
            return;
        }

        // Compute technical indicators
        const indicators = TechnicalIndicators.computeAll(data);

        // Run prediction
        const prediction = Predictor.predict(indicators);

        // Update UI
        this.updatePredictionUI(prediction);
        this.updateIndicatorsUI(prediction.signals);
    },

    // ===== UI Updates =====

    updatePriceDisplay(price) {
        const priceEl = document.getElementById('currentPrice');
        const formatted = price.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        priceEl.textContent = formatted;
    },

    update24hStats() {
        if (!this.ticker24h) return;

        const change = parseFloat(this.ticker24h.priceChange || 0);
        const changePct = parseFloat(this.ticker24h.priceChangePercent || 0);
        const high = parseFloat(this.ticker24h.highPrice || 0);
        const low = parseFloat(this.ticker24h.lowPrice || 0);
        const vol = parseFloat(this.ticker24h.quoteVolume || 0);

        // Price change
        const changeEl = document.getElementById('priceChange');
        const changeValEl = changeEl.querySelector('.change-value');
        const changePctEl = changeEl.querySelector('.change-percent');

        changeEl.className = 'price-change ' + (change >= 0 ? 'up' : 'down');
        changeValEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2);
        changePctEl.textContent = `(${change >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;

        // 24h stats
        document.getElementById('high24h').textContent = '$' + high.toLocaleString();
        document.getElementById('low24h').textContent = '$' + low.toLocaleString();
        document.getElementById('vol24h').textContent = '$' + (vol / 1e6).toFixed(1) + 'M';
    },

    updatePredictionUI(prediction) {
        // Probabilities
        document.getElementById('probUp').textContent = prediction.probUp.toFixed(1) + '%';
        document.getElementById('probDown').textContent = prediction.probDown.toFixed(1) + '%';

        // Gauge
        document.getElementById('gaugeFillUp').style.height = prediction.probUp + '%';
        document.getElementById('gaugeFillDown').style.height = prediction.probDown + '%';

        // Verdict
        const verdictEl = document.getElementById('predictionVerdict');
        verdictEl.className = 'prediction-verdict ' + prediction.verdict;
        verdictEl.querySelector('.verdict-text').textContent = prediction.verdictText;

        // Confidence
        document.getElementById('confFill').style.width = prediction.confidence + '%';
        document.getElementById('confValue').textContent = prediction.confidence + '%';

        // Signal counts
        document.getElementById('bullCount').textContent = prediction.bullCount;
        document.getElementById('bearCount').textContent = prediction.bearCount;
        document.getElementById('neutralCount').textContent = prediction.neutralCount;
    },

    updateIndicatorsUI(signals) {
        const listEl = document.getElementById('indicatorsList');
        listEl.innerHTML = '';

        for (const sig of signals) {
            const item = document.createElement('div');
            item.className = 'indicator-item';

            const signalClass = sig.signal === 'buy' ? 'buy' :
                sig.signal === 'sell' ? 'sell' : 'neutral';
            const signalLabel = sig.signal === 'buy' ? 'BUY' :
                sig.signal === 'sell' ? 'SELL' : 'NEUTRAL';

            item.innerHTML = `
                <div>
                    <div class="indicator-name">${sig.name}</div>
                    <div class="indicator-desc" style="font-size:0.65rem;color:#6b7280;margin-top:2px;">${sig.description}</div>
                </div>
                <div class="indicator-value">${sig.value}</div>
                <div class="indicator-signal ${signalClass}">${signalLabel}</div>
            `;

            listEl.appendChild(item);
        }
    },

    setConnectionStatus(status, text) {
        const el = document.getElementById('connectionStatus');
        el.className = 'connection-status ' + status;
        el.querySelector('.status-text').textContent = text;
    },

    // ===== Freeze/Unfreeze =====

    freezePrice() {
        if (this.currentPrice === null) return;

        this.frozenPrice = this.currentPrice;
        this.frozenTime = new Date();

        // Update UI - hide freeze button, show frozen info
        document.getElementById('freezeBtn').style.display = 'none';
        document.getElementById('frozenInfo').style.display = 'block';
        document.getElementById('frozenPrice').textContent =
            '$' + this.frozenPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('frozenTime').textContent =
            this.frozenTime.toLocaleTimeString();
        document.getElementById('manualPriceInput').value = this.frozenPrice.toFixed(2);

        this.updateFrozenDelta();
        this.runTargetPrediction(this.frozenPrice);

        // Add line on chart
        this.addFrozenPriceLine();
    },

    unfreezePrice() {
        this.frozenPrice = null;
        this.frozenTime = null;

        // Show freeze button again, hide frozen info
        document.getElementById('freezeBtn').style.display = '';
        document.getElementById('frozenInfo').style.display = 'none';
        document.getElementById('targetPrediction').style.display = 'none';
        document.getElementById('manualPriceInput').value = '';

        // Remove price lines by recreating chart data
        this.updateChart();
    },

    predictManualPrice() {
        const input = document.getElementById('manualPriceInput');
        const price = parseFloat(input.value);
        if (isNaN(price) || price <= 0) {
            input.style.borderColor = '#ef4444';
            setTimeout(() => { input.style.borderColor = ''; }, 1500);
            return;
        }

        // Set as frozen price
        this.frozenPrice = price;
        this.frozenTime = new Date();

        // Update freeze UI
        document.getElementById('freezeBtn').style.display = 'none';
        document.getElementById('frozenInfo').style.display = 'block';
        document.getElementById('frozenPrice').textContent =
            '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('frozenTime').textContent =
            this.frozenTime.toLocaleTimeString();

        this.updateFrozenDelta();
        this.runTargetPrediction(price);
        this.addFrozenPriceLine();
    },

    runTargetPrediction(targetPrice) {
        // Use the currently selected prediction timeframe
        const tf = this.currentTimeframe;
        const data = this.klineData[tf];
        if (!data || data.length < 30) {
            console.warn('[Target Prediction] Insufficient data for', tf);
            return;
        }

        const indicators = TechnicalIndicators.computeAll(data);
        const result = Predictor.predictVsPrice(indicators, targetPrice);

        // Show target prediction UI
        const container = document.getElementById('targetPrediction');
        container.style.display = 'block';

        // Update header with timeframe
        document.querySelector('.target-pred-header').textContent =
            `Target Price Analysis (${tf} timeframe)`;

        // Update label based on direction
        const label = result.isTargetAbove
            ? `Go above target (next ${tf}):`
            : `Drop to target (next ${tf}):`;
        document.getElementById('targetReachLabel').textContent = label;

        document.getElementById('targetReachValue').textContent = result.probReachTarget + '%';
        document.getElementById('targetMissValue').textContent = result.probNotReach + '%';
        document.getElementById('targetVerdict').textContent = result.verdictText;

        // Render factor tags
        const factorsEl = document.getElementById('targetFactors');
        factorsEl.innerHTML = '';
        for (const f of result.factors) {
            const tag = document.createElement('span');
            const cls = f.score > 0.55 ? 'positive' : f.score < 0.45 ? 'negative' : 'neutral-tag';
            tag.className = 'target-factor-tag ' + cls;
            tag.textContent = `${f.name}: ${(f.score * 100).toFixed(0)}%`;
            factorsEl.appendChild(tag);
        }
    },

    updateFrozenDelta() {
        if (this.frozenPrice === null || this.currentPrice === null) return;

        const delta = this.currentPrice - this.frozenPrice;
        const deltaPct = (delta / this.frozenPrice) * 100;

        const deltaEl = document.getElementById('frozenDelta');
        deltaEl.className = 'frozen-delta ' + (delta >= 0 ? 'up' : 'down');
        deltaEl.textContent = `${delta >= 0 ? '+' : ''}$${delta.toFixed(2)} (${delta >= 0 ? '+' : ''}${deltaPct.toFixed(3)}%)`;
    },

    // ===== Polymarket Integration =====

    async initPolymarket() {
        console.log('[Polymarket] Initializing...');
        await this.fetchPolymarketData();

        // Start countdown timer (updates every second)
        this.pmCountdownInterval = setInterval(() => this.updatePolymarketCountdown(), 1000);

        // Refresh Polymarket data every 30 seconds for odds updates
        this.pmRefreshInterval = setInterval(() => this.refreshPolymarketOdds(), 30000);
    },

    /** Fetch Polymarket Gamma API — uses local proxy if available, falls back to CORS proxies */
    async corsProxyFetch(url) {
        // Method 1: Local proxy (when running via node server.js)
        if (this.pmUseLocalProxy) {
            try {
                const gammaPath = url.replace(this.GAMMA_API, '');
                const localUrl = this.LOCAL_PM_PROXY + gammaPath;
                const resp = await fetch(localUrl, { signal: AbortSignal.timeout(10000) });
                if (resp.ok) return resp;
            } catch (e) {
                console.warn('[Local Proxy] Failed, trying alternatives');
                this.pmUseLocalProxy = false;
            }
        }

        // Method 2: Try local proxy detection (first call only)
        if (!this.pmUseLocalProxy && window.location.protocol !== 'file:') {
            try {
                const gammaPath = url.replace(this.GAMMA_API, '');
                const localUrl = this.LOCAL_PM_PROXY + gammaPath;
                const resp = await fetch(localUrl, { signal: AbortSignal.timeout(5000) });
                if (resp.ok) {
                    console.log('[Polymarket] Using local proxy');
                    this.pmUseLocalProxy = true;
                    return resp;
                }
            } catch (e) { /* not available */ }
        }

        // Method 3: Direct fetch (unlikely to work due to CORS, but try)
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(5000), mode: 'cors' });
            if (resp.ok) {
                console.log('[CORS] Direct fetch succeeded');
                return resp;
            }
        } catch (e) { /* expected */ }

        // Method 4: External CORS proxies
        for (const proxy of this.CORS_PROXIES) {
            try {
                const proxyUrl = proxy + encodeURIComponent(url);
                console.log('[CORS Proxy] Trying:', proxy.substring(0, 40));
                const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
                if (resp.ok) {
                    const text = await resp.text();
                    try {
                        JSON.parse(text); // Validate JSON
                        console.log('[CORS Proxy] Success via', proxy.substring(0, 40));
                        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
                    } catch (e) {
                        console.warn('[CORS Proxy] Non-JSON from', proxy);
                    }
                }
            } catch (e) {
                console.warn('[CORS Proxy] Error:', proxy.substring(0, 40), e.message);
            }
        }

        return null;
    },

    /** Calculate current 5-minute window timestamps */
    getCurrentWindow() {
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (now % 300);
        const windowEnd = windowStart + 300;
        return { windowStart, windowEnd };
    },

    /** Fetch Polymarket event data for the current 5m window */
    async fetchPolymarketData() {
        const statusEl = document.getElementById('pmStatus');
        const contentEl = document.getElementById('pmContent');

        try {
            const { windowStart, windowEnd } = this.getCurrentWindow();
            this.pmWindowStart = windowStart;
            this.pmWindowEnd = windowEnd;

            const slug = `btc-updown-5m-${windowStart}`;
            console.log('[Polymarket] Fetching slug:', slug);

            // Method 1: Use local page-scrape endpoint (most reliable, gets live openPrice)
            if (window.location.protocol !== 'file:') {
                try {
                    const scrapeResp = await fetch(`/api/pm-price/${slug}`, { signal: AbortSignal.timeout(15000) });
                    if (scrapeResp.ok) {
                        const data = await scrapeResp.json();

                        // Get odds from current event
                        if (data.oddsUp !== null) {
                            this.pmOddsUp = data.oddsUp;
                            this.pmOddsDown = data.oddsDown;
                        }
                        this.pmEventId = data.eventId;

                        if (data.priceToBeat) {
                            // Validate: if server flagged as stale, use Binance price instead
                            if (data.validated === false && data.binancePrice) {
                                console.warn(`[Polymarket] Stale priceToBeat ($${data.priceToBeat.toFixed(2)}), using Binance ($${data.binancePrice.toFixed(2)})`);
                                this.pmPriceToBeat = data.binancePrice;
                            } else {
                                this.pmPriceToBeat = data.priceToBeat;
                            }
                            console.log('[Polymarket] Got priceToBeat:', this.pmPriceToBeat);
                            this.updatePolymarketUI();
                            return;
                        }

                        // priceToBeat not in current event — fetch PREVIOUS event's closePrice
                        console.log('[Polymarket] No priceToBeat in current event, fetching previous...');
                        const prevSlug = `btc-updown-5m-${windowStart - 300}`;
                        const prevResp = await fetch(`/api/pm-price/${prevSlug}`, { signal: AbortSignal.timeout(15000) });
                        if (prevResp.ok) {
                            const prevData = await prevResp.json();
                            if (prevData.closePrice) {
                                this.pmPriceToBeat = prevData.closePrice;
                                console.log('[Polymarket] Using previous event closePrice as priceToBeat:', prevData.closePrice);
                                this.updatePolymarketUI();
                                return;
                            }
                            // If previous event is still active (no closePrice), use its openPrice
                            if (prevData.openPrice) {
                                this.pmPriceToBeat = prevData.openPrice;
                                console.log('[Polymarket] Using previous event openPrice as fallback:', prevData.openPrice);
                                this.updatePolymarketUI();
                                return;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[Polymarket] Page scrape endpoint failed:', e.message);
                }
            }

            // Method 2: Fallback to Gamma API
            const eventsUrl = `${this.GAMMA_API}/events?slug=${slug}`;
            const eventsResp = await this.corsProxyFetch(eventsUrl);
            if (!eventsResp) {
                statusEl.textContent = 'Unable to reach Polymarket API';
                return;
            }

            const events = await eventsResp.json();
            if (!events || events.length === 0) {
                // Try previous window
                const prevSlug = `btc-updown-5m-${windowStart - 300}`;
                // Try scrape for previous window
                if (window.location.protocol !== 'file:') {
                    try {
                        const prevScrape = await fetch(`/api/pm-price/${prevSlug}`, { signal: AbortSignal.timeout(15000) });
                        if (prevScrape.ok) {
                            const data = await prevScrape.json();
                            if (data.priceToBeat) {
                                this.pmWindowStart = windowStart - 300;
                                this.pmWindowEnd = windowStart;
                                this.pmPriceToBeat = data.priceToBeat;
                                this.pmEventId = data.eventId;
                                if (data.oddsUp !== null) {
                                    this.pmOddsUp = data.oddsUp;
                                    this.pmOddsDown = data.oddsDown;
                                }
                                this.updatePolymarketUI();
                                return;
                            }
                        }
                    } catch (e) { /* continue */ }
                }

                const prevResp = await this.corsProxyFetch(`${this.GAMMA_API}/events?slug=${prevSlug}`);
                if (prevResp) {
                    const prevEvents = await prevResp.json();
                    if (prevEvents && prevEvents.length > 0) {
                        this.pmWindowStart = windowStart - 300;
                        this.pmWindowEnd = windowStart;
                        await this.processPolymarketEvent(prevEvents[0]);
                        return;
                    }
                }
                statusEl.textContent = 'No active 5m market found. Retrying...';
                setTimeout(() => this.fetchPolymarketData(), 15000);
                return;
            }

            await this.processPolymarketEvent(events[0]);
        } catch (err) {
            console.error('[Polymarket] Error:', err);
            statusEl.textContent = 'Error loading Polymarket data';
        }
    },

    /** Process a Polymarket event and extract priceToBeat (Gamma API fallback) */
    async processPolymarketEvent(event) {
        const statusEl = document.getElementById('pmStatus');
        const contentEl = document.getElementById('pmContent');

        this.pmEventId = event.id;

        // Extract odds from the first market
        const markets = event.markets || [];
        if (markets.length > 0) {
            const market = markets[0];
            const prices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
            this.pmOddsUp = parseFloat(prices[0]);
            this.pmOddsDown = parseFloat(prices[1]);
        }

        // Try to get priceToBeat from event detail endpoint
        const detailUrl = `${this.GAMMA_API}/events/${event.id}`;
        const detailResp = await this.corsProxyFetch(detailUrl);
        if (detailResp) {
            const detail = await detailResp.json();
            const meta = detail.eventMetadata || {};
            if (meta.priceToBeat) {
                this.pmPriceToBeat = meta.priceToBeat;
            }
        }

        // If priceToBeat still not found, try page scrape as last resort
        if (!this.pmPriceToBeat && window.location.protocol !== 'file:') {
            try {
                const slug = `btc-updown-5m-${this.pmWindowStart}`;
                const scrapeResp = await fetch(`/api/pm-price/${slug}`, { signal: AbortSignal.timeout(15000) });
                if (scrapeResp.ok) {
                    const data = await scrapeResp.json();
                    if (data.priceToBeat) {
                        this.pmPriceToBeat = data.priceToBeat;
                    }
                }
            } catch (e) { /* continue */ }
        }

        // Show what we have
        if (!this.pmPriceToBeat) {
            statusEl.textContent = 'Market found but price not yet set';
            if (this.pmOddsUp !== null) {
                this.updatePolymarketUI();
            }
            return;
        }

        this.updatePolymarketUI();
    },

    /** Update the Polymarket card UI */
    updatePolymarketUI() {
        const statusEl = document.getElementById('pmStatus');
        const contentEl = document.getElementById('pmContent');

        statusEl.style.display = 'none';
        contentEl.style.display = 'block';

        // Price to beat
        if (this.pmPriceToBeat) {
            document.getElementById('pmPriceToBeat').textContent =
                '$' + this.pmPriceToBeat.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
        }

        // Odds
        if (this.pmOddsUp !== null) {
            document.getElementById('pmOddsUp').textContent =
                (this.pmOddsUp * 100).toFixed(1) + '%';
            document.getElementById('pmOddsDown').textContent =
                (this.pmOddsDown * 100).toFixed(1) + '%';
        }

        // Meta info
        const windowTime = new Date(this.pmWindowStart * 1000);
        const endTime = new Date(this.pmWindowEnd * 1000);
        document.getElementById('pmMeta').textContent =
            `Window: ${windowTime.toLocaleTimeString()} – ${endTime.toLocaleTimeString()} | Source: Polymarket/Chainlink`;

        // Update countdown immediately
        this.updatePolymarketCountdown();
    },

    /** Update the countdown timer every second */
    updatePolymarketCountdown() {
        if (!this.pmWindowEnd) return;

        const now = Math.floor(Date.now() / 1000);
        const remaining = this.pmWindowEnd - now;

        const countdownEl = document.getElementById('pmCountdown');

        if (remaining <= 0) {
            countdownEl.textContent = '00:00';
            countdownEl.style.color = '#ef4444';

            // === Verify prediction before resetting window ===
            if (this.pmTracker.currentPrediction) {
                this.verifyPmPrediction();
            }

            // Window expired — fetch new window data
            // Small delay to let the new market be created
            clearInterval(this.pmCountdownInterval);
            // Reset analysis flags for the new window
            this.pmTracker.analysisScheduled = false;
            this.pmTracker.dataReady = false;
            setTimeout(() => {
                this.pmPriceToBeat = null;
                this.pmEventId = null;
                this.pmOddsUp = null;
                this.pmOddsDown = null;
                document.getElementById('pmStatus').style.display = 'block';
                document.getElementById('pmStatus').textContent = 'Fetching new 5m window...';
                document.getElementById('pmContent').style.display = 'none';
                countdownEl.style.color = '#8b5cf6';
                this.fetchPolymarketData().then(() => {
                    // Mark data as ready — analysis will be triggered by countdown at 4:55
                    this.pmTracker.dataReady = true;
                    console.log('[PM Tracker] Data ready, waiting for 4:55 on countdown to start analysis');
                });
                this.pmCountdownInterval = setInterval(() => this.updatePolymarketCountdown(), 1000);
            }, 5000);
            return;
        }

        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        countdownEl.textContent =
            String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');

        // === Auto-trigger 20s analysis at exactly 4:55 remaining (5s into window) ===
        // remaining 295 = 4:55, remaining 300 = 5:00
        if (remaining <= 295 && remaining >= 275 &&
            this.pmTracker.active && this.pmTracker.dataReady &&
            !this.pmTracker.analysisScheduled && !this.pmTracker.currentPrediction) {
            this.pmTracker.analysisScheduled = true;
            console.log(`[PM Tracker] Countdown at ${mins}:${String(secs).padStart(2, '0')} — starting 20s analysis`);
            this.autoRecordPmPrediction();
        }

        // Flash warning when < 30 seconds
        if (remaining < 30) {
            countdownEl.style.color = '#eab308';
        } else {
            countdownEl.style.color = '#8b5cf6';
        }
    },

    /** Refresh just the odds (not the full event) */
    async refreshPolymarketOdds() {
        if (!this.pmEventId) return;

        try {
            const slug = `btc-updown-5m-${this.pmWindowStart}`;
            const url = `${this.GAMMA_API}/events?slug=${slug}`;
            const resp = await this.corsProxyFetch(url);
            if (!resp) return;

            const events = await resp.json();
            if (!events || events.length === 0) return;

            const markets = events[0].markets || [];
            if (markets.length > 0) {
                const prices = JSON.parse(markets[0].outcomePrices || '["0.5","0.5"]');
                this.pmOddsUp = parseFloat(prices[0]);
                this.pmOddsDown = parseFloat(prices[1]);

                document.getElementById('pmOddsUp').textContent =
                    (this.pmOddsUp * 100).toFixed(1) + '%';
                document.getElementById('pmOddsDown').textContent =
                    (this.pmOddsDown * 100).toFixed(1) + '%';
            }
        } catch (err) {
            console.warn('[Polymarket] Odds refresh failed:', err);
        }
    },

    /** Use Polymarket's priceToBeat as target price */
    usePolymarketPrice() {
        if (!this.pmPriceToBeat) return;

        // Activate tracker on first use
        if (!this.pmTracker.active) {
            this.pmTracker.active = true;
            console.log('[PM Tracker] Tracking activated');
        }

        // Set the manual price input and trigger prediction
        document.getElementById('manualPriceInput').value = this.pmPriceToBeat.toFixed(2);

        // Switch to 5m timeframe for prediction
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        const btn5m = document.querySelector('.tf-btn[data-tf="5m"]');
        if (btn5m) btn5m.classList.add('active');
        this.currentTimeframe = '5m';
        document.getElementById('predictionTfBadge').textContent = '5m';

        // Run prediction with 5m data
        this.fetchKlines('5m').then(() => {
            this.runPrediction();
            this.predictManualPrice();

            // Record prediction for tracking
            this.recordPmPrediction();
        });
    },

    // ===== Prediction Tracker (Polymarket 5m) =====

    /** Record a prediction for the current Polymarket 5m window (with full snapshot) */
    recordPmPrediction() {
        if (!this.pmPriceToBeat || !this.currentPrice || !this.pmWindowEnd) return;

        const data = this.klineData['5m'];
        if (!data || data.length < 30) return;

        const indicators = TechnicalIndicators.computeAll(data);
        const result = Predictor.predictVsPrice(indicators, this.pmPriceToBeat);

        // Determine our prediction: will BTC be >= priceToBeat at window end?
        let predictedUp;
        if (result.isTargetAbove) {
            predictedUp = result.probReachTarget > 50;
        } else {
            predictedUp = result.probReachTarget <= 50;
        }

        // Capture full indicator snapshot for learning
        const signalSnapshot = result.basePrediction.signals.map(s => ({
            name: s.name,
            signal: s.signal,
            score: s.score,
            weight: s.weight,
            value: s.value,
            description: s.description
        }));

        const factorSnapshot = result.factors.map(f => ({
            name: f.name,
            score: f.score,
            weight: f.weight
        }));

        this.pmTracker.currentPrediction = {
            priceToBeat: this.pmPriceToBeat,
            currentPriceAtPrediction: this.currentPrice,
            predictedUp,
            probReachTarget: result.probReachTarget,
            isTargetAbove: result.isTargetAbove,
            distancePct: result.distancePct,
            confidence: result.confidence,
            avgScore: result.basePrediction.avgScore,
            windowStart: this.pmWindowStart,
            windowEnd: this.pmWindowEnd,
            timestamp: Date.now(),
            // Full snapshots for self-learning
            signalSnapshot,
            factorSnapshot
        };

        console.log('[PM Tracker] Prediction recorded:', {
            priceToBeat: this.pmPriceToBeat,
            predictedUp,
            probReachTarget: result.probReachTarget,
            signals: signalSnapshot.length,
            windowEnd: new Date(this.pmWindowEnd * 1000).toLocaleTimeString()
        });

        this.updatePmTrackerUI();
    },

    /** Verify the prediction when the 5m window expires — with per-indicator analysis */
    verifyPmPrediction() {
        const pred = this.pmTracker.currentPrediction;
        if (!pred || !this.currentPrice) return;

        const actualUp = this.currentPrice >= pred.priceToBeat;
        const correct = pred.predictedUp === actualUp;

        // Analyze each indicator: was it aligned with the actual outcome?
        const indicatorResults = [];
        if (pred.signalSnapshot) {
            for (const sig of pred.signalSnapshot) {
                // An indicator was "correct" if its signal matched the actual direction
                let indicatorCorrect;
                if (sig.signal === 'buy') {
                    indicatorCorrect = actualUp;
                } else if (sig.signal === 'sell') {
                    indicatorCorrect = !actualUp;
                } else {
                    indicatorCorrect = null; // Neutral — can't judge
                }
                indicatorResults.push({
                    name: sig.name,
                    signal: sig.signal,
                    score: sig.score,
                    weight: sig.weight,
                    correct: indicatorCorrect
                });

                // Update per-indicator accuracy
                if (indicatorCorrect !== null) {
                    if (!this.pmTracker.indicatorAccuracy[sig.name]) {
                        this.pmTracker.indicatorAccuracy[sig.name] = { right: 0, wrong: 0, total: 0 };
                    }
                    const acc = this.pmTracker.indicatorAccuracy[sig.name];
                    acc.total++;
                    if (indicatorCorrect) acc.right++;
                    else acc.wrong++;
                }
            }
        }

        // Analyze each factor
        const factorResults = [];
        if (pred.factorSnapshot) {
            for (const f of pred.factorSnapshot) {
                // Factor was favorable if score > 0.5 (aligned with reaching target)
                const factorFavorable = f.score > 0.5;
                // Actual: did price actually reach the target direction?
                const actualReached = pred.isTargetAbove ? actualUp : !actualUp;
                const factorCorrect = factorFavorable === actualReached;

                factorResults.push({
                    name: f.name,
                    score: f.score,
                    weight: f.weight,
                    correct: factorCorrect
                });

                if (!this.pmTracker.factorAccuracy[f.name]) {
                    this.pmTracker.factorAccuracy[f.name] = { right: 0, wrong: 0, total: 0, totalScore: 0 };
                }
                const fa = this.pmTracker.factorAccuracy[f.name];
                fa.total++;
                fa.totalScore += f.score;
                if (factorCorrect) fa.right++;
                else fa.wrong++;
            }
        }

        const fullResult = {
            priceToBeat: pred.priceToBeat,
            predictedUp: pred.predictedUp,
            actualUp,
            actualPrice: this.currentPrice,
            correct,
            probReachTarget: pred.probReachTarget,
            confidence: pred.confidence,
            distancePct: pred.distancePct,
            avgScore: pred.avgScore,
            timestamp: Date.now(),
            windowStart: pred.windowStart,
            windowEnd: pred.windowEnd,
            indicatorResults,
            factorResults
        };

        this.pmTracker.results.push(fullResult);
        this.pmTracker.predictionLog.push(fullResult);
        this.pmTracker.currentPrediction = null;

        console.log(`[PM Tracker] Result: ${correct ? '✅ RIGHT' : '❌ WRONG'} | ` +
            `Predicted: ${pred.predictedUp ? 'UP' : 'DOWN'}, ` +
            `Actual: ${actualUp ? 'UP' : 'DOWN'} | ` +
            `Price: $${this.currentPrice.toFixed(2)} vs Target: $${pred.priceToBeat.toFixed(2)}`);

        // Calculate success rate
        if (this.pmTracker.results.length >= 10) {
            const rightCount = this.pmTracker.results.filter(r => r.correct).length;
            this.pmTracker.successRate = Math.round((rightCount / this.pmTracker.results.length) * 100);

            // Run self-learning every 5 predictions after the first 10
            if (this.pmTracker.results.length >= 10 && this.pmTracker.results.length % 5 === 0) {
                this.selfLearn();
            }
        }

        this.updatePmTrackerUI();
        this.updatePmLogUI();
    },

    /** Self-learning engine: analyze patterns and adjust weights */
    selfLearn() {
        const tracker = this.pmTracker;
        const results = tracker.results;
        if (results.length < 10) return;

        tracker.learningCycles++;
        console.log(`[Self-Learn] Cycle #${tracker.learningCycles} — Analyzing ${results.length} predictions...`);

        const insights = [];
        const LEARNING_RATE = 0.15; // How aggressively to adjust weights

        // === 1. Analyze per-indicator accuracy and adjust weights ===
        const indicatorAdj = {};
        for (const [name, acc] of Object.entries(tracker.indicatorAccuracy)) {
            if (acc.total < 5) continue; // Need enough data
            const accuracy = acc.right / acc.total;
            const indicatorKey = this.getIndicatorKey(name);
            if (!indicatorKey) continue;

            const currentWeight = Predictor.weights[indicatorKey];
            const defaultWeight = Predictor.defaultWeights[indicatorKey];

            if (accuracy >= 0.65) {
                // Performing well — increase weight
                const boost = defaultWeight * LEARNING_RATE * (accuracy - 0.5);
                indicatorAdj[indicatorKey] = currentWeight + boost;
                insights.push({
                    type: 'positive',
                    text: `${name}: ${(accuracy * 100).toFixed(0)}% accurate (${acc.right}/${acc.total}) — weight increased`,
                    accuracy
                });
            } else if (accuracy < 0.4) {
                // Performing poorly — decrease weight
                const reduction = defaultWeight * LEARNING_RATE * (0.5 - accuracy);
                indicatorAdj[indicatorKey] = currentWeight - reduction;
                insights.push({
                    type: 'negative',
                    text: `${name}: ${(accuracy * 100).toFixed(0)}% accurate (${acc.right}/${acc.total}) — weight decreased`,
                    accuracy
                });
            } else {
                insights.push({
                    type: 'neutral',
                    text: `${name}: ${(accuracy * 100).toFixed(0)}% accurate (${acc.right}/${acc.total}) — neutral`,
                    accuracy
                });
            }
        }

        // === 2. Analyze per-factor accuracy and adjust factor weights ===
        const factorAdj = {};
        for (const [name, fa] of Object.entries(tracker.factorAccuracy)) {
            if (fa.total < 5) continue;
            const accuracy = fa.right / fa.total;

            const currentWeight = Predictor.factorWeights[name];
            const defaultWeight = Predictor.defaultFactorWeights[name];
            if (!currentWeight) continue;

            if (accuracy >= 0.6) {
                const boost = defaultWeight * LEARNING_RATE * (accuracy - 0.5);
                factorAdj[name] = currentWeight + boost;
                insights.push({
                    type: 'positive',
                    text: `Factor "${name}": ${(accuracy * 100).toFixed(0)}% accurate — weight boosted`,
                    accuracy
                });
            } else if (accuracy < 0.4) {
                const reduction = defaultWeight * LEARNING_RATE * (0.5 - accuracy);
                factorAdj[name] = currentWeight - reduction;
                insights.push({
                    type: 'negative',
                    text: `Factor "${name}": ${(accuracy * 100).toFixed(0)}% accurate — weight reduced`,
                    accuracy
                });
            }
        }

        // === 3. Pattern analysis on wrong predictions ===
        const wrongPreds = results.filter(r => !r.correct);
        const rightPreds = results.filter(r => r.correct);

        if (wrongPreds.length >= 3) {
            // Check if wrong predictions cluster around certain confidence levels
            const wrongConfAvg = wrongPreds.reduce((s, r) => s + (r.confidence || 0), 0) / wrongPreds.length;
            const rightConfAvg = rightPreds.length > 0
                ? rightPreds.reduce((s, r) => s + (r.confidence || 0), 0) / rightPreds.length : 0;

            if (wrongConfAvg > rightConfAvg) {
                insights.push({
                    type: 'warning',
                    text: `High-confidence predictions tend to be wrong (avg wrong: ${wrongConfAvg.toFixed(0)}% vs right: ${rightConfAvg.toFixed(0)}%) — overconfidence detected`
                });
            }

            // Check distance pattern: are wrong predictions associated with small price distances?
            const wrongDistAvg = wrongPreds.reduce((s, r) => s + Math.abs(r.distancePct || 0), 0) / wrongPreds.length;
            const rightDistAvg = rightPreds.length > 0
                ? rightPreds.reduce((s, r) => s + Math.abs(r.distancePct || 0), 0) / rightPreds.length : 0;

            if (wrongDistAvg < 0.05 && rightDistAvg > wrongDistAvg) {
                insights.push({
                    type: 'warning',
                    text: `Wrong predictions cluster near tiny price movements (avg ${(wrongDistAvg).toFixed(4)}%) — noise zone`
                });
            }
        }

        // === 4. Apply weight adjustments ===
        if (Object.keys(indicatorAdj).length > 0 || Object.keys(factorAdj).length > 0) {
            // Capture old weights for comparison
            const oldIndicatorWeights = {};
            for (const key of Object.keys(indicatorAdj)) {
                oldIndicatorWeights[key] = Predictor.weights[key];
            }
            const oldFactorWeights = {};
            for (const key of Object.keys(factorAdj)) {
                oldFactorWeights[key] = Predictor.factorWeights[key];
            }

            Predictor.applyWeightAdjustments(indicatorAdj, factorAdj);

            // Log what changed with old → new values
            const changeDetails = [];
            for (const key of Object.keys(indicatorAdj)) {
                const oldW = oldIndicatorWeights[key].toFixed(3);
                const newW = Predictor.weights[key].toFixed(3);
                if (oldW !== newW) {
                    changeDetails.push(`${key}: ${oldW} → ${newW}`);
                }
            }
            for (const key of Object.keys(factorAdj)) {
                const oldW = oldFactorWeights[key].toFixed(3);
                const newW = Predictor.factorWeights[key].toFixed(3);
                if (oldW !== newW) {
                    changeDetails.push(`${key}: ${oldW} → ${newW}`);
                }
            }

            tracker.weightAdjustments.push({
                cycle: tracker.learningCycles,
                timestamp: Date.now(),
                indicatorAdj: { ...indicatorAdj },
                factorAdj: { ...factorAdj },
                changeDetails,
                totalPredictions: results.length,
                currentSuccessRate: tracker.successRate
            });

            // Add a confirmation insight showing weights were applied
            insights.push({
                type: 'applied',
                text: `✅ Cycle #${tracker.learningCycles}: ${changeDetails.length} weight(s) updated — next prediction will use new weights`
            });

            if (changeDetails.length > 0) {
                insights.push({
                    type: 'applied',
                    text: `Weight changes: ${changeDetails.slice(0, 4).join(', ')}${changeDetails.length > 4 ? ` (+${changeDetails.length - 4} more)` : ''}`
                });
            }

            console.log('[Self-Learn] Weight adjustments APPLIED:', {
                indicators: indicatorAdj,
                factors: factorAdj,
                changes: changeDetails
            });
        } else {
            insights.push({
                type: 'neutral',
                text: `Cycle #${tracker.learningCycles}: No weight changes needed (all indicators within normal accuracy range)`
            });
        }

        // Store insights
        tracker.learningInsights = insights;
        console.log(`[Self-Learn] Generated ${insights.length} insights`);

        this.updatePmLogUI();
    },

    /** Map indicator display name to weight key */
    getIndicatorKey(name) {
        const map = {
            'RSI (14)': 'rsi',
            'MACD': 'macd',
            'MACD Histogram': 'macdHistogram',
            'Bollinger %B': 'bollingerBands',
            'ADX (14)': 'adx',
            'Stochastic': 'stochastic',
            'Williams %R': 'williamsR',
            'Momentum (10)': 'momentum',
            'OBV Trend': 'obvTrend',
            'EMA Cross (9/21)': 'emaCross',
            'VWAP': 'vwap',
            'TRIX': 'trix',
            'ROCR (6)': 'rocr',
            'Price vs SMA50': 'priceVsSma'
        };
        return map[name] || null;
    },

    /** Update the prediction log UI */
    updatePmLogUI() {
        const logEl = document.getElementById('pmLogSection');
        if (!logEl) return;

        const tracker = this.pmTracker;
        logEl.style.display = 'block';

        // Update learning cycle count
        const cycleEl = document.getElementById('pmLearnCycles');
        if (cycleEl) cycleEl.textContent = tracker.learningCycles;

        // Render indicator accuracy table
        const accTableEl = document.getElementById('pmIndicatorAccuracy');
        if (accTableEl) {
            const entries = Object.entries(tracker.indicatorAccuracy)
                .filter(([, a]) => a.total >= 2)
                .sort((a, b) => (b[1].right / b[1].total) - (a[1].right / a[1].total));

            accTableEl.innerHTML = entries.map(([name, acc]) => {
                const pct = acc.total > 0 ? Math.round((acc.right / acc.total) * 100) : 0;
                const cls = pct >= 60 ? 'acc-good' : pct < 40 ? 'acc-bad' : 'acc-mid';
                const key = this.getIndicatorKey(name);
                const w = key ? Predictor.weights[key].toFixed(2) : '--';
                return `<div class="acc-row ${cls}">
                    <span class="acc-name">${name}</span>
                    <span class="acc-pct">${pct}%</span>
                    <span class="acc-detail">${acc.right}/${acc.total}</span>
                    <span class="acc-weight">w:${w}</span>
                </div>`;
            }).join('');
        }

        // Render factor accuracy
        const facTableEl = document.getElementById('pmFactorAccuracy');
        if (facTableEl) {
            const entries = Object.entries(tracker.factorAccuracy)
                .filter(([, a]) => a.total >= 2)
                .sort((a, b) => (b[1].right / b[1].total) - (a[1].right / a[1].total));

            facTableEl.innerHTML = entries.map(([name, fa]) => {
                const pct = fa.total > 0 ? Math.round((fa.right / fa.total) * 100) : 0;
                const cls = pct >= 60 ? 'acc-good' : pct < 40 ? 'acc-bad' : 'acc-mid';
                const w = Predictor.factorWeights[name] ? Predictor.factorWeights[name].toFixed(2) : '--';
                return `<div class="acc-row ${cls}">
                    <span class="acc-name">${name}</span>
                    <span class="acc-pct">${pct}%</span>
                    <span class="acc-detail">${fa.right}/${fa.total}</span>
                    <span class="acc-weight">w:${w}</span>
                </div>`;
            }).join('');
        }

        // Render insights
        const insightsEl = document.getElementById('pmLearningInsights');
        if (insightsEl) {
            insightsEl.innerHTML = tracker.learningInsights
                .slice(-8)
                .map(i => {
                    const icon = i.type === 'positive' ? '📈' : i.type === 'negative' ? '📉' : i.type === 'warning' ? '⚠️' : i.type === 'applied' ? '✅' : 'ℹ️';
                    return `<div class="insight-row insight-${i.type}">${icon} ${i.text}</div>`;
                }).join('');
        }

        // Render recent prediction log
        const logListEl = document.getElementById('pmPredictionLogList');
        if (logListEl) {
            const recent = tracker.predictionLog.slice(-5).reverse();
            logListEl.innerHTML = recent.map(r => {
                const time = new Date(r.timestamp).toLocaleTimeString();
                const icon = r.correct ? '✅' : '❌';
                const dir = r.predictedUp ? 'UP' : 'DOWN';
                const actual = r.actualUp ? 'UP' : 'DOWN';
                const delta = (r.actualPrice - r.priceToBeat).toFixed(2);
                return `<div class="log-entry ${r.correct ? 'log-right' : 'log-wrong'}">
                    <span class="log-icon">${icon}</span>
                    <span class="log-time">${time}</span>
                    <span class="log-pred">Pred: ${dir}</span>
                    <span class="log-actual">Act: ${actual}</span>
                    <span class="log-delta">Δ$${delta}</span>
                    <span class="log-prob">${r.probReachTarget}%</span>
                </div>`;
            }).join('');
        }
    },

    /** Auto-record prediction for new window (after tracking is activated)
     *  Waits 20 seconds to allow indicators to use fresher data */
    autoRecordPmPrediction() {
        if (!this.pmTracker.active) return;
        if (!this.pmPriceToBeat || !this.currentPrice) return;

        // Clear any existing delay timer
        if (this.pmTracker.delayTimer) {
            clearInterval(this.pmTracker.delayTimer);
            this.pmTracker.delayTimer = null;
        }

        const DELAY_SECONDS = 20;
        let remaining = DELAY_SECONDS;

        // Show countdown in tracker UI
        const currentPredEl = document.getElementById('pmTrackerCurrentPred');
        if (currentPredEl) {
            currentPredEl.innerHTML = `<span class="tracker-current-label">⏳ Analyzing market data... <strong>${remaining}s</strong></span>`;
        }

        console.log(`[PM Tracker] Waiting ${DELAY_SECONDS}s before recording prediction...`);

        this.pmTracker.delayTimer = setInterval(() => {
            remaining--;
            if (currentPredEl) {
                currentPredEl.innerHTML = `<span class="tracker-current-label">⏳ Analyzing market data... <strong>${remaining}s</strong></span>`;
            }

            if (remaining <= 0) {
                clearInterval(this.pmTracker.delayTimer);
                this.pmTracker.delayTimer = null;

                // Refresh Polymarket odds + fetch fresh 5m kline data simultaneously
                Promise.all([
                    this.fetchKlines('5m'),
                    this.refreshPolymarketOdds()
                ]).then(() => {
                    const data = this.klineData['5m'];
                    if (!data || data.length < 30) return;

                    // Update the target prediction UI with fresh data BEFORE recording
                    if (this.pmPriceToBeat) {
                        document.getElementById('manualPriceInput').value = this.pmPriceToBeat.toFixed(2);
                        this.frozenPrice = this.pmPriceToBeat;
                        document.getElementById('frozenPrice').textContent =
                            '$' + this.pmPriceToBeat.toLocaleString('en-US', { minimumFractionDigits: 2 });

                        // Run fresh target prediction to update Up/Down % in UI
                        this.runTargetPrediction(this.pmPriceToBeat);

                        // Also run/refresh the main 5m prediction display
                        this.runPrediction();
                    }

                    // Now record the prediction (uses the just-computed fresh indicators)
                    this.recordPmPrediction();

                    console.log('[PM Tracker] Prediction recorded after 20s delay with fresh data + updated odds');
                });
            }
        }, 1000);
    },

    /** Update the tracker UI display */
    updatePmTrackerUI() {
        const trackerEl = document.getElementById('pmTrackerSection');
        if (!trackerEl) return;

        const results = this.pmTracker.results;
        const rightCount = results.filter(r => r.correct).length;
        const wrongCount = results.filter(r => !r.correct).length;
        const total = results.length;
        const pred = this.pmTracker.currentPrediction;

        // Show tracker section
        trackerEl.style.display = 'block';

        // Update counters
        document.getElementById('pmTrackerRight').textContent = rightCount;
        document.getElementById('pmTrackerWrong').textContent = wrongCount;
        document.getElementById('pmTrackerTotal').textContent = total;

        // Update current prediction indicator
        const currentPredEl = document.getElementById('pmTrackerCurrentPred');
        if (pred) {
            currentPredEl.innerHTML = `<span class="tracker-current-label">Current:</span> ` +
                `<span class="tracker-pred-badge ${pred.predictedUp ? 'pred-up' : 'pred-down'}">` +
                `${pred.predictedUp ? '▲ UP' : '▼ DOWN'}</span>` +
                `<span class="tracker-prob">(${pred.probReachTarget}%)</span>`;
        } else {
            currentPredEl.innerHTML = `<span class="tracker-current-label">Waiting for next window...</span>`;
        }

        // Success rate display
        const rateEl = document.getElementById('pmTrackerRate');
        const rateBarEl = document.getElementById('pmTrackerRateBar');
        if (total >= 10) {
            const rate = this.pmTracker.successRate;
            rateEl.style.display = 'block';
            document.getElementById('pmTrackerRateValue').textContent = rate + '%';
            document.getElementById('pmTrackerRateCount').textContent = `(${total} predictions)`;
            rateBarEl.style.width = rate + '%';
            // Color based on rate
            if (rate >= 60) {
                rateBarEl.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
            } else if (rate >= 50) {
                rateBarEl.style.background = 'linear-gradient(90deg, #eab308, #fbbf24)';
            } else {
                rateBarEl.style.background = 'linear-gradient(90deg, #ef4444, #f87171)';
            }
        } else {
            rateEl.style.display = 'block';
            document.getElementById('pmTrackerRateValue').textContent = '--';
            document.getElementById('pmTrackerRateCount').textContent = `(${total}/10 to calculate)`;
            rateBarEl.style.width = '0%';
        }

        // Update recent results history
        const historyEl = document.getElementById('pmTrackerHistory');
        historyEl.innerHTML = '';
        const recentResults = results.slice(-10).reverse(); // Show last 10, newest first
        for (const r of recentResults) {
            const dot = document.createElement('span');
            dot.className = `tracker-dot ${r.correct ? 'dot-right' : 'dot-wrong'}`;
            dot.title = `${r.correct ? '✅' : '❌'} ${r.predictedUp ? 'UP' : 'DOWN'} | ` +
                `Price: $${r.actualPrice.toFixed(2)} vs $${r.priceToBeat.toFixed(2)} | ` +
                `${new Date(r.timestamp).toLocaleTimeString()}`;
            historyEl.appendChild(dot);
        }
        // Fill remaining dots as empty
        for (let i = recentResults.length; i < 10; i++) {
            const dot = document.createElement('span');
            dot.className = 'tracker-dot dot-empty';
            historyEl.appendChild(dot);
        }
    },

    // ===== Formatting Helpers =====

    formatPrice(price) {
        return '$' + price.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }
};

// ===== Start Application =====
document.addEventListener('DOMContentLoaded', () => {
    App.init().catch(err => {
        console.error('[App Init Error]:', err);
    });
});