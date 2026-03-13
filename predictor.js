/**
 * BTC Price Movement Predictor Engine
 * 
 * Ensemble scoring system inspired by:
 * - BitVision: Logistic regression with 20+ technical indicators
 * - pratikpv: LSTM with sentiment + OHLCV features
 * - TatevKaren: Stacked LSTM momentum patterns
 * - stefmolin: Bollinger/MACD/RSI analysis
 * 
 * Each indicator casts a weighted vote (bullish/neutral/bearish).
 * Votes are aggregated into a probability score.
 */

const Predictor = {

    // Default indicator weights (inspired by BitVision's feature importance)
    defaultWeights: {
        rsi: 1.2,
        macd: 1.5,
        macdHistogram: 1.3,
        bollingerBands: 1.1,
        adx: 1.0,
        stochastic: 1.1,
        williamsR: 0.9,
        momentum: 1.3,
        obvTrend: 1.0,
        emaCross: 1.4,
        vwap: 1.0,
        trix: 0.8,
        rocr: 0.9,
        priceVsSma: 1.2
    },

    // Adaptive weights (modified by self-learning engine)
    weights: {
        rsi: 1.2,
        macd: 1.5,
        macdHistogram: 1.3,
        bollingerBands: 1.1,
        adx: 1.0,
        stochastic: 1.1,
        williamsR: 0.9,
        momentum: 1.3,
        obvTrend: 1.0,
        emaCross: 1.4,
        vwap: 1.0,
        trix: 0.8,
        rocr: 0.9,
        priceVsSma: 1.2
    },

    // Default factor weights for predictVsPrice
    // Priority: Volatility=100%, Historical Frequency=100%, TA=65%, Bollinger=50%, rest<50%
    defaultFactorWeights: {
        'TA Indicators': 3.25,          // 65% priority
        'ATR Reachability': 2.0,        // <50% priority
        'Historical Frequency': 5.0,    // 100% priority (highest)
        'Bollinger Position': 2.5,      // 50% priority
        'Support/Resistance': 2.0,      // <50% priority
        'Volatility': 5.0,             // 100% priority (highest)
        'Mean Reversion': 1.5           // <50% priority
    },

    // Adaptive factor weights (modified by self-learning)
    factorWeights: {
        'TA Indicators': 3.25,          // 65% priority
        'ATR Reachability': 2.0,        // <50% priority
        'Historical Frequency': 5.0,    // 100% priority (highest)
        'Bollinger Position': 2.5,      // 50% priority
        'Support/Resistance': 2.0,      // <50% priority
        'Volatility': 5.0,             // 100% priority (highest)
        'Mean Reversion': 1.5           // <50% priority
    },

    /**
     * Apply weight adjustments from self-learning engine
     * @param {Object} indicatorAdj - { indicatorKey: newWeight, ... }
     * @param {Object} factorAdj - { factorName: newWeight, ... }
     */
    applyWeightAdjustments(indicatorAdj, factorAdj) {
        if (indicatorAdj) {
            for (const [key, val] of Object.entries(indicatorAdj)) {
                if (this.weights.hasOwnProperty(key)) {
                    // Clamp weights between 0.1 and 3.0
                    this.weights[key] = Math.max(0.1, Math.min(3.0, val));
                }
            }
        }
        if (factorAdj) {
            for (const [key, val] of Object.entries(factorAdj)) {
                if (this.factorWeights.hasOwnProperty(key)) {
                    this.factorWeights[key] = Math.max(0.1, Math.min(5.0, val));
                }
            }
        }
    },

    /** Reset weights to defaults */
    resetWeights() {
        this.weights = { ...this.defaultWeights };
        this.factorWeights = { ...this.defaultFactorWeights };
    },

    /**
     * Get the last valid (non-null) value from an array
     */
    lastValid(arr) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
                return arr[i];
            }
        }
        return null;
    },

    /**
     * Get last N valid values
     */
    lastNValid(arr, n) {
        const result = [];
        for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
            if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
                result.unshift(arr[i]);
            }
        }
        return result;
    },

    /**
     * Analyze all indicators and produce signals
     * Returns array of { name, value, signal, score, weight }
     * signal: 'buy' | 'sell' | 'neutral'
     * score: -1 to 1 (bearish to bullish)
     */
    analyzeIndicators(indicators) {
        const signals = [];
        const closes = indicators.closes;
        const lastClose = closes[closes.length - 1];

        // 1. RSI Analysis (BitVision feature)
        const rsiVal = this.lastValid(indicators.rsi);
        if (rsiVal !== null) {
            let score = 0;
            let signal = 'neutral';
            if (rsiVal < 30) {
                score = 0.8; // Oversold = bullish reversal expected
                signal = 'buy';
            } else if (rsiVal < 40) {
                score = 0.4;
                signal = 'buy';
            } else if (rsiVal > 70) {
                score = -0.8; // Overbought = bearish reversal expected
                signal = 'sell';
            } else if (rsiVal > 60) {
                score = -0.4;
                signal = 'sell';
            } else {
                // 40-60 range: slight bias based on direction
                const rsiPrev = this.lastNValid(indicators.rsi, 3);
                if (rsiPrev.length >= 2) {
                    score = rsiPrev[rsiPrev.length - 1] > rsiPrev[0] ? 0.15 : -0.15;
                    signal = score > 0 ? 'buy' : 'sell';
                }
            }
            signals.push({
                name: 'RSI (14)',
                value: rsiVal.toFixed(1),
                signal, score,
                weight: this.weights.rsi,
                description: rsiVal < 30 ? 'Oversold' : rsiVal > 70 ? 'Overbought' : 'Neutral zone'
            });
        }

        // 2. MACD Analysis (BitVision + stock-analysis)
        const macdVal = this.lastValid(indicators.macd.macdLine);
        const macdSignal = this.lastValid(indicators.macd.signal);
        if (macdVal !== null && macdSignal !== null) {
            const diff = macdVal - macdSignal;
            let score = Math.tanh(diff / (Math.abs(lastClose) * 0.001)) * 0.8;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'MACD',
                value: macdVal.toFixed(2),
                signal, score,
                weight: this.weights.macd,
                description: diff > 0 ? 'Above signal' : 'Below signal'
            });
        }

        // 3. MACD Histogram momentum
        const histValues = this.lastNValid(indicators.macd.histogram, 5);
        if (histValues.length >= 3) {
            const recent = histValues[histValues.length - 1];
            const prev = histValues[histValues.length - 2];
            const trend = recent - prev;
            let score = Math.tanh(trend / (Math.abs(lastClose) * 0.0005)) * 0.7;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'MACD Histogram',
                value: recent.toFixed(2),
                signal, score,
                weight: this.weights.macdHistogram,
                description: trend > 0 ? 'Increasing' : 'Decreasing'
            });
        }

        // 4. Bollinger Bands (stock-analysis)
        const percentB = this.lastValid(indicators.bollingerBands.percentB);
        if (percentB !== null) {
            let score = 0;
            let signal = 'neutral';
            if (percentB < 0) {
                score = 0.9; // Below lower band = oversold
                signal = 'buy';
            } else if (percentB < 0.2) {
                score = 0.5;
                signal = 'buy';
            } else if (percentB > 1) {
                score = -0.9; // Above upper band = overbought
                signal = 'sell';
            } else if (percentB > 0.8) {
                score = -0.5;
                signal = 'sell';
            } else {
                // Mean reversion tendency
                score = (0.5 - percentB) * 0.4;
                signal = Math.abs(score) < 0.1 ? 'neutral' : score > 0 ? 'buy' : 'sell';
            }
            signals.push({
                name: 'Bollinger %B',
                value: (percentB * 100).toFixed(1) + '%',
                signal, score,
                weight: this.weights.bollingerBands,
                description: percentB < 0.2 ? 'Near lower band' : percentB > 0.8 ? 'Near upper band' : 'Mid band'
            });
        }

        // 5. ADX (BitVision: trend strength)
        const adxData = indicators.adx;
        const adxVal = this.lastValid(adxData.adx);
        const plusDI = this.lastValid(adxData.plusDI);
        const minusDI = this.lastValid(adxData.minusDI);
        if (adxVal !== null && plusDI !== null && minusDI !== null) {
            let score = 0;
            let signal = 'neutral';
            const trendStrength = adxVal > 25 ? 'Strong' : adxVal > 20 ? 'Moderate' : 'Weak';

            if (adxVal > 20) {
                // Strong trend - follow the DI direction
                const diDiff = plusDI - minusDI;
                score = Math.tanh(diDiff / 20) * Math.min(adxVal / 40, 1);
                signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            }
            signals.push({
                name: 'ADX (14)',
                value: adxVal.toFixed(1),
                signal, score,
                weight: this.weights.adx,
                description: `${trendStrength} trend, +DI:${plusDI.toFixed(0)} -DI:${minusDI.toFixed(0)}`
            });
        }

        // 6. Stochastic Oscillator
        const stochK = this.lastValid(indicators.stochastic.k);
        const stochD = this.lastValid(indicators.stochastic.d);
        if (stochK !== null) {
            let score = 0;
            let signal = 'neutral';
            if (stochK < 20) {
                score = 0.7;
                signal = 'buy';
            } else if (stochK < 30) {
                score = 0.3;
                signal = 'buy';
            } else if (stochK > 80) {
                score = -0.7;
                signal = 'sell';
            } else if (stochK > 70) {
                score = -0.3;
                signal = 'sell';
            } else if (stochD !== null) {
                score = (stochK - stochD) > 0 ? 0.2 : -0.2;
                signal = score > 0 ? 'buy' : 'sell';
            }
            signals.push({
                name: 'Stochastic',
                value: `${stochK.toFixed(1)}`,
                signal, score,
                weight: this.weights.stochastic,
                description: stochK < 20 ? 'Oversold' : stochK > 80 ? 'Overbought' : 'Mid range'
            });
        }

        // 7. Williams %R (BitVision: WILLR)
        const willR = this.lastValid(indicators.williamsR);
        if (willR !== null) {
            let score = 0;
            let signal = 'neutral';
            if (willR < -80) {
                score = 0.6;
                signal = 'buy';
            } else if (willR > -20) {
                score = -0.6;
                signal = 'sell';
            } else {
                score = ((willR + 50) / 50) * -0.2;
                signal = Math.abs(score) < 0.1 ? 'neutral' : score > 0 ? 'buy' : 'sell';
            }
            signals.push({
                name: 'Williams %R',
                value: willR.toFixed(1),
                signal, score,
                weight: this.weights.williamsR,
                description: willR < -80 ? 'Oversold' : willR > -20 ? 'Overbought' : 'Neutral'
            });
        }

        // 8. Momentum (BitVision: MOM)
        const momVal = this.lastValid(indicators.momentum);
        if (momVal !== null) {
            let score = Math.tanh(momVal / (lastClose * 0.02)) * 0.8;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'Momentum (10)',
                value: momVal.toFixed(2),
                signal, score,
                weight: this.weights.momentum,
                description: momVal > 0 ? 'Positive momentum' : 'Negative momentum'
            });
        }

        // 9. OBV Trend
        const obvValues = this.lastNValid(indicators.obv, 10);
        if (obvValues.length >= 5) {
            const obvSma5 = obvValues.slice(-5).reduce((a, b) => a + b, 0) / 5;
            const obvCurrent = obvValues[obvValues.length - 1];
            const obvTrend = obvCurrent - obvSma5;
            let score = Math.tanh(obvTrend / (Math.abs(obvSma5) * 0.05 + 1)) * 0.6;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'OBV Trend',
                value: this.formatLargeNum(obvCurrent),
                signal, score,
                weight: this.weights.obvTrend,
                description: obvTrend > 0 ? 'Volume confirming up' : 'Volume confirming down'
            });
        }

        // 10. EMA Cross (9/21)
        const emaFast = this.lastValid(indicators.emaCross.fast);
        const emaSlow = this.lastValid(indicators.emaCross.slow);
        if (emaFast !== null && emaSlow !== null) {
            const diff = emaFast - emaSlow;
            let score = Math.tanh(diff / (lastClose * 0.005)) * 0.8;
            score = Math.max(-1, Math.min(1, score));

            // Check for recent crossover
            const fastVals = this.lastNValid(indicators.emaCross.fast, 3);
            const slowVals = this.lastNValid(indicators.emaCross.slow, 3);
            if (fastVals.length >= 2 && slowVals.length >= 2) {
                const prevDiff = fastVals[0] - slowVals[0];
                if (prevDiff < 0 && diff > 0) score = Math.min(score + 0.3, 1); // Bullish cross
                if (prevDiff > 0 && diff < 0) score = Math.max(score - 0.3, -1); // Bearish cross
            }

            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'EMA Cross (9/21)',
                value: diff > 0 ? 'Bullish' : 'Bearish',
                signal, score,
                weight: this.weights.emaCross,
                description: diff > 0 ? 'Fast above slow' : 'Fast below slow'
            });
        }

        // 11. VWAP Position
        const vwapVal = this.lastValid(indicators.vwap);
        if (vwapVal !== null && lastClose) {
            const diff = (lastClose - vwapVal) / vwapVal;
            let score = Math.tanh(diff * 50) * 0.5;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'VWAP',
                value: vwapVal.toFixed(2),
                signal, score,
                weight: this.weights.vwap,
                description: lastClose > vwapVal ? 'Price above VWAP' : 'Price below VWAP'
            });
        }

        // 12. TRIX (BitVision: TRIX(20))
        const trixVal = this.lastValid(indicators.trix);
        if (trixVal !== null) {
            let score = Math.tanh(trixVal * 2) * 0.6;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'TRIX',
                value: trixVal.toFixed(3),
                signal, score,
                weight: this.weights.trix,
                description: trixVal > 0 ? 'Positive' : 'Negative'
            });
        }

        // 13. Rate of Change Ratio (BitVision: ROCR)
        const rocrVal = this.lastValid(indicators.rocr);
        if (rocrVal !== null) {
            const diff = rocrVal - 1;
            let score = Math.tanh(diff * 20) * 0.6;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'ROCR (6)',
                value: rocrVal.toFixed(4),
                signal, score,
                weight: this.weights.rocr,
                description: rocrVal > 1 ? 'Rising' : 'Falling'
            });
        }

        // 14. Price vs SMA (trend confirmation)
        const sma50Val = this.lastValid(indicators.sma50);
        if (sma50Val !== null && lastClose) {
            const diff = (lastClose - sma50Val) / sma50Val;
            let score = Math.tanh(diff * 30) * 0.7;
            score = Math.max(-1, Math.min(1, score));
            const signal = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
            signals.push({
                name: 'Price vs SMA50',
                value: ((lastClose / sma50Val - 1) * 100).toFixed(2) + '%',
                signal, score,
                weight: this.weights.priceVsSma,
                description: lastClose > sma50Val ? 'Above SMA50' : 'Below SMA50'
            });
        }

        return signals;
    },

    /**
     * Calculate probability of price moving up vs down
     * Uses weighted voting system (BitVision-inspired logistic approach)
     */
    predict(indicators) {
        const signals = this.analyzeIndicators(indicators);

        if (signals.length === 0) {
            return {
                probUp: 50,
                probDown: 50,
                confidence: 0,
                verdict: 'neutral',
                verdictText: 'Insufficient data',
                signals
            };
        }

        // Weighted score aggregation
        let totalWeightedScore = 0;
        let totalWeight = 0;

        for (const sig of signals) {
            totalWeightedScore += sig.score * sig.weight;
            totalWeight += sig.weight;
        }

        const avgScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

        // Convert score (-1 to 1) to probability using sigmoid function
        // (inspired by BitVision's logistic regression approach)
        const sigmoid = (x) => 1 / (1 + Math.exp(-x * 3.5));
        const probUp = sigmoid(avgScore) * 100;
        const probDown = 100 - probUp;

        // Confidence = how strongly indicators agree
        const scores = signals.map(s => s.score);
        const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((a, b) => a + Math.pow(b - meanScore, 2), 0) / scores.length;
        const agreement = 1 - Math.sqrt(variance); // Lower variance = higher agreement
        const strength = Math.abs(avgScore); // Stronger signal = higher confidence

        const confidence = Math.round(Math.min(
            (agreement * 0.5 + strength * 0.5) * 100,
            95 // Cap at 95%
        ));

        // Verdict
        let verdict, verdictText;
        if (probUp > 65) {
            verdict = 'bullish';
            verdictText = `Strong Bullish — ${probUp.toFixed(1)}% chance of moving UP`;
        } else if (probUp > 55) {
            verdict = 'bullish';
            verdictText = `Slightly Bullish — ${probUp.toFixed(1)}% chance of moving UP`;
        } else if (probDown > 65) {
            verdict = 'bearish';
            verdictText = `Strong Bearish — ${probDown.toFixed(1)}% chance of moving DOWN`;
        } else if (probDown > 55) {
            verdict = 'bearish';
            verdictText = `Slightly Bearish — ${probDown.toFixed(1)}% chance of moving DOWN`;
        } else {
            verdict = 'neutral';
            verdictText = `Neutral — No clear directional bias`;
        }

        // Signal counts
        const bullCount = signals.filter(s => s.signal === 'buy').length;
        const bearCount = signals.filter(s => s.signal === 'sell').length;
        const neutralCount = signals.filter(s => s.signal === 'neutral').length;

        return {
            probUp: Math.round(probUp * 10) / 10,
            probDown: Math.round(probDown * 10) / 10,
            confidence,
            verdict,
            verdictText,
            signals,
            bullCount,
            bearCount,
            neutralCount,
            avgScore,
            totalIndicators: signals.length
        };
    },

    /**
     * Predict probability of price going ABOVE or BELOW a specific target price
     * Uses all technical indicators + Kaggle-inspired price position analysis
     * + support/resistance + volatility to estimate probability
     */
    predictVsPrice(indicators, targetPrice) {
        // First get the standard directional prediction
        const basePrediction = this.predict(indicators);
        const signals = basePrediction.signals;

        const closes = indicators.closes;
        const currentPrice = closes[closes.length - 1];
        const isTargetAbove = targetPrice > currentPrice;
        const distancePct = ((targetPrice - currentPrice) / currentPrice) * 100;

        // === Kaggle-inspired price position analysis ===
        const pricePos = TechnicalIndicators.pricePosition(
            indicators.highs, indicators.lows, indicators.closes, targetPrice, 50
        );

        // 1. Historical frequency: how often has price been above/below target recently
        const historicalBias = isTargetAbove ? pricePos.pctAbove : pricePos.pctBelow;

        // 2. ATR-based probability: can price reach target within the timeframe?
        const atrVal = this.lastValid(indicators.atr);
        let atrReachability = 0.5;
        if (atrVal && atrVal > 0) {
            const distance = Math.abs(targetPrice - currentPrice);
            const atrRatio = distance / atrVal;
            // If distance < 1 ATR, very reachable; > 3 ATR, unlikely
            atrReachability = 1 / (1 + Math.exp((atrRatio - 1.5) * 2));
        }

        // 3. Bollinger Band position of target
        const bbUpper = this.lastValid(indicators.bollingerBands.upper);
        const bbLower = this.lastValid(indicators.bollingerBands.lower);
        let bbScore = 0.5;
        if (bbUpper && bbLower && bbUpper !== bbLower) {
            const bbPos = (targetPrice - bbLower) / (bbUpper - bbLower);
            // Target outside bands = less likely to sustain
            if (isTargetAbove) {
                bbScore = bbPos > 1 ? 0.2 : bbPos > 0.8 ? 0.35 : 0.5 + (1 - bbPos) * 0.3;
            } else {
                bbScore = bbPos < 0 ? 0.2 : bbPos < 0.2 ? 0.35 : 0.5 + bbPos * 0.3;
            }
        }

        // 4. Support/Resistance analysis
        const sr = indicators.supportResistance;
        let srScore = 0.5;
        if (isTargetAbove) {
            // Check if there's resistance between current and target
            const blockingResistance = sr.resistance.filter(
                r => r > currentPrice && r < targetPrice
            ).length;
            srScore = blockingResistance > 0 ? 0.3 : 0.6;
        } else {
            // Check if there's support between target and current
            const blockingSupport = sr.support.filter(
                s => s < currentPrice && s > targetPrice
            ).length;
            srScore = blockingSupport > 0 ? 0.3 : 0.6;
        }

        // 5. Momentum alignment: does the current trend direction match?
        let momentumAlignment = 0.5;
        const momScore = basePrediction.avgScore; // -1 to 1
        if (isTargetAbove) {
            momentumAlignment = (momScore + 1) / 2; // Convert to 0-1, higher = more bullish
        } else {
            momentumAlignment = (1 - momScore) / 2; // Invert: higher = more bearish
        }

        // 6. Historical volatility check (Kaggle feature)
        const histVol = this.lastValid(indicators.histVolatility);
        let volScore = 0.5;
        if (histVol !== null && histVol > 0) {
            const distanceInVol = Math.abs(distancePct / 100) / histVol;
            // High vol = more likely to reach distant targets
            volScore = distanceInVol < 1 ? 0.7 : distanceInVol < 2 ? 0.5 : 0.25;
        }

        // 7. Rolling mean reversion (Kaggle: rolling stats)
        const rollingMean = this.lastValid(indicators.rollingStats14.means);
        let meanReversionScore = 0.5;
        if (rollingMean) {
            if (isTargetAbove) {
                // Target above: if current price below mean, more likely to revert up
                meanReversionScore = currentPrice < rollingMean ? 0.6 : 0.4;
            } else {
                // Target below: if current price above mean, more likely to revert down
                meanReversionScore = currentPrice > rollingMean ? 0.6 : 0.4;
            }
        }

        // === Weighted ensemble of all factors (uses adaptive weights from self-learning) ===
        const fw = this.factorWeights;
        const factors = [
            { name: 'TA Indicators', score: momentumAlignment, weight: fw['TA Indicators'] },
            { name: 'ATR Reachability', score: atrReachability, weight: fw['ATR Reachability'] },
            { name: 'Historical Frequency', score: historicalBias, weight: fw['Historical Frequency'] },
            { name: 'Bollinger Position', score: bbScore, weight: fw['Bollinger Position'] },
            { name: 'Support/Resistance', score: srScore, weight: fw['Support/Resistance'] },
            { name: 'Volatility', score: volScore, weight: fw['Volatility'] },
            { name: 'Mean Reversion', score: meanReversionScore, weight: fw['Mean Reversion'] }
        ];

        let totalWeighted = 0;
        let totalWeight = 0;
        for (const f of factors) {
            totalWeighted += f.score * f.weight;
            totalWeight += f.weight;
        }

        const rawProb = totalWeight > 0 ? totalWeighted / totalWeight : 0.5;
        // Apply sigmoid smoothing to prevent extreme probabilities
        const smoothed = 0.1 + rawProb * 0.8; // Clamp to 10%-90%
        const probReachTarget = Math.round(smoothed * 1000) / 10;
        const probNotReach = Math.round((1 - smoothed) * 1000) / 10;

        // Confidence based on factor agreement
        const fScores = factors.map(f => f.score);
        const fMean = fScores.reduce((a, b) => a + b, 0) / fScores.length;
        const fVar = fScores.reduce((a, b) => a + Math.pow(b - fMean, 2), 0) / fScores.length;
        const confidence = Math.round(Math.min((1 - Math.sqrt(fVar)) * 100, 90));

        // Build verdict
        let verdict, verdictText;
        if (isTargetAbove) {
            if (probReachTarget > 60) {
                verdict = 'bullish';
                verdictText = `${probReachTarget}% chance price reaches $${targetPrice.toLocaleString()} (above current)`;
            } else if (probReachTarget > 45) {
                verdict = 'neutral';
                verdictText = `${probReachTarget}% chance of reaching $${targetPrice.toLocaleString()} — uncertain`;
            } else {
                verdict = 'bearish';
                verdictText = `Only ${probReachTarget}% chance of reaching $${targetPrice.toLocaleString()} — unlikely`;
            }
        } else {
            if (probReachTarget > 60) {
                verdict = 'bearish';
                verdictText = `${probReachTarget}% chance price drops to $${targetPrice.toLocaleString()} (below current)`;
            } else if (probReachTarget > 45) {
                verdict = 'neutral';
                verdictText = `${probReachTarget}% chance of dropping to $${targetPrice.toLocaleString()} — uncertain`;
            } else {
                verdict = 'bullish';
                verdictText = `Only ${probReachTarget}% chance of dropping to $${targetPrice.toLocaleString()} — unlikely`;
            }
        }

        return {
            targetPrice,
            currentPrice,
            isTargetAbove,
            distancePct: Math.round(distancePct * 100) / 100,
            probReachTarget,
            probNotReach,
            confidence,
            verdict,
            verdictText,
            factors,
            basePrediction
        };
    },

    /**
     * Format large numbers for display
     */
    formatLargeNum(num) {
        if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toFixed(2);
    }
};

if (typeof module !== 'undefined') {
    module.exports = Predictor;
}