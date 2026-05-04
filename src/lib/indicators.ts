import type { OHLCVBar, TechnicalSignal, SignalType } from "./types";

export function sma(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const slice = data.slice(i - period + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return result;
}

export function ema(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      const slice = data.slice(0, period);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    } else {
      const prev = result[i - 1]!;
      result.push(data[i] * k + prev * (1 - k));
    }
  }
  return result;
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = [];

  // Validate: need price variation for meaningful RSI
  const uniquePrices = new Set(closes.slice(-period * 2));
  if (uniquePrices.size <= 2 && closes.length >= period) {
    // Data has no meaningful variation — return null instead of misleading 0/100
    return closes.map(() => null);
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(null); continue; }

    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i < period) {
      result.push(null);
    } else if (i === period) {
      // First RSI: simple average of first `period` gains/losses
      let sumGain = 0, sumLoss = 0;
      for (let j = 1; j <= period; j++) {
        const c = closes[j] - closes[j - 1];
        sumGain += c > 0 ? c : 0;
        sumLoss += c < 0 ? -c : 0;
      }
      avgGain = sumGain / period;
      avgLoss = sumLoss / period;
      if (avgGain === 0 && avgLoss === 0) {
        result.push(50); // no movement = neutral
      } else if (avgLoss === 0) {
        result.push(100);
      } else {
        result.push(100 - 100 / (1 + avgGain / avgLoss));
      }
    } else {
      // Wilder smoothing: proper running average
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      if (avgGain === 0 && avgLoss === 0) {
        result.push(50);
      } else if (avgLoss === 0) {
        result.push(100);
      } else {
        result.push(100 - 100 / (1 + avgGain / avgLoss));
      }
    }
  }
  return result;
}

export function macd(
  closes: number[], fast = 12, slow = 26, signal = 9
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine.push(emaFast[i]! - emaSlow[i]!);
    } else {
      macdLine.push(null);
    }
  }

  const validMacd = macdLine.filter((v) => v !== null) as number[];
  const signalLine = ema(validMacd, signal);

  const fullSignal: (number | null)[] = [];
  const histogram: (number | null)[] = [];
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) {
      const sig = signalLine[j] ?? null;
      fullSignal.push(sig);
      histogram.push(sig !== null ? macdLine[i]! - sig : null);
      j++;
    } else {
      fullSignal.push(null);
      histogram.push(null);
    }
  }

  return { macd: macdLine, signal: fullSignal, histogram };
}

export function bollingerBands(
  closes: number[], period = 20, mult = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const middle = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (middle[i] === null) {
      upper.push(null); lower.push(null);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = middle[i]!;
      const std = Math.sqrt(slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
      upper.push(mean + mult * std);
      lower.push(mean - mult * std);
    }
  }
  return { upper, middle, lower };
}

export function atr(
  highs: number[], lows: number[], closes: number[], period = 14
): (number | null)[] {
  const trueRanges: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      trueRanges.push(highs[i] - lows[i]);
    } else {
      trueRanges.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
  }
  return sma(trueRanges, period);
}

/** Generate technical signal from OHLCV bars */
export function generateCryptoSignal(bars: OHLCVBar[]): TechnicalSignal {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  let score = 0;

  // RSI
  const rsiVals = rsi(closes);
  const rsiVal = rsiVals[rsiVals.length - 1];
  if (rsiVal !== null) {
    if (rsiVal < 30) score += 2;
    else if (rsiVal < 40) score += 1;
    else if (rsiVal > 70) score -= 2;
    else if (rsiVal > 60) score -= 1;
  }

  // MACD
  const macdResult = macd(closes);
  const macdHist = macdResult.histogram[macdResult.histogram.length - 1];
  const prevMacdHist = macdResult.histogram[macdResult.histogram.length - 2];
  if (macdHist !== null && prevMacdHist !== null) {
    if (macdHist > 0 && prevMacdHist <= 0) score += 2;
    else if (macdHist > 0) score += 1;
    else if (macdHist < 0 && prevMacdHist >= 0) score -= 2;
    else if (macdHist < 0) score -= 1;
  }

  // Bollinger Bands
  const bb = bollingerBands(closes);
  const lastClose = closes[closes.length - 1];
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];
  let bbPos: string | null = null;
  if (lastUpper !== null && lastLower !== null) {
    if (lastClose <= lastLower) { score += 1; bbPos = "下限突破"; }
    else if (lastClose >= lastUpper) { score -= 1; bbPos = "上限突破"; }
    else { bbPos = "バンド内"; }
  }

  // Volume ratio (current vs 20-period average)
  const volSma = sma(volumes, 20);
  const lastVolSma = volSma[volSma.length - 1];
  const lastVol = volumes[volumes.length - 1];
  let volumeRatio: number | null = null;
  if (lastVolSma !== null && lastVolSma > 0) {
    volumeRatio = lastVol / lastVolSma;
    if (volumeRatio > 1.5 && score > 0) score += 1;
    else if (volumeRatio > 1.5 && score < 0) score -= 1;
  }

  // SMA crossover
  const sma20Vals = sma(closes, 20);
  const sma50Vals = sma(closes, 50);
  const sma20Val = sma20Vals[sma20Vals.length - 1];
  const sma50Val = sma50Vals[sma50Vals.length - 1];

  // ATR
  const atrVals = atr(highs, lows, closes);
  const atrVal = atrVals[atrVals.length - 1];

  // Price changes
  const changePercent1h = closes.length >= 2
    ? ((lastClose - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
  const changePercent24h = closes.length >= 25
    ? ((lastClose - closes[closes.length - 25]) / closes[closes.length - 25]) * 100 : 0;

  // Score to signal
  let signal: SignalType;
  if (score >= 5) signal = "STRONG_BUY";
  else if (score >= 2) signal = "BUY";
  else if (score <= -5) signal = "STRONG_SELL";
  else if (score <= -2) signal = "SELL";
  else signal = "NEUTRAL";

  return {
    rsi: rsiVal ?? null,
    macdHistogram: macdHist ?? null,
    bbPosition: bbPos,
    atr: atrVal ?? null,
    sma20: sma20Val ?? null,
    sma50: sma50Val ?? null,
    volumeRatio,
    close: lastClose,
    changePercent1h,
    changePercent24h,
    signal,
    score,
  };
}
