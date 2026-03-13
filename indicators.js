/**
 * Technical Indicators Library
 * Inspired by BitVision's TA feature set, TatevKaren's LSTM approach,
 * and stefmolin's stock-analysis indicators.
 * 
 * All indicators computed from OHLCV kline data.
 */

const TechnicalIndicators = {

    // ===== Helper Functions =====

    /** Simple Moving Average */
    sma(data, period) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                let sum = 0;
                for (let j = i - period + 1; j <= i; j++) {
                    sum += data[j];
                }
                result.push(sum / period);
            }
        }
        return result;
    },

    /** Exponential Moving Average */
    ema(data, period) {
        const result = [];
        const multiplier = 2 / (period + 1);
        let prevEma = null;

        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else if (i === period - 1) {
                let sum = 0;
                for (let j = 0; j < period; j++) sum += data[j];
                prevEma = sum / period;
                result.push(prevEma);
            } else {
                prevEma = (data[i] - prevEma) * multiplier + prevEma;
                result.push(prevEma);
            }
        }
        return result;
    },

    /** Standard Deviation */
    stdDev(data, period) {
        const smaVals = this.sma(data, period);
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (smaVals[i] === null) {
                result.push(null);
            } else {
                let sumSq = 0;
                for (let j = i - period + 1; j <= i; j++) {
                    sumSq += Math.pow(data[j] - smaVals[i], 2);
                }
                result.push(Math.sqrt(sumSq / period));
            }
        }
        return result;
    },

    /** True Range */
    trueRange(highs, lows, closes) {
        const result = [highs[0] - lows[0]];
        for (let i = 1; i < highs.length; i++) {
            const hl = highs[i] - lows[i];
            const hc = Math.abs(highs[i] - closes[i - 1]);
            const lc = Math.abs(lows[i] - closes[i - 1]);
            result.push(Math.max(hl, hc, lc));
        }
        return result;
    },

    // ===== Indicators (from BitVision + stock-analysis) =====

    /**
     * RSI - Relative Strength Index (BitVision: used for overbought/oversold)
     * Period: 14
     */
    rsi(closes, period = 14) {
        const gains = [];
        const losses = [];

        for (let i = 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }

        const result = [null]; // first element

        let avgGain = 0, avgLoss = 0;
        // Initial averages
        for (let i = 0; i < period; i++) {
            avgGain += gains[i];
            avgLoss += losses[i];
        }
        avgGain /= period;
        avgLoss /= period;

        for (let i = 0; i < gains.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else if (i === period - 1) {
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                result.push(100 - (100 / (1 + rs)));
            } else {
                avgGain = (avgGain * (period - 1) + gains[i]) / period;
                avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                result.push(100 - (100 / (1 + rs)));
            }
        }
        return result;
    },

    /**
     * MACD - Moving Average Convergence Divergence
     * (BitVision + stock-analysis both use this)
     */
    macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const fastEma = this.ema(closes, fastPeriod);
        const slowEma = this.ema(closes, slowPeriod);

        const macdLine = [];
        for (let i = 0; i < closes.length; i++) {
            if (fastEma[i] === null || slowEma[i] === null) {
                macdLine.push(null);
            } else {
                macdLine.push(fastEma[i] - slowEma[i]);
            }
        }

        // Signal line from non-null MACD values
        const validMacd = macdLine.filter(v => v !== null);
        const signalEma = this.ema(validMacd, signalPeriod);

        const signal = [];
        let validIdx = 0;
        for (let i = 0; i < macdLine.length; i++) {
            if (macdLine[i] === null) {
                signal.push(null);
            } else {
                signal.push(signalEma[validIdx] !== undefined ? signalEma[validIdx] : null);
                validIdx++;
            }
        }

        const histogram = [];
        for (let i = 0; i < macdLine.length; i++) {
            if (macdLine[i] === null || signal[i] === null) {
                histogram.push(null);
            } else {
                histogram.push(macdLine[i] - signal[i]);
            }
        }

        return { macdLine, signal, histogram };
    },

    /**
     * Bollinger Bands (stock-analysis: key volatility indicator)
     * Period: 20, StdDev multiplier: 2
     */
    bollingerBands(closes, period = 20, mult = 2) {
        const middle = this.sma(closes, period);
        const sd = this.stdDev(closes, period);

        const upper = [], lower = [], width = [];
        for (let i = 0; i < closes.length; i++) {
            if (middle[i] === null) {
                upper.push(null);
                lower.push(null);
                width.push(null);
            } else {
                upper.push(middle[i] + mult * sd[i]);
                lower.push(middle[i] - mult * sd[i]);
                width.push(((upper[i] - lower[i]) / middle[i]) * 100);
            }
        }

        // %B - Position within bands
        const percentB = [];
        for (let i = 0; i < closes.length; i++) {
            if (upper[i] === null || lower[i] === null || upper[i] === lower[i]) {
                percentB.push(null);
            } else {
                percentB.push((closes[i] - lower[i]) / (upper[i] - lower[i]));
            }
        }

        return { upper, middle, lower, width, percentB };
    },

    /**
     * ADX - Average Directional Index (BitVision: ADX(14), ADX(20))
     * Measures trend strength
     */
    adx(highs, lows, closes, period = 14) {
        const tr = this.trueRange(highs, lows, closes);
        const plusDM = [0];
        const minusDM = [0];

        for (let i = 1; i < highs.length; i++) {
            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        const atr = this.ema(tr, period);
        const smoothPlusDM = this.ema(plusDM, period);
        const smoothMinusDM = this.ema(minusDM, period);

        const plusDI = [], minusDI = [], dx = [];
        for (let i = 0; i < highs.length; i++) {
            if (atr[i] === null || atr[i] === 0 || smoothPlusDM[i] === null) {
                plusDI.push(null);
                minusDI.push(null);
                dx.push(null);
            } else {
                const pdi = (smoothPlusDM[i] / atr[i]) * 100;
                const mdi = (smoothMinusDM[i] / atr[i]) * 100;
                plusDI.push(pdi);
                minusDI.push(mdi);
                const sum = pdi + mdi;
                dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
            }
        }

        const validDx = dx.filter(v => v !== null);
        const adxLine = this.ema(validDx, period);

        const result = [];
        let vIdx = 0;
        for (let i = 0; i < dx.length; i++) {
            if (dx[i] === null) {
                result.push(null);
            } else {
                result.push(adxLine[vIdx] !== undefined ? adxLine[vIdx] : null);
                vIdx++;
            }
        }

        return { adx: result, plusDI, minusDI };
    },

    /**
     * Stochastic Oscillator (%K, %D)
     * BitVision-inspired momentum indicator
     */
    stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
        const kValues = [];
        for (let i = 0; i < closes.length; i++) {
            if (i < kPeriod - 1) {
                kValues.push(null);
            } else {
                let highestHigh = -Infinity, lowestLow = Infinity;
                for (let j = i - kPeriod + 1; j <= i; j++) {
                    highestHigh = Math.max(highestHigh, highs[j]);
                    lowestLow = Math.min(lowestLow, lows[j]);
                }
                const range = highestHigh - lowestLow;
                kValues.push(range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100);
            }
        }

        const validK = kValues.filter(v => v !== null);
        const dEma = this.sma(validK, dPeriod);
        const dValues = [];
        let vkIdx = 0;
        for (let i = 0; i < kValues.length; i++) {
            if (kValues[i] === null) {
                dValues.push(null);
            } else {
                dValues.push(dEma[vkIdx] !== undefined ? dEma[vkIdx] : null);
                vkIdx++;
            }
        }

        return { k: kValues, d: dValues };
    },

    /**
     * Williams %R (BitVision: WILLR)
     */
    williamsR(highs, lows, closes, period = 14) {
        const result = [];
        for (let i = 0; i < closes.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                let hh = -Infinity, ll = Infinity;
                for (let j = i - period + 1; j <= i; j++) {
                    hh = Math.max(hh, highs[j]);
                    ll = Math.min(ll, lows[j]);
                }
                const range = hh - ll;
                result.push(range === 0 ? -50 : ((hh - closes[i]) / range) * -100);
            }
        }
        return result;
    },

    /**
     * ATR - Average True Range (BitVision: ATR(14))
     * Volatility measure
     */
    atr(highs, lows, closes, period = 14) {
        const tr = this.trueRange(highs, lows, closes);
        return this.ema(tr, period);
    },

    /**
     * OBV - On Balance Volume (BitVision feature)
     */
    obv(closes, volumes) {
        const result = [0];
        for (let i = 1; i < closes.length; i++) {
            if (closes[i] > closes[i - 1]) {
                result.push(result[i - 1] + volumes[i]);
            } else if (closes[i] < closes[i - 1]) {
                result.push(result[i - 1] - volumes[i]);
            } else {
                result.push(result[i - 1]);
            }
        }
        return result;
    },

    /**
     * MOM - Momentum (BitVision: MOM(1), MOM(3))
     */
    momentum(closes, period = 10) {
        const result = [];
        for (let i = 0; i < closes.length; i++) {
            if (i < period) {
                result.push(null);
            } else {
                result.push(closes[i] - closes[i - period]);
            }
        }
        return result;
    },

    /**
     * TRIX - Triple Exponential Moving Average (BitVision: TRIX(20))
     */
    trix(closes, period = 15) {
        const ema1 = this.ema(closes, period);
        const validEma1 = ema1.filter(v => v !== null);
        const ema2 = this.ema(validEma1, period);
        const validEma2 = ema2.filter(v => v !== null);
        const ema3 = this.ema(validEma2, period);

        // TRIX = rate of change of ema3
        const result = [];
        for (let i = 0; i < ema3.length; i++) {
            if (i === 0 || ema3[i] === null || ema3[i - 1] === null || ema3[i - 1] === 0) {
                result.push(null);
            } else {
                result.push(((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 10000);
            }
        }
        return result;
    },

    /**
     * ROCR - Rate of Change Ratio (BitVision: ROCR(3), ROCR(6))
     */
    rocr(closes, period = 10) {
        const result = [];
        for (let i = 0; i < closes.length; i++) {
            if (i < period || closes[i - period] === 0) {
                result.push(null);
            } else {
                result.push(closes[i] / closes[i - period]);
            }
        }
        return result;
    },

    /**
     * VWAP - Volume Weighted Average Price
     */
    vwap(highs, lows, closes, volumes) {
        let cumTPV = 0;
        let cumVol = 0;
        const result = [];
        for (let i = 0; i < closes.length; i++) {
            const tp = (highs[i] + lows[i] + closes[i]) / 3;
            cumTPV += tp * volumes[i];
            cumVol += volumes[i];
            result.push(cumVol === 0 ? closes[i] : cumTPV / cumVol);
        }
        return result;
    },

    /**
     * EMA Cross - Moving average crossover signals
     * (Commonly used in crypto trading bots)
     */
    emaCross(closes, fastPeriod = 9, slowPeriod = 21) {
        const fast = this.ema(closes, fastPeriod);
        const slow = this.ema(closes, slowPeriod);
        return { fast, slow };
    },

    // ===== Kaggle-Inspired Features =====

    /**
     * Price Returns / Percentage Change (Kaggle: pct_change feature)
     */
    returns(closes) {
        const result = [null];
        for (let i = 1; i < closes.length; i++) {
            result.push(closes[i - 1] === 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        return result;
    },

    /**
     * Rolling Statistics (Kaggle: rolling mean, rolling std)
     */
    rollingStats(closes, period = 14) {
        const means = this.sma(closes, period);
        const stds = this.stdDev(closes, period);
        return { means, stds };
    },

    /**
     * High-Low Spread (Kaggle: volatility feature)
     */
    hlSpread(highs, lows) {
        return highs.map((h, i) => h - lows[i]);
    },

    /**
     * Open-Close Spread (Kaggle: candle body feature)
     */
    ocSpread(opens, closes) {
        return opens.map((o, i) => closes[i] - o);
    },

    /**
     * Support and Resistance Levels (from recent pivots)
     */
    supportResistance(highs, lows, closes, lookback = 20) {
        const len = closes.length;
        if (len < lookback) return { support: [], resistance: [] };

        const recentHighs = highs.slice(-lookback);
        const recentLows = lows.slice(-lookback);
        const recentCloses = closes.slice(-lookback);

        // Find local peaks (resistance) and troughs (support)
        const resistanceLevels = [];
        const supportLevels = [];

        for (let i = 2; i < recentHighs.length - 2; i++) {
            if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
                recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
                resistanceLevels.push(recentHighs[i]);
            }
            if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
                recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
                supportLevels.push(recentLows[i]);
            }
        }

        return { support: supportLevels, resistance: resistanceLevels };
    },

    /**
     * Historical Volatility (Kaggle: rolling std of returns)
     */
    historicalVolatility(closes, period = 14) {
        const rets = this.returns(closes);
        const validRets = rets.map(r => r === null ? 0 : r);
        return this.stdDev(validRets, period);
    },

    /**
     * Price Position relative to a target price
     * Returns how the target compares to recent price action
     */
    pricePosition(highs, lows, closes, targetPrice, lookback = 50) {
        const len = closes.length;
        const start = Math.max(0, len - lookback);
        const recentCloses = closes.slice(start);
        const recentHighs = highs.slice(start);
        const recentLows = lows.slice(start);

        // What % of recent candles closed above the target
        const aboveCount = recentCloses.filter(c => c > targetPrice).length;
        const belowCount = recentCloses.filter(c => c <= targetPrice).length;
        const pctAbove = aboveCount / recentCloses.length;

        // Distance from current price to target
        const currentPrice = closes[len - 1];
        const distancePct = (targetPrice - currentPrice) / currentPrice;

        // Nearest support/resistance relative to target
        const maxHigh = Math.max(...recentHighs);
        const minLow = Math.min(...recentLows);
        const range = maxHigh - minLow;
        const positionInRange = range === 0 ? 0.5 : (targetPrice - minLow) / range;

        return {
            pctAbove,
            pctBelow: 1 - pctAbove,
            distancePct,
            positionInRange,
            aboveCount,
            belowCount,
            maxHigh,
            minLow
        };
    },

    // ===== Compute All Indicators =====

    computeAll(klines) {
        const opens = klines.map(k => k.open);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);
        const closes = klines.map(k => k.close);
        const volumes = klines.map(k => k.volume);

        return {
            rsi: this.rsi(closes),
            macd: this.macd(closes),
            bollingerBands: this.bollingerBands(closes),
            adx: this.adx(highs, lows, closes),
            stochastic: this.stochastic(highs, lows, closes),
            williamsR: this.williamsR(highs, lows, closes),
            atr: this.atr(highs, lows, closes),
            obv: this.obv(closes, volumes),
            momentum: this.momentum(closes),
            trix: this.trix(closes),
            rocr: this.rocr(closes, 6),
            vwap: this.vwap(highs, lows, closes, volumes),
            emaCross: this.emaCross(closes),
            sma50: this.sma(closes, Math.min(50, closes.length - 1)),
            sma200: this.sma(closes, Math.min(200, closes.length - 1)),
            // Kaggle-inspired features
            returns: this.returns(closes),
            rollingStats14: this.rollingStats(closes, 14),
            rollingStats7: this.rollingStats(closes, 7),
            hlSpread: this.hlSpread(highs, lows),
            ocSpread: this.ocSpread(opens, closes),
            supportResistance: this.supportResistance(highs, lows, closes),
            histVolatility: this.historicalVolatility(closes),
            closes,
            highs,
            lows,
            opens,
            volumes
        };
    }
};

// Export for use in other files
if (typeof module !== 'undefined') {
    module.exports = TechnicalIndicators;
}