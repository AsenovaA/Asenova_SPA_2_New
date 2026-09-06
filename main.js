import Papa from 'papaparse';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
  PieController,
  ArcElement,
} from 'chart.js';

// chart.js v4 is tree-shaken, so every controller, element, and scale used
// below has to be registered by hand.
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
  PieController,
  ArcElement
);

// GenAI Finance course, starter scaffold.
// This file intentionally does very little. Build on it during class.
//
// No API keys are stored in this file. Both the Twelve Data key and the
// OpenRouter key are entered in the form fields at run time, so nothing secret
// is ever committed to your public repo or shipped in the source.

const form = document.getElementById('ticker-form');
const results = document.getElementById('results');

// ---------------------------------------------------------------------------
// Twelve Data rate limiting. The free plan allows 8 requests per minute
// across ALL calls, tickers and the SPY benchmark fetch together. Firing them
// concurrently (the natural result of Promise.all over many tickers) can
// exceed that within seconds once more than about 8 tickers are entered.
// This queue serializes every Twelve Data call with a safe minimum gap
// between them, so a run with 20-30 tickers succeeds slower rather than
// failing partway through.
// ---------------------------------------------------------------------------
let twelveDataQueue = Promise.resolve();
const TWELVE_DATA_MIN_INTERVAL_MS = 8000; // ~7.5 calls/minute, under the 8/minute cap

function queueTwelveDataCall(fn) {
  const result = twelveDataQueue.then(async () => {
    const value = await fn();
    await new Promise((resolve) => setTimeout(resolve, TWELVE_DATA_MIN_INTERVAL_MS));
    return value;
  });
  // Keep the queue moving even if one call fails, so a single bad ticker
  // does not stall every request behind it.
  twelveDataQueue = result.catch(() => {});
  return result;
}

// Remember the two keys across reloads, purely for local convenience while
// testing. This is a deliberate change from the template's original "keys
// never persist" behavior, since it is your own browser storing your own
// keys, not anything shared with other visitors to the deployed page.
const TWELVE_DATA_STORAGE_KEY = 'genai-finance-twelvedata-key';
const OPENROUTER_STORAGE_KEY = 'genai-finance-openrouter-key';
const NEWSDATA_STORAGE_KEY = 'genai-finance-newsdata-key';
const FMP_STORAGE_KEY = 'genai-finance-fmp-key';
const FRED_STORAGE_KEY = 'genai-finance-fred-key';

function restoreSavedKeys() {
  const savedTwelveData = localStorage.getItem(TWELVE_DATA_STORAGE_KEY);
  const savedOpenRouter = localStorage.getItem(OPENROUTER_STORAGE_KEY);
  const savedNewsData = localStorage.getItem(NEWSDATA_STORAGE_KEY);
  const savedFmp = localStorage.getItem(FMP_STORAGE_KEY);
  const savedFred = localStorage.getItem(FRED_STORAGE_KEY);
  if (savedTwelveData) {
    document.getElementById('twelvedata-key').value = savedTwelveData;
  }
  if (savedOpenRouter) {
    document.getElementById('openrouter-key').value = savedOpenRouter;
  }
  if (savedNewsData) {
    document.getElementById('newsdata-key').value = savedNewsData;
  }
  if (savedFmp) {
    document.getElementById('fmp-key').value = savedFmp;
  }
  if (savedFred) {
    document.getElementById('fred-key').value = savedFred;
  }
}
restoreSavedKeys();

// ---------------------------------------------------------------------------
// Watchlist: named, saved ticker lists. Reuses the same localStorage
// approach as the API keys, just storing a JSON object of name -> ticker
// string instead of a single value.
// ---------------------------------------------------------------------------
const WATCHLIST_STORAGE_KEY = 'genai-finance-watchlists';

function loadWatchlists() {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveWatchlists(watchlists) {
  localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlists));
}

function populateWatchlistDropdown() {
  const select = document.getElementById('watchlist-select');
  const watchlists = loadWatchlists();
  const existingOptions = Array.from(select.options).slice(1);
  existingOptions.forEach((opt) => opt.remove());
  for (const name of Object.keys(watchlists)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name} (${watchlists[name]})`;
    select.appendChild(option);
  }
}
populateWatchlistDropdown();

document.getElementById('watchlist-save-btn').addEventListener('click', () => {
  const tickerValue = document.getElementById('ticker').value.trim();
  const name = document.getElementById('watchlist-name').value.trim();
  const hasTickersAndName = tickerValue.length > 0 && name.length > 0;
  if (hasTickersAndName === false) {
    alert('Enter both a ticker list and a name before saving.');
    return;
  }
  const watchlists = loadWatchlists();
  watchlists[name] = tickerValue;
  saveWatchlists(watchlists);
  populateWatchlistDropdown();
  document.getElementById('watchlist-name').value = '';
});

document.getElementById('watchlist-select').addEventListener('change', (event) => {
  const name = event.target.value;
  if (!name) return;
  const watchlists = loadWatchlists();
  const tickerValue = watchlists[name];
  const hasSavedValue = tickerValue !== undefined;
  if (hasSavedValue === true) {
    document.getElementById('ticker').value = tickerValue;
  }
});

// ---------------------------------------------------------------------------
// Indicator math, ported from the instructor's reference app and
// cross-checked against D_TTR.R (MACD) and E_TTR.R (RSI).
// ---------------------------------------------------------------------------

// Exponential moving average. Seeded with the SMA of the first n values,
// same convention as TTR's EMA in R.
function EMA(values, n) {
  const out = new Array(values.length).fill(null);
  const multiplier = 2 / (n + 1);
  const seedIndex = n - 1;
  if (seedIndex >= values.length) return out;

  let seedSum = 0;
  for (let i = 0; i <= seedIndex; i++) seedSum += values[i];
  out[seedIndex] = seedSum / n;

  for (let i = seedIndex + 1; i < values.length; i++) {
    out[i] = values[i] * multiplier + out[i - 1] * (1 - multiplier);
  }
  return out;
}

// MACD: fast EMA minus slow EMA, then an EMA of that difference as the
// signal line. Matches D_TTR.R's EMA convention (the course settled on EMA,
// not the SMA version shown first in that script "to make it easier to
// learn").
function MACD(closes, nFast, nSlow, nSig) {
  const emaFast = EMA(closes, nFast);
  const emaSlow = EMA(closes, nSlow);

  const macdLine = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });

  const firstValid = macdLine.findIndex((v) => v !== null);
  const macdValidPortion = macdLine.slice(firstValid);
  const signalOnValidPortion = EMA(macdValidPortion, nSig);

  const signalLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalOnValidPortion.length; i++) {
    signalLine[firstValid + i] = signalOnValidPortion[i];
  }

  return { macdLine, signalLine };
}

// RSI: SMA based average gain and loss over n periods, matching E_TTR.R's
// maType="SMA" convention.
function RSI(closes, n) {
  const out = new Array(closes.length).fill(null);
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? Math.abs(change) : 0;
  }

  for (let i = n; i < closes.length; i++) {
    let avgGain = 0;
    let avgLoss = 0;
    for (let j = i - n + 1; j <= i; j++) {
      avgGain += gains[j];
      avgLoss += losses[j];
    }
    avgGain /= n;
    avgLoss /= n;

    if (avgLoss === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

// Simple moving average, unweighted, matching the "20-day SMA" convention
// used for Bollinger Bands.
function SMA(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) {
      sum += values[j];
    }
    out[i] = sum / n;
  }
  return out;
}

// Bollinger Bands: a 20-day SMA with upper and lower bands set 2 sample
// standard deviations away, computed over the same trailing 20-day window.
// Price pressing the upper band suggests it is stretched relative to its own
// recent volatility, the lower band the opposite. This overlaps with RSI's
// overbought/oversold read, computed a completely different way, so the two
// agreeing is a stronger signal than either alone.
function bollingerBands(closes, window, numStdDev) {
  const sma = SMA(closes, window);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);

  for (let i = window - 1; i < closes.length; i++) {
    const windowSlice = closes.slice(i - window + 1, i + 1);
    const sd = sampleStdDev(windowSlice);
    const hasValidSma = sma[i] !== null;
    const hasValidSd = sd !== null;
    if (hasValidSma === true && hasValidSd === true) {
      upper[i] = sma[i] + numStdDev * sd;
      lower[i] = sma[i] - numStdDev * sd;
    }
  }

  return { sma, upper, lower };
}

// Average True Range: the average size of a stock's daily price swing in
// dollars, accounting for the day's high-low range and any overnight gap.
// Uses a simple moving average of true range rather than Wilder's smoothing,
// a documented simplification, not a different concept. Unlike RSI/MACD,
// ATR carries no directional information, only "how many dollars does this
// stock typically move."
function calculateATR(priceData, n) {
  const trueRanges = [];
  for (let i = 1; i < priceData.length; i++) {
    const high = priceData[i].high;
    const low = priceData[i].low;
    const previousClose = priceData[i - 1].close;
    const trueRange = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );
    trueRanges.push(trueRange);
  }
  const atrSeries = SMA(trueRanges, n);
  return atrSeries[atrSeries.length - 1];
}

// ATR based stop-loss and take-profit, the standard professional convention
// rather than an arbitrary percentage: the stop distance scales with how
// much the stock actually tends to move, so a volatile stock gets a wider
// stop than a calm one at the same dollar risk tolerance. Default multiples
// give a 2:1 reward to risk ratio (2x ATR stop, 4x ATR target).
const ATR_STOP_MULTIPLE = 2;
const ATR_TARGET_MULTIPLE = 4;

function calculatePositionLevels(currentPrice, atr) {
  if (atr === null || Number.isNaN(atr)) {
    return null;
  }
  const stopLoss = currentPrice - ATR_STOP_MULTIPLE * atr;
  const takeProfit = currentPrice + ATR_TARGET_MULTIPLE * atr;
  return { atr, stopLoss, takeProfit };
}

// A 3-tier BUY/HOLD/SELL label built directly from the app's own thesis, not
// a new rule: BUY is exactly "passes the thesis" (RSI under 70, MACD above
// signal). SELL is specifically overbought (RSI 70+), regardless of MACD,
// since the app already treats that as a warning elsewhere. Everything else
// is HOLD, meaning momentum has not yet confirmed either way.
//
// The confidence score is a simple, transparent heuristic, not a rigorous
// statistical measure: it combines how far RSI sits from the neutral
// midpoint (50) with how large the MACD histogram is relative to price,
// each capped at 50 points, summed to a 0-100 score. It is meant to convey
// "how clearly" the numbers point one way, not a probability of anything.
function generateSignal(rsi, macd, macdSignal, price) {
  if (rsi === null || macd === null || macdSignal === null) {
    return { label: 'N/A', confidence: null, reason: 'not enough price history yet' };
  }

  const histogram = macd - macdSignal;
  const isOverbought = rsi >= 70;
  const passesThesis = rsi < 70 && macd > macdSignal;

  let label;
  let reason;
  if (isOverbought === true) {
    label = 'SELL';
    reason = 'RSI is overbought (70 or above)';
  } else if (passesThesis === true) {
    label = 'BUY';
    reason = 'passes the thesis: RSI under 70 and MACD above its signal line';
  } else {
    label = 'HOLD';
    reason = 'momentum has not yet confirmed either direction';
  }

  const rsiStrength = Math.min(Math.abs(rsi - 50), 50);
  const histogramStrength = Math.min((Math.abs(histogram) / price) * 1000, 50);
  const confidence = Math.round(rsiStrength + histogramStrength);

  return { label, confidence, reason };
}


// end rather than assuming the last index is populated.
function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && !Number.isNaN(arr[i])) return Number(arr[i].toFixed(2));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Portfolio construction: daily returns, volatility, and inverse volatility
// weighting, following the instructor's example prompt
// (prompt_weight_portfolio_inverse_volatility.txt) and its stated coding
// conventions (explicit boolean comparisons, brace delimited blocks, no
// one line conditionals).
// ---------------------------------------------------------------------------

// Daily simple returns. One value per day after the first, so the output is
// one element shorter than the input closes array.
function dailyReturns(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const previousClose = closes[i - 1];
    const currentClose = closes[i];
    const dailyReturn = (currentClose - previousClose) / previousClose;
    returns.push(dailyReturn);
  }
  return returns;
}

// Sample standard deviation (divide by n minus 1), matching the convention
// stated in both instructor prompt specs.
function sampleStdDev(values) {
  const n = values.length;
  const hasEnoughValues = n > 1;
  if (hasEnoughValues === false) {
    return null;
  }

  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const squaredDiffs = values.map((v) => (v - mean) * (v - mean));
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / (n - 1);
  return Math.sqrt(variance);
}

// Assigns inverse volatility weights across the surviving tickers. Each
// entry in survivors is { ticker, volatility }. Tickers with a zero or
// missing volatility are excluded and reported separately, rather than
// dividing by zero.
function inverseVolatilityWeights(survivors) {
  const included = [];
  const dropped = [];

  for (const s of survivors) {
    const hasValidVol = s.volatility !== null && s.volatility > 0;
    if (hasValidVol === true) {
      included.push(s);
    } else {
      dropped.push(s.ticker);
    }
  }

  const rawWeights = included.map((s) => ({
    ticker: s.ticker,
    volatility: s.volatility,
    rawWeight: 1 / s.volatility,
  }));

  const rawWeightSum = rawWeights.reduce((sum, r) => sum + r.rawWeight, 0);

  const weights = {};
  for (const r of rawWeights) {
    weights[r.ticker] = {
      weight: r.rawWeight / rawWeightSum,
      volatility: r.volatility,
    };
  }

  let weightSum = 0;
  for (const ticker in weights) {
    weightSum += weights[ticker].weight;
  }
  const weightsAreValid = Math.abs(weightSum - 1) < 1e-9;

  return { weights, dropped, weightsAreValid };
}

// Daily simple returns, keyed by the date of the "current" day, so returns
// from different tickers can be aligned and summed by date even if their
// price history does not start on exactly the same day.
function returnsByDate(priceData) {
  const map = new Map();
  for (let i = 1; i < priceData.length; i++) {
    const previousClose = priceData[i - 1].close;
    const currentClose = priceData[i].close;
    const dailyReturn = (currentClose - previousClose) / previousClose;
    map.set(priceData[i].date, dailyReturn);
  }
  return map;
}

// Portfolio return and volatility, following the instructor's example prompt
// (prompt_portfolio_return_and_volatility.txt). survivorOutcomes is the array
// of ok outcomes that passed the thesis; weighting is the result of
// inverseVolatilityWeights() over those same survivors.
// Finds the common set of dates across several returnsByDate maps, sorted
// ascending. Shared by the portfolio return calculation and the rolling
// metrics below, so both use exactly the same alignment logic.
function commonDatesAcross(maps) {
  let common = null;
  for (const m of maps) {
    const datesForMap = new Set(m.keys());
    common = common === null ? datesForMap : new Set([...common].filter((d) => datesForMap.has(d)));
  }
  return common ? Array.from(common).sort() : [];
}

// Builds the weighted portfolio daily return series over an explicit list of
// dates. Reused both for the whole-history portfolio stats and for the
// rolling beta calculation, which needs dates aligned with SPY specifically.
function weightedPortfolioReturnsForDates(survivorOutcomes, weighting, dates) {
  return dates.map((date) => {
    let dayReturn = 0;
    for (const outcome of survivorOutcomes) {
      const weight = weighting.weights[outcome.ticker].weight;
      const tickerReturn = outcome.returnsByDate.get(date);
      dayReturn += weight * tickerReturn;
    }
    return dayReturn;
  });
}

function computePortfolioReturnAndVolatility(survivorOutcomes, weighting) {
  const weightsAreValid = weighting.weightsAreValid;
  if (weightsAreValid === false) {
    return { ok: false, message: 'Weights do not sum to 1, skipping the portfolio return calculation until that is fixed.' };
  }

  // Only include days where every surviving ticker has a return. Trim to the
  // common set of dates so each day's weighted sum is complete.
  const sortedDates = commonDatesAcross(survivorOutcomes.map((o) => o.returnsByDate));

  const hasEnoughDates = sortedDates.length > 1;
  if (hasEnoughDates === false) {
    return { ok: false, message: 'Not enough overlapping trading days across the surviving tickers to compute a portfolio return.' };
  }

  const dailyPortfolioReturns = weightedPortfolioReturnsForDates(survivorOutcomes, weighting, sortedDates);

  const meanDailyReturn = dailyPortfolioReturns.reduce((sum, r) => sum + r, 0) / dailyPortfolioReturns.length;
  const annualizedReturn = meanDailyReturn * 252;

  const dailyVolatility = sampleStdDev(dailyPortfolioReturns);
  const annualizedVolatility = dailyVolatility !== null ? dailyVolatility * Math.sqrt(252) : null;

  return {
    ok: true,
    annualizedReturn,
    annualizedVolatility,
    daysUsed: sortedDates.length,
    dates: sortedDates,
    dailyPortfolioReturns,
  };
}

// ---------------------------------------------------------------------------
// Rolling diagnostics, following E_rolling_correlation.R and
// F_rolling_metrics.R: rolling correlation, rolling Sharpe, and rolling beta
// vs a benchmark. Windows of 30 (short) and 90 (long) trading days match the
// instructor's scripts.
// ---------------------------------------------------------------------------

const ROLLING_SHORT_WINDOW = 30;
const ROLLING_LONG_WINDOW = 90;

// A reasonable classroom-style annual risk free rate, matching
// C_max_sharpe.R's example value. Change here if a current 3-month T-bill
// rate should be used instead.
const RISK_FREE_RATE_ANNUAL = 0.035;
const RISK_FREE_RATE_DAILY = RISK_FREE_RATE_ANNUAL / 252;

// ---------------------------------------------------------------------------
// Additional risk metrics beyond what the instructor's scripts cover: max
// drawdown, Sortino ratio, and historical VaR. All three reuse the portfolio
// daily return series already computed in computePortfolioReturnAndVolatility,
// so no new data fetch is needed for any of them.
// ---------------------------------------------------------------------------

// The worst peak to trough decline the portfolio would have experienced,
// tracked by compounding a running index (starting at 1) through the daily
// returns and comparing each point to the highest index seen so far. Returned
// as a negative fraction, for example -0.23 means a 23% drawdown at its worst
// point.
function maxDrawdown(dailyReturns) {
  let peak = 1;
  let value = 1;
  let worstDrawdown = 0;
  for (const r of dailyReturns) {
    value = value * (1 + r);
    const newPeak = value > peak;
    if (newPeak === true) {
      peak = value;
    }
    const drawdown = (value - peak) / peak;
    const isWorseThanSeen = drawdown < worstDrawdown;
    if (isWorseThanSeen === true) {
      worstDrawdown = drawdown;
    }
  }
  return worstDrawdown;
}

// Sortino ratio: like Sharpe, but the denominator (downside deviation) only
// counts returns that fall short of the target rate, treating every day at
// or above target as zero risk. Standard definition: downside deviation is
// computed over ALL days (not just the down days), using min(return - target,
// 0) squared, then averaged over the full sample and square rooted.
function sortinoRatio(dailyReturns, dailyTargetRate) {
  const n = dailyReturns.length;
  const excessReturns = dailyReturns.map((r) => r - dailyTargetRate);
  const meanExcess = excessReturns.reduce((sum, v) => sum + v, 0) / n;

  const downsideSquares = dailyReturns.map((r) => {
    const shortfall = Math.min(r - dailyTargetRate, 0);
    return shortfall * shortfall;
  });
  const downsideVariance = downsideSquares.reduce((sum, v) => sum + v, 0) / n;
  const downsideDeviation = Math.sqrt(downsideVariance);

  const hasDownsideRisk = downsideDeviation > 0;
  if (hasDownsideRisk === false) return null;

  return (meanExcess / downsideDeviation) * Math.sqrt(252);
}

// Historical Value at Risk: sorts the daily return series worst to best and
// reads off the value at the given confidence level. At 95% confidence, this
// is the 5th percentile worst day, meaning "on 95% of days, the loss was no
// worse than this." Returned as a return (typically negative), not
// annualized, since VaR is conventionally stated per period.
function historicalVaR(dailyReturns, confidenceLevel) {
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidenceLevel) * sorted.length);
  return sorted[index];
}

// ---------------------------------------------------------------------------
// Share allocation and concentration risk. Both are computed purely from
// weights and current prices already known, no new data fetch needed.
// ---------------------------------------------------------------------------

// Turns percentage weights into an actual order: how many whole shares of
// each survivor to buy given a real investment amount, and how much cash is
// left over from rounding down to whole shares.
function computeShareAllocation(survivorOutcomes, weighting, investmentAmount) {
  const perTicker = {};
  let totalSpent = 0;

  for (const outcome of survivorOutcomes) {
    const weight = weighting.weights[outcome.ticker].weight;
    const price = outcome.priceData[outcome.priceData.length - 1].close;
    const dollarsAllotted = weight * investmentAmount;
    const shares = Math.floor(dollarsAllotted / price);
    const spent = shares * price;
    const leftover = dollarsAllotted - spent;

    perTicker[outcome.ticker] = { price, dollarsAllotted, shares, spent, leftover };
    totalSpent += spent;
  }

  return {
    perTicker,
    totalInvested: totalSpent,
    totalCashRemaining: investmentAmount - totalSpent,
  };
}

// Herfindahl-Hirschman Index: sum of each weight squared. Measures whether
// portfolio risk comes from too much capital sitting in too few positions,
// a different question from correlation (whether positions move together).
// Compared against the equal-weight benchmark (1 / number of holdings),
// since that comparison is more meaningful here than absolute HHI
// thresholds borrowed from antitrust analysis, which assume a very
// different number of participants.
function computeHHI(weighting) {
  const weights = Object.values(weighting.weights).map((w) => w.weight);
  const n = weights.length;
  const hhi = weights.reduce((sum, w) => sum + w * w, 0);
  const equalWeightBenchmark = 1 / n;
  const ratio = hhi / equalWeightBenchmark;

  let read;
  if (ratio < 1.15) {
    read = 'close to equal-weight, well balanced';
  } else if (ratio < 1.5) {
    read = 'moderately concentrated in a few positions';
  } else {
    read = 'concentrated, a small number of positions dominate';
  }

  return { hhi, equalWeightBenchmark, ratio, read };
}

function covariance(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (xs[i] - meanX) * (ys[i] - meanY);
  }
  return sum / (n - 1);
}

function pearsonCorrelation(xs, ys) {
  const cov = covariance(xs, ys);
  const sdX = sampleStdDev(xs);
  const sdY = sampleStdDev(ys);
  const bothHaveSpread = sdX !== null && sdY !== null && sdX > 0 && sdY > 0;
  if (bothHaveSpread === false) return null;
  return cov / (sdX * sdY);
}

// Rolling Pearson correlation between two equal-length, date-aligned return
// series. The first (window - 1) entries are null, same warmup convention as
// the RSI/MACD indicator functions above.
function rollingCorrelation(xs, ys, window) {
  const out = new Array(xs.length).fill(null);
  for (let i = window - 1; i < xs.length; i++) {
    const xWindow = xs.slice(i - window + 1, i + 1);
    const yWindow = ys.slice(i - window + 1, i + 1);
    out[i] = pearsonCorrelation(xWindow, yWindow);
  }
  return out;
}

// Averages rolling correlation across every pair of survivors, rather than
// plotting one line per pair. With 5 tickers (the R script's classroom
// example) 10 lines is readable. With 15-30 tickers, showing every pair
// would mean up to roughly 190 lines, so the average line is used instead,
// keeping the same "correlation spikes during stress" story visible without
// the visual noise.
function averagePairwiseRollingCorrelation(returnSeriesList, window) {
  const n = returnSeriesList.length;
  if (n < 2) return null;
  const length = returnSeriesList[0].length;
  const sums = new Array(length).fill(0);
  const counts = new Array(length).fill(0);

  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const series = rollingCorrelation(returnSeriesList[a], returnSeriesList[b], window);
      for (let i = 0; i < length; i++) {
        if (series[i] !== null) {
          sums[i] += series[i];
          counts[i]++;
        }
      }
    }
  }

  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : null));
}

// Rolling Sharpe ratio for the portfolio's own daily return series. Matches
// F_rolling_metrics.R: the numerator is the mean EXCESS return in the
// window, the denominator is the standard deviation of the RAW (not excess)
// returns in the same window, annualized by sqrt(252).
function rollingSharpe(dailyReturns, window) {
  const out = new Array(dailyReturns.length).fill(null);
  for (let i = window - 1; i < dailyReturns.length; i++) {
    const windowReturns = dailyReturns.slice(i - window + 1, i + 1);
    const excessReturns = windowReturns.map((r) => r - RISK_FREE_RATE_DAILY);
    const meanExcess = excessReturns.reduce((s, v) => s + v, 0) / excessReturns.length;
    const sd = sampleStdDev(windowReturns);
    if (sd === null || sd === 0) {
      out[i] = null;
      continue;
    }
    out[i] = (meanExcess / sd) * Math.sqrt(252);
  }
  return out;
}

// Rolling beta vs a benchmark (SPY). beta = cov(portfolio, market) /
// var(market), computed inside a moving window, matching calcBeta() in
// F_rolling_metrics.R.
function rollingBeta(portfolioReturns, marketReturns, window) {
  const out = new Array(portfolioReturns.length).fill(null);
  for (let i = window - 1; i < portfolioReturns.length; i++) {
    const portWindow = portfolioReturns.slice(i - window + 1, i + 1);
    const mktWindow = marketReturns.slice(i - window + 1, i + 1);
    const cov = covariance(portWindow, mktWindow);
    const marketSd = sampleStdDev(mktWindow);
    if (marketSd === null || marketSd === 0) {
      out[i] = null;
      continue;
    }
    out[i] = cov / (marketSd * marketSd);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Charts: three simple line charts per ticker (price, MACD, RSI), drawn into
// canvases created after the results HTML is inserted, since a canvas has to
// exist in the DOM before Chart.js can get a drawing context from it.
// ---------------------------------------------------------------------------

// Turns a ticker into a safe HTML id fragment (letters and digits only), so
// tickers with unusual characters cannot break the generated canvas ids.
function safeId(ticker) {
  return ticker.replace(/[^A-Za-z0-9]/g, '');
}

function chartOptions(extra = {}) {
  return {
    responsive: true,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ticks: { maxTicksLimit: 6, font: { size: 9 } } },
      y: { ticks: { font: { size: 9 } } },
    },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
    ...extra,
  };
}

// Draws the price, MACD, and RSI charts for one ticker into the three
// canvases already present in its card. Destroys any chart already attached
// to a canvas id first, so re-running Analyze does not throw "canvas already
// in use".
function drawCharts(outcome) {
  const id = safeId(outcome.ticker);
  const labels = outcome.priceData.map((bar) => bar.date);
  const closes = outcome.priceData.map((bar) => bar.close);

  drawChart(`price-chart-${id}`, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Close',
          data: closes,
          borderColor: '#9a6b2c',
          backgroundColor: 'rgba(154, 107, 44, 0.1)',
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: 'Upper band',
          data: outcome.bollinger.upper,
          borderColor: '#a6302c',
          borderDash: [3, 3],
          pointRadius: 0,
          borderWidth: 1,
          fill: false,
        },
        {
          label: 'Lower band',
          data: outcome.bollinger.lower,
          borderColor: '#3a7d5c',
          borderDash: [3, 3],
          pointRadius: 0,
          borderWidth: 1,
          fill: false,
        },
      ],
    },
    options: chartOptions(),
  });

  drawChart(`macd-chart-${id}`, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'MACD', data: outcome.macdLine, borderColor: '#14213d', pointRadius: 0, borderWidth: 1.5 },
        { label: 'Signal', data: outcome.macdSignalLine, borderColor: '#9a6b2c', pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: chartOptions(),
  });

  drawChart(`rsi-chart-${id}`, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'RSI', data: outcome.rsiLine, borderColor: '#14213d', pointRadius: 0, borderWidth: 1.5 },
        {
          label: 'Overbought (70)',
          data: labels.map(() => 70),
          borderColor: '#a6302c',
          borderDash: [4, 4],
          pointRadius: 0,
          borderWidth: 1,
        },
        {
          label: 'Oversold (30)',
          data: labels.map(() => 30),
          borderColor: '#3a7d5c',
          borderDash: [4, 4],
          pointRadius: 0,
          borderWidth: 1,
        },
      ],
    },
    options: chartOptions({ scales: { x: { ticks: { maxTicksLimit: 6, font: { size: 9 } } }, y: { min: 0, max: 100, ticks: { font: { size: 9 } } } } }),
  });
}

function drawChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const existing = Chart.getChart(canvasId);
  if (existing) existing.destroy();
  new Chart(canvas, config);
}

// ---------------------------------------------------------------------------
// News: optional related headlines from NewsData.io, shown alongside a
// ticker's signals. Uses the "latest" endpoint, which returns articles from
// roughly the past 48 hours.
// ---------------------------------------------------------------------------
async function fetchNews(ticker, apiKey) {
  // Appending "stock" and restricting to the business category keeps short,
  // dictionary-word tickers (CAT, ALL, NOW, ...) from matching unrelated
  // everyday-word news instead of the company.
  const query = `${ticker} stock`;
  const url = `https://newsdata.io/api/1/latest?apikey=${apiKey}&q=${encodeURIComponent(query)}&language=en&category=business`;
  const response = await fetch(url);
  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'News fetch failed');
  }

  if (raw && raw.status === 'error') {
    const message = raw.results?.message || 'News fetch failed';
    throw new Error(message);
  }
  if (!response.ok) throw new Error('News fetch failed');

  const items = raw.results ?? [];
  return items.slice(0, 3).map((item) => ({
    title: item.title,
    link: item.link,
    source: item.source_id,
    pubDate: item.pubDate,
  }));
}

// ---------------------------------------------------------------------------
// Analyst price targets: optional forward looking context from FMP. Unlike
// RSI, MACD, or the rolling metrics, this is genuinely not derived from
// price history at all, it is other analysts' own published forecasts.
// Endpoint confirmed working directly against a real FMP key before this was
// written, response shape: an array with one object containing targetHigh,
// targetLow, targetConsensus, and targetMedian.
// ---------------------------------------------------------------------------
async function fetchPriceTarget(ticker, apiKey) {
  const url = `https://financialmodelingprep.com/stable/price-target-consensus?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
  const response = await fetch(url);
  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'Price target fetch failed');
  }

  if (raw && raw['Error Message']) {
    throw new Error(raw['Error Message']);
  }
  if (!response.ok) throw new Error('Price target fetch failed');
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`No analyst price target data found for ${ticker}.`);
  }

  const t = raw[0];
  return {
    high: t.targetHigh,
    low: t.targetLow,
    median: t.targetMedian,
    consensus: t.targetConsensus,
  };
}

// ---------------------------------------------------------------------------
// Yield curve: the 10 year minus 2 year Treasury spread from FRED, a
// portfolio-wide macro indicator rather than a per-ticker one, fetched once
// per run rather than once per survivor. A negative value means an inverted
// yield curve, historically one of the more closely watched recession
// signals. Confirmed working directly against a real FRED key before this
// was written.
// ---------------------------------------------------------------------------
async function fetchYieldCurve(apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
  const response = await fetch(url);
  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'Yield curve fetch failed');
  }

  if (raw && raw.error_message) {
    throw new Error(raw.error_message);
  }
  if (!response.ok) throw new Error('Yield curve fetch failed');

  const observation = raw.observations?.[0];
  if (!observation) {
    throw new Error('No yield curve observation returned.');
  }

  const value = Number(observation.value);
  if (Number.isNaN(value)) {
    throw new Error('Yield curve observation was not a number, the series may be temporarily unavailable.');
  }

  return { value, date: observation.date };
}

// ---------------------------------------------------------------------------
// Earnings call analysis, following the instructor's FIN_A through FIN_G
// pipeline structure, scoped down from one AI call per speaker turn (which
// the R version does, roughly 100+ calls per transcript) to two calls total:
// one schema-constrained call for sentiment and extraction, one plain call
// for the final prose note. Same "code assembles, AI interprets" split, just
// sized for a browser instead of a classroom exercise with an instructor key.
// ---------------------------------------------------------------------------

const earningsForm = document.getElementById('earnings-form');
const earningsResults = document.getElementById('earnings-results');

// Roughly 6,000 tokens worth of transcript text, leaving room in the model's
// context for the news block, the macro block, and the system prompt. Matches
// the "choose, do not paste everything" lesson from FIN_A.
const TRANSCRIPT_CHAR_BUDGET = 24000;

// Riskline's alert feed needs no API key, matching FIN_B.
const RISKLINE_URL = 'https://api.riskline.com/alerts/latest.json';
const MACRO_COUNTRIES_OF_INTEREST = ['United States of America'];

// Fetches and parses a transcript CSV. Uses PapaParse rather than a hand
// written comma-split, since real transcript text contains commas and quoted
// phrases inside the msg field, which a naive split would mangle.
async function fetchTranscriptCsv(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch the transcript CSV (HTTP ${response.status}). Check the URL.`);
  }
  const text = await response.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }
  const rows = parsed.data;
  if (!rows || rows.length === 0) {
    throw new Error('The CSV loaded but contained no rows.');
  }
  return rows;
}

// Same role rule as the R scripts: analysts, researchers, and managing
// directors are treated as the Analyst group, everyone else as Company.
function tagRoles(rows) {
  return rows.map((row) => {
    const title = row.title || '';
    const isAnalyst = /analyst|research|managing director/i.test(title);
    return { ...row, role_group: isAnalyst ? 'Analyst' : 'Company' };
  });
}

// Packs whole speaker turns into the transcript context until the character
// budget is hit, matching FIN_A's "select, do not summarize" strategy and
// its "pack whole turns, never cut a speaker off mid-sentence" chunking rule.
function buildTranscriptContext(rows, speakerFilter) {
  const filtered = speakerFilter === 'all' ? rows : rows.filter((r) => r.role_group === speakerFilter);

  let block = '';
  let used = 0;
  let turnsIncluded = 0;
  for (const row of filtered) {
    const turnText = `${row.speaker} (${row.title}): ${row.msg}\n\n`;
    const wouldExceedBudget = used + turnText.length > TRANSCRIPT_CHAR_BUDGET;
    if (wouldExceedBudget === true && used > 0) break;
    block += turnText;
    used += turnText.length;
    turnsIncluded++;
  }

  return { block, turnsIncluded, turnsAvailable: filtered.length };
}

// Optional, non-fatal macro risk context from Riskline. If this fails (a
// likely possibility if the endpoint does not allow browser-side CORS
// requests) the pipeline continues without it, same as the other optional
// context sources in this app.
async function fetchMacroContext() {
  const response = await fetch(RISKLINE_URL);
  if (!response.ok) throw new Error('Macro risk fetch failed');
  const data = await response.json();
  const alerts = data.alerts ?? [];
  const relevant = alerts.filter((a) => MACRO_COUNTRIES_OF_INTEREST.includes(a.country?.name));

  if (relevant.length === 0) {
    return 'No significant macro risk alerts for the regions of interest.';
  }
  const lines = relevant.slice(0, 5).map((a) => `${a.country.name}: ${a.title}`);
  return 'CURRENT MACRO RISK ALERTS:\n' + lines.join('\n');
}

// Assembles the three sources into one labeled context block. Order and
// labels matter, per FIN_D: primary source first, clearly separated
// sections, so the model can tell a company's own claims apart from press
// coverage and macro conditions.
function assembleEarningsContext({ transcriptBlock, newsBlock, macroBlock, speakerFilter }) {
  return [
    '=== PRIMARY SOURCE: EARNINGS CALL TRANSCRIPT ===',
    `(Speaker filter applied: ${speakerFilter === 'all' ? 'all speakers' : speakerFilter + ' only'})`,
    transcriptBlock,
    '=== SECONDARY SOURCE: RECENT NEWS ===',
    newsBlock || 'No news data available for this run.',
    '=== ENVIRONMENT: MACRO RISK ===',
    macroBlock || 'No macro risk data available for this run.',
  ].join('\n\n');
}

// The JSON schema for the combined sentiment and extraction call, merging
// FIN_E's sentiment fields and FIN_F's extraction fields into a single
// requested shape.
const REVIEW_SURFACE_SCHEMA = {
  name: 'earnings_review_surface',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      overall_sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      company_tone_summary: { type: 'string', description: 'One or two sentences on how company management sounded.' },
      analyst_tone_summary: { type: 'string', description: 'One or two sentences on how analysts sounded, or a note if none are present given the speaker filter.' },
      companies_mentioned: { type: 'array', items: { type: 'string' }, description: 'Other companies named, not the reporting company itself.' },
      executives: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, role: { type: 'string' } },
          required: ['name', 'role'],
          additionalProperties: false,
        },
      },
      financial_figures: {
        type: 'array',
        items: {
          type: 'object',
          properties: { figure: { type: 'string' }, metric: { type: 'string' } },
          required: ['figure', 'metric'],
          additionalProperties: false,
        },
        description: 'Each figure paired with what it measures. A bare number is not enough.',
      },
      forward_looking_statements: {
        type: 'array',
        items: { type: 'string' },
        description: 'Quoted verbatim from the transcript, not paraphrased.',
      },
    },
    required: [
      'overall_sentiment',
      'company_tone_summary',
      'analyst_tone_summary',
      'companies_mentioned',
      'executives',
      'financial_figures',
      'forward_looking_statements',
    ],
    additionalProperties: false,
  },
};

// A general purpose OpenRouter call that requests a JSON-schema-constrained
// response, and retries once without the schema if the route does not
// support structured output (matches the retry pattern from the reference
// app, since not every free-tier provider honors response_format).
async function callOpenRouterForJson(apiKey, systemPrompt, userPrompt, schema) {
  const baseMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const attempt = async (messages, withSchema) => {
    const body = {
      model: 'openrouter/free',
      // Generous headroom: some free-tier routes spend part of the budget
      // on internal reasoning before the visible reply, which can otherwise
      // truncate a JSON response right when it matters most.
      max_tokens: 4000,
      // The free router can land on a reasoning capable model. Without this,
      // some of them print their full chain of thought as the visible reply
      // instead of keeping it internal, which is what happened here.
      reasoning: { enabled: false },
      messages,
    };
    if (withSchema === true) {
      body.response_format = { type: 'json_schema', json_schema: schema };
    }
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await readOpenRouterError(response);
      throw new Error(`OpenRouter call failed. ${detail}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  };

  // First try: ask for the schema directly.
  let raw = '';
  try {
    raw = await attempt(baseMessages, true);
  } catch (err) {
    console.warn('Schema-constrained request failed, retrying without schema:', err.message);
    raw = await attempt(baseMessages, false);
  }

  let parsed = tryParseJson(raw);
  if (parsed !== null) return parsed;

  // Second try: the model ignored the schema or the response got cut off.
  // Prefill the assistant's reply with "{" so the continuation is forced to
  // start as JSON, same trick the reference app uses.
  console.warn('First attempt did not parse as JSON, retrying with a prefilled response. Raw content was:', raw);
  const prefillMessages = [...baseMessages, { role: 'assistant', content: '{' }];
  const rawRetry = await attempt(prefillMessages, false);
  parsed = tryParseJson('{' + rawRetry);
  if (parsed !== null) return parsed;

  console.error('Model response still not valid JSON after retry:', rawRetry);
  throw new Error(
    `The model did not return valid JSON, even after a retry. It said: "${rawRetry.slice(0, 200)}${rawRetry.length > 200 ? '...' : ''}"`
  );
}

// Strips markdown code fences and any stray text around the JSON object,
// then parses. Returns null instead of throwing, so the caller decides what
// to do next.
function tryParseJson(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// The second call: turns the structured review surface into a short prose
// note. This is the language task FIN_G hands off to a chatbot manually;
// here it happens automatically, but under the same rule, only interpret
// the facts already extracted, never add new ones.
// Shared note generator for both the per-ticker research note and the
// earnings call note. The free router's chosen model varies call to call,
// and different models disagree about reasoning: some leak their full chain
// of thought unless reasoning is disabled, others reject the request
// outright if reasoning is disabled ("Reasoning is mandatory for this
// endpoint and cannot be disabled"). No single fixed setting satisfies both,
// so this tries with reasoning disabled first, and only if that specific
// request is rejected, retries once without the reasoning field at all,
// leaning on cleanNoteText's safety nets to catch a leak if the retry's
// model turns out to be the leaking kind.
async function generateNote(apiKey, systemPrompt, userPrompt, maxTokens) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const attempt = async (includeReasoningFlag) => {
    const body = { model: 'openrouter/free', max_tokens: maxTokens, messages };
    if (includeReasoningFlag === true) {
      body.reasoning = { enabled: false };
    }
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response;
  };

  let response = await attempt(true);
  if (!response.ok) {
    const detail = await readOpenRouterError(response);
    const isReasoningConflict = detail.toLowerCase().includes('reasoning');
    if (isReasoningConflict === true) {
      console.warn('Model rejected the reasoning:false setting, retrying without it:', detail);
      response = await attempt(false);
    } else {
      throw new Error(`OpenRouter call failed. ${detail}`);
    }
  }

  if (!response.ok) {
    throw new Error(`OpenRouter call failed. ${await readOpenRouterError(response)}`);
  }

  const data = await response.json();
  const rawNote = data.choices?.[0]?.message?.content ?? 'No response.';
  return cleanNoteText(rawNote);
}

async function getEarningsNote(reviewSurface, symbol, apiKey) {
  const systemPrompt =
    'You are an equity research assistant. You will be given a JSON packet of facts already ' +
    'extracted from an earnings call, sentiment analysis, and supporting context. Write a short ' +
    'research note using only these facts. Do not add outside knowledge. Quote forward-looking ' +
    'statements verbatim if you reference them. Write three to five plain prose sentences. Do not ' +
    'use markdown, bullet points, or dashes at the start of a line.';

  const userPrompt = `Facts extracted for ${symbol}:\n${JSON.stringify(reviewSurface, null, 2)}\n\nWrite the research note now.`;

  return generateNote(apiKey, systemPrompt, userPrompt, 2000);
}

earningsForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = document.getElementById('transcript-url').value.trim();
  const speakerFilter = document.getElementById('speaker-filter').value;
  const openRouterKey = document.getElementById('openrouter-key').value.trim();
  const newsDataKey = document.getElementById('newsdata-key').value.trim();

  if (!openRouterKey) {
    earningsResults.innerHTML = '<p class="error">Add your OpenRouter key in the form above first.</p>';
    return;
  }

  earningsResults.innerHTML = '<p>Loading transcript...</p>';

  try {
    const rawRows = await fetchTranscriptCsv(url);
    const rows = tagRoles(rawRows);
    const symbol = rows[0].symbol || 'UNKNOWN';

    const { block: transcriptBlock, turnsIncluded, turnsAvailable } = buildTranscriptContext(rows, speakerFilter);

    earningsResults.innerHTML = '<p>Gathering supporting context...</p>';

    // News and macro are both optional and non-fatal. A failure in either
    // shows as a note in the final output rather than stopping the run.
    let newsBlock = null;
    let newsError = null;
    if (newsDataKey) {
      try {
        const newsItems = await fetchNews(symbol, newsDataKey);
        newsBlock = newsItems.map((n) => `${n.source ?? ''} | ${n.pubDate ?? ''} | ${n.title}`).join('\n');
      } catch (err) {
        newsError = err.message;
      }
    }

    let macroBlock = null;
    let macroError = null;
    try {
      macroBlock = await fetchMacroContext();
    } catch (err) {
      macroError = err.message;
    }

    const assembledContext = assembleEarningsContext({ transcriptBlock, newsBlock, macroBlock, speakerFilter });

    earningsResults.innerHTML = '<p>Extracting sentiment and facts...</p>';

    const reviewSystemPrompt =
      'You are a financial analyst assistant reading an earnings call transcript plus supporting news ' +
      'and macro context. Use only the provided sources, do not add outside knowledge. Do not include the ' +
      'reporting company itself in companies_mentioned, only other companies. Every financial figure must ' +
      'be paired with a metric, do not include bare numbers. Forward-looking statements must be quoted ' +
      'verbatim from the transcript, not paraphrased. If a category has nothing to report, return an ' +
      'empty array.';

    const reviewUserPrompt = `${assembledContext}\n\n=== TASK ===\nExtract sentiment and facts from the sources above, following the required schema.`;

    const reviewSurface = await callOpenRouterForJson(openRouterKey, reviewSystemPrompt, reviewUserPrompt, REVIEW_SURFACE_SCHEMA);

    earningsResults.innerHTML = '<p>Writing the research note...</p>';

    const note = await getEarningsNote(reviewSurface, symbol, openRouterKey);

    renderEarningsResults({
      symbol,
      speakerFilter,
      turnsIncluded,
      turnsAvailable,
      reviewSurface,
      note,
      newsError,
      macroError,
    });
  } catch (err) {
    earningsResults.innerHTML = `<p class="error">Something went wrong: ${err.message}</p>`;
  }
});

function renderEarningsResults({ symbol, speakerFilter, turnsIncluded, turnsAvailable, reviewSurface, note, newsError, macroError }) {
  const figuresHtml = reviewSurface.financial_figures.length
    ? `<ul>${reviewSurface.financial_figures.map((f) => `<li>${f.figure} (${f.metric})</li>`).join('')}</ul>`
    : '<p class="excluded">No financial figures extracted.</p>';

  const flsHtml = reviewSurface.forward_looking_statements.length
    ? `<ul>${reviewSurface.forward_looking_statements.map((s) => `<li>"${s}"</li>`).join('')}</ul>`
    : '<p class="excluded">No forward-looking statements extracted.</p>';

  const companiesHtml = reviewSurface.companies_mentioned.length
    ? reviewSurface.companies_mentioned.join(', ')
    : 'None mentioned.';

  const execsHtml = reviewSurface.executives.length
    ? reviewSurface.executives.map((e) => `${e.name} (${e.role})`).join(', ')
    : 'None named.';

  const warnings = [];
  if (newsError) warnings.push(`News unavailable: ${newsError}`);
  if (macroError) warnings.push(`Macro risk unavailable: ${macroError}`);
  const warningsHtml = warnings.length
    ? `<p class="excluded">${warnings.join(' | ')}</p>`
    : '';

  earningsResults.innerHTML = `
    <h2>${symbol} &mdash; Earnings Call Review</h2>
    <p class="signals">
      Transcript turns used: ${turnsIncluded} of ${turnsAvailable} (${speakerFilter === 'all' ? 'all speakers' : speakerFilter + ' only'}) &nbsp;|&nbsp;
      Overall sentiment: ${reviewSurface.overall_sentiment}
    </p>
    ${warningsHtml}
    <h3>Company tone</h3>
    <p>${reviewSurface.company_tone_summary}</p>
    <h3>Analyst tone</h3>
    <p>${reviewSurface.analyst_tone_summary}</p>
    <h3>Companies mentioned</h3>
    <p>${companiesHtml}</p>
    <h3>Executives named</h3>
    <p>${execsHtml}</p>
    <h3>Financial figures</h3>
    ${figuresHtml}
    <h3>Forward-looking statements</h3>
    ${flsHtml}
    <h3>Research note</h3>
    <p class="note">${note}</p>
  `;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  // Split on commas, trim whitespace, uppercase, and drop any empty entries
  // (handles trailing commas, extra spaces, lowercase input, etc).
  const tickerInput = document.getElementById('ticker').value;
  const tickers = tickerInput
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);

  const twelveDataKey = document.getElementById('twelvedata-key').value.trim();
  const openRouterKey = document.getElementById('openrouter-key').value.trim();
  const newsDataKey = document.getElementById('newsdata-key').value.trim();
  const fmpKey = document.getElementById('fmp-key').value.trim();
  const fredKey = document.getElementById('fred-key').value.trim();
  const investmentAmountRaw = document.getElementById('investment-amount').value.trim();
  const investmentAmount = investmentAmountRaw ? Number(investmentAmountRaw) : null;

  localStorage.setItem(TWELVE_DATA_STORAGE_KEY, twelveDataKey);
  localStorage.setItem(OPENROUTER_STORAGE_KEY, openRouterKey);
  localStorage.setItem(NEWSDATA_STORAGE_KEY, newsDataKey);
  localStorage.setItem(FMP_STORAGE_KEY, fmpKey);
  localStorage.setItem(FRED_STORAGE_KEY, fredKey);

  if (tickers.length === 0) {
    results.innerHTML = '<p class="error">Enter at least one ticker.</p>';
    return;
  }

  const estimatedSeconds = Math.ceil((tickers.length * TWELVE_DATA_MIN_INTERVAL_MS) / 1000);
  results.innerHTML = `<p>Loading ${tickers.length} ticker(s), this respects Twelve Data's rate limit so it may take about ${estimatedSeconds} seconds for larger lists...</p>`;

  // Fetch each ticker independently so one bad symbol (typo, delisted,
  // rate-limited) doesn't stop the others from displaying.
  const outcomes = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const priceData = await queueTwelveDataCall(() => fetchPriceData(ticker, twelveDataKey));
        const closes = priceData.map((bar) => bar.close);

        // Standard windows from the Technical Indicators handout: MACD
        // 12/26/9, RSI 14.
        const macd = MACD(closes, 12, 26, 9);
        const rsi = RSI(closes, 14);

        const signals = {
          macd: lastValid(macd.macdLine),
          macdSignal: lastValid(macd.signalLine),
          rsi: lastValid(rsi),
        };

        const latestPrice = closes[closes.length - 1];
        const bollinger = bollingerBands(closes, 20, 2);
        const atr = calculateATR(priceData, 14);
        const positionLevels = calculatePositionLevels(latestPrice, atr);
        const signal = generateSignal(signals.rsi, signals.macd, signals.macdSignal, latestPrice);

        const returns = dailyReturns(closes);
        const volatility = sampleStdDev(returns);
        const returnsByDateForTicker = returnsByDate(priceData);

        const note = await getResearchNote(ticker, priceData, signals, openRouterKey);

        // News is optional and non-fatal: a missing key, a rate limit, or a
        // bad response should not take down the ticker's price/signal data,
        // so failures here are swallowed into a null news array with a
        // message rather than thrown.
        let news = null;
        let newsError = null;
        if (newsDataKey) {
          try {
            news = await fetchNews(ticker, newsDataKey);
          } catch (err) {
            newsError = err.message;
          }
        }

        // Same non-fatal pattern for analyst price targets: a missing key or
        // a bad response never takes down the rest of the ticker's card.
        let priceTarget = null;
        let priceTargetError = null;
        if (fmpKey) {
          try {
            priceTarget = await fetchPriceTarget(ticker, fmpKey);
          } catch (err) {
            priceTargetError = err.message;
          }
        }

        return {
          ticker,
          priceData,
          signals,
          returns,
          volatility,
          returnsByDate: returnsByDateForTicker,
          macdLine: macd.macdLine,
          macdSignalLine: macd.signalLine,
          rsiLine: rsi,
          bollinger,
          positionLevels,
          signal,
          note,
          news,
          newsError,
          priceTarget,
          priceTargetError,
          ok: true,
        };
      } catch (err) {
        return { ticker, error: err.message, ok: false };
      }
    })
  );

  // The thesis, from the instructor's prompt spec: RSI below overbought
  // (70) and a positive MACD histogram (MACD line above its signal line).
  const survivors = outcomes.filter((o) => {
    if (o.ok === false) return false;
    const s = o.signals;
    const hasSignals = s.rsi !== null && s.macd !== null && s.macdSignal !== null;
    if (hasSignals === false) return false;
    const passesRsi = s.rsi < 70;
    const passesMacd = s.macd > s.macdSignal;
    return passesRsi === true && passesMacd === true;
  });

  const weighting = inverseVolatilityWeights(
    survivors.map((o) => ({ ticker: o.ticker, volatility: o.volatility }))
  );

  const portfolioStats =
    survivors.length > 0
      ? computePortfolioReturnAndVolatility(survivors, weighting)
      : { ok: false, message: 'No survivors, nothing to compute.' };

  // Additional risk metrics beyond the instructor's scripts: max drawdown,
  // Sortino, and 95% historical VaR. All three reuse the daily return series
  // already computed above, so this needs no new fetch and cannot fail on
  // its own the way an API call could.
  const additionalRiskMetrics = portfolioStats.ok
    ? {
        maxDrawdownPct: maxDrawdown(portfolioStats.dailyPortfolioReturns),
        sortino: sortinoRatio(portfolioStats.dailyPortfolioReturns, RISK_FREE_RATE_DAILY),
        var95: historicalVaR(portfolioStats.dailyPortfolioReturns, 0.95),
      }
    : null;

  // Concentration risk needs only the weights, so it is available whenever
  // there is at least one survivor, independent of whether the portfolio
  // return calculation itself succeeded.
  const hhi = survivors.length > 0 ? computeHHI(weighting) : null;

  // Share allocation is optional, only computed if the person entered an
  // investment amount.
  const shareAllocation =
    survivors.length > 0 && investmentAmount !== null && investmentAmount > 0
      ? computeShareAllocation(survivors, weighting, investmentAmount)
      : null;

  // Macro context: the yield curve is portfolio-wide, not per-ticker, so
  // it's fetched once per run rather than once per survivor. Optional and
  // non-fatal, same pattern as news, macro risk, and price targets.
  let yieldCurve = null;
  let yieldCurveError = null;
  if (fredKey) {
    try {
      yieldCurve = await fetchYieldCurve(fredKey);
    } catch (err) {
      yieldCurveError = err.message;
    }
  }

  // Rolling diagnostics: correlation across survivors, Sharpe on the
  // portfolio's own return series, and beta vs SPY. All three are optional
  // and non-fatal, following the same pattern as news and macro context.
  let rollingData = null;
  let rollingError = null;
  if (portfolioStats.ok === true && survivors.length >= 2) {
    try {
      const survivorReturnSeries = survivors.map((o) =>
        portfolioStats.dates.map((d) => o.returnsByDate.get(d))
      );
      const correlationShort = averagePairwiseRollingCorrelation(survivorReturnSeries, ROLLING_SHORT_WINDOW);
      const correlationLong = averagePairwiseRollingCorrelation(survivorReturnSeries, ROLLING_LONG_WINDOW);
      const sharpeShort = rollingSharpe(portfolioStats.dailyPortfolioReturns, ROLLING_SHORT_WINDOW);

      let betaShort = null;
      try {
        const spyPriceData = await queueTwelveDataCall(() => fetchPriceData('SPY', twelveDataKey));
        const spyReturnsByDate = returnsByDate(spyPriceData);
        const betaDates = commonDatesAcross([...survivors.map((o) => o.returnsByDate), spyReturnsByDate]);
        const portReturnsForBeta = weightedPortfolioReturnsForDates(survivors, weighting, betaDates);
        const spyReturnsForBeta = betaDates.map((d) => spyReturnsByDate.get(d));
        betaShort = { dates: betaDates, series: rollingBeta(portReturnsForBeta, spyReturnsForBeta, ROLLING_SHORT_WINDOW) };
      } catch (err) {
        console.warn('Rolling beta vs SPY unavailable:', err.message);
      }

      rollingData = {
        dates: portfolioStats.dates,
        correlationShort,
        correlationLong,
        sharpeShort,
        betaShort,
      };
    } catch (err) {
      rollingError = err.message;
    }
  }

  renderResults(outcomes, survivors, weighting, portfolioStats, additionalRiskMetrics, rollingData, rollingError, yieldCurve, yieldCurveError, hhi, shareAllocation);
});

// Twelve Data daily price history.
// This endpoint sends CORS headers, so it works directly from the browser.
// The free plan covers all US equities and ETFs (no ticker whitelist).
// Returns an array of daily bars sorted oldest to newest, each shaped as
// { date, open, high, low, close, volume } with numeric values.
// Replace or extend with moving average, MACD, RSI calculations from Day 1.
async function fetchPriceData(ticker, apiKey) {
  // outputsize is the number of most-recent daily bars. 200 gives roughly
  // 9-10 months of trading days, enough for a 90-day rolling window (the
  // instructor's "long" window in E_rolling_correlation.R and
  // F_rolling_metrics.R) to still produce a reasonable number of points.
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=200&apikey=${apiKey}`;
  const response = await fetch(url);

  // Read the body as text first, then parse it safely, so an unexpected
  // non-JSON response gives a readable error instead of "Unexpected token".
  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'Price fetch failed');
  }

  // Twelve Data reports problems as { code, status: "error", message }.
  if (raw && raw.status === 'error') throw new Error(raw.message || 'Price fetch failed');
  if (!response.ok) throw new Error('Price fetch failed');

  // Successful responses look like { meta, values: [ { datetime, open, ... } ] },
  // newest first. Normalize to numbers and sort oldest to newest so indicator
  // math (moving averages, RSI, ...) reads left to right.
  const values = raw.values ?? [];
  if (!values.length) throw new Error(`No price data returned for ${ticker}`);

  return values
    .map((b) => ({
      date: b.datetime,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume)
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// OpenRouter call. Only the price change and the RSI/MACD values your own
// code just calculated are handed to the model. The system prompt explicitly
// forbids inventing anything else (earnings, sector trends, "momentum" not
// implied by these numbers), so the note stays grounded in what was actually
// computed instead of the model's general knowledge about the company.
async function getResearchNote(ticker, priceData, signals, apiKey) {
  const first = priceData[0];
  const latest = priceData[priceData.length - 1];
  const pctChange = ((latest.close - first.close) / first.close) * 100;

  const systemPrompt =
    'You are a financial signal explainer. Only describe the numbers you are given: ' +
    'price change, RSI, and MACD. Do not invent or assume anything about earnings, ' +
    'news, sector trends, or company fundamentals that are not in the data provided. ' +
    'Write two to three plain prose sentences. Do not use markdown, bullet points, ' +
    'numbered lists, bold text, or dashes at the start of a line. Write ordinary ' +
    'sentences and paragraphs only.';

  const userPrompt =
    `${ticker} daily closes from ${first.date} to ${latest.date}: ` +
    `start $${first.close.toFixed(2)}, latest $${latest.close.toFixed(2)}, ` +
    `change ${pctChange.toFixed(1)}% over ${priceData.length} trading days.\n` +
    `RSI (14 day): ${signals.rsi ?? 'not enough data yet'}\n` +
    `MACD line: ${signals.macd ?? 'not enough data yet'}\n` +
    `MACD signal line: ${signals.macdSignal ?? 'not enough data yet'}\n\n` +
    `Explain what the RSI and MACD values above suggest right now, using only these numbers.`;

  return generateNote(apiKey, systemPrompt, userPrompt, 2000);
}

// Defensive cleanup for the AI note text. Free models sometimes ignore the
// "no markdown" instruction in the system prompt, so this strips leading
// bullet dashes/asterisks and bold markers per line and rejoins into plain
// prose, rather than trusting the model to follow formatting instructions.
//
// It also guards two failure shapes seen from the free router's rotating
// models: a reasoning capable model printing its full chain of thought
// instead of a final answer (implausibly long), and a moderation or guard
// style model returning a short status label like "User Safety: safe"
// instead of an actual note (implausibly short). A genuine two to three
// sentence note reliably falls well inside both bounds.
const NOTE_LENGTH_SAFETY_LIMIT = 1000;
const NOTE_MIN_LENGTH = 40;

function cleanNoteText(text) {
  const lines = text.split('\n');
  const cleanedLines = lines.map((line) => {
    let cleaned = line.trim();
    cleaned = cleaned.replace(/^[-*]\s+/, '');
    cleaned = cleaned.replace(/\*\*/g, '');
    return cleaned;
  });
  const nonEmptyLines = cleanedLines.filter((line) => line.length > 0);
  const joined = nonEmptyLines.join(' ');

  const isImplausiblyLong = joined.length > NOTE_LENGTH_SAFETY_LIMIT;
  if (isImplausiblyLong === true) {
    console.warn('Note text was unusually long, likely leaked reasoning. Full text:', joined);
    return (
      'The model returned an unusually long response, likely its internal reasoning rather than ' +
      'a final answer. This run has been flagged rather than shown, since it is more useful to know ' +
      'something went wrong than to display an unreliable note. Try Analyze again.'
    );
  }

  const isImplausiblyShort = joined.length < NOTE_MIN_LENGTH;
  if (isImplausiblyShort === true) {
    console.warn('Note text was unusually short, likely not a real answer. Full text:', joined);
    return (
      `The model returned an unusually short response ("${joined}"), which does not look like a ` +
      'real note. This run has been flagged rather than shown. Try Analyze again.'
    );
  }

  return joined;
}

// Pulls the useful part out of an OpenRouter error response: the HTTP status,
// a plain-language hint for the common cases, and the message OpenRouter (or
// the upstream provider) actually returned.
async function readOpenRouterError(response) {
  let message = '';
  try {
    const body = await response.json();
    const err = body.error ?? body;
    message = err.message || '';
    // On a "Provider returned error", the provider's own message is under
    // metadata rather than the top-level message field.
    const provider = err.metadata?.provider_name;
    const raw = err.metadata?.raw;
    if (provider) message += ` [provider: ${provider}]`;
    if (raw) message += ` ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
  } catch {
    // Response body was not JSON; the status code below still says something.
  }
  const hint = {
    401: 'Your API key looks invalid or missing',
    402: 'This model is paid and your OpenRouter account is out of credits',
    429: 'Rate limited, wait a moment and try again'
  }[response.status];
  return [`(HTTP ${response.status})`, hint, message].filter(Boolean).join(' ');
}

// outcomes is an array of either
//   { ticker, priceData, signals, returns, volatility, note, ok: true }
// or
//   { ticker, error, ok: false }
// survivors is the subset of outcomes that passed the RSI/MACD thesis.
// weighting is the result of inverseVolatilityWeights() over those survivors.
function renderResults(outcomes, survivors, weighting, portfolioStats, additionalRiskMetrics, rollingData, rollingError, yieldCurve, yieldCurveError, hhi, shareAllocation) {
  const summaryHtml = renderPortfolioSummary(outcomes, survivors, weighting, portfolioStats, additionalRiskMetrics, rollingData, rollingError, yieldCurve, yieldCurveError, hhi, shareAllocation);

  const cardsHtml = outcomes
    .map((outcome) => {
      if (!outcome.ok) {
        return `
          <div class="ticker-card">
            <h2>${outcome.ticker}</h2>
            <p class="error">Something went wrong: ${outcome.error}</p>
          </div>
        `;
      }
      // priceData is sorted oldest to newest, so the last bar is the most recent.
      const latest = outcome.priceData[outcome.priceData.length - 1];
      const s = outcome.signals;
      const isSurvivor = survivors.some((sv) => sv.ticker === outcome.ticker);
      const weightInfo = isSurvivor ? weighting.weights[outcome.ticker] : null;
      const weightLine = weightInfo
        ? `<p class="weight">Portfolio weight: ${(weightInfo.weight * 100).toFixed(1)}% (volatility: ${(weightInfo.volatility * 100).toFixed(2)}% daily)</p>`
        : `<p class="excluded">Excluded from portfolio: ${exclusionReason(outcome, survivors, weighting)}</p>`;
      const id = safeId(outcome.ticker);
      const priceTargetLine = renderPriceTarget(outcome, latest.close);
      const signalLine = renderSignal(outcome.signal);
      const positionLine = renderPositionLevels(outcome.positionLevels);
      return `
        <div class="ticker-card">
          <h2>${outcome.ticker}</h2>
          <p class="price">Latest close (${latest.date}): $${latest.close.toFixed(2)}</p>
          <p class="signals">
            RSI (14): ${s.rsi ?? '—'} &nbsp;|&nbsp;
            MACD: ${s.macd ?? '—'} &nbsp;|&nbsp;
            MACD signal: ${s.macdSignal ?? '—'}
          </p>
          ${signalLine}
          ${weightLine}
          ${positionLine}
          ${priceTargetLine}
          <p class="note">${outcome.note}</p>
          <div class="chart-row">
            <div class="chart-block"><canvas id="price-chart-${id}"></canvas></div>
            <div class="chart-block"><canvas id="macd-chart-${id}"></canvas></div>
            <div class="chart-block"><canvas id="rsi-chart-${id}"></canvas></div>
          </div>
          ${renderNews(outcome)}
        </div>
      `;
    })
    .join('');

  results.innerHTML = summaryHtml + cardsHtml;

  // Canvases only exist in the DOM after the innerHTML assignment above, so
  // charts are drawn in a second pass rather than during string building.
  for (const outcome of outcomes) {
    if (outcome.ok) drawCharts(outcome);
  }
  if (rollingData) drawRollingCharts(rollingData);
  if (survivors.length > 0) drawWeightsPieChart(survivors, weighting);
}

// Draws a pie chart of the survivors' portfolio weights, a visual companion
// to the percentage list already shown.
function drawWeightsPieChart(survivors, weighting) {
  const canvas = document.getElementById('weights-pie-chart');
  if (!canvas) return;

  const pieColors = ['#9a6b2c', '#14213d', '#3a7d5c', '#a6302c', '#6b4c9a', '#c98a2e', '#2e7d9a', '#8a2e6b'];

  const labels = survivors.map((s) => s.ticker);
  const data = survivors.map((s) => weighting.weights[s.ticker].weight * 100);
  const colors = survivors.map((_, i) => pieColors[i % pieColors.length]);

  const existing = Chart.getChart('weights-pie-chart');
  if (existing) existing.destroy();

  new Chart(canvas, {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: '#fafaf7', borderWidth: 2 }],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${context.parsed.toFixed(1)}%`,
          },
        },
      },
    },
  });
}

// Renders up to 3 related headlines for a ticker, or a short explanatory
// line if no NewsData.io key was provided or the news fetch failed. News is
// purely supplementary context here, never fed to the AI note, so a missing
// or failed fetch never blocks the rest of the card.
// Shows the analyst consensus price target range, and how the current price
// compares to the consensus, as a plain percentage. This is genuinely
// forward looking context, not derived from the price history the rest of
// the card is built from.
// Shows the BUY/HOLD/SELL badge with its confidence score and the plain
// English reason behind it.
function renderSignal(signal) {
  if (!signal || signal.label === 'N/A') {
    return '';
  }
  const cssClass = { BUY: 'signal-buy', HOLD: 'signal-hold', SELL: 'signal-sell' }[signal.label];
  return `
    <p class="signal-line">
      <span class="signal-badge ${cssClass}">${signal.label}</span>
      confidence: ${signal.confidence}/100
      <span class="days-used">(${signal.reason})</span>
    </p>
  `;
}

// Shows the ATR based stop-loss and take-profit levels, the standard
// professional convention (stop distance scales with the stock's own
// typical movement) rather than an arbitrary percentage.
function renderPositionLevels(positionLevels) {
  if (!positionLevels) {
    return '';
  }
  return `
    <p class="portfolio-stats">
      ATR: $${positionLevels.atr.toFixed(2)} &nbsp;|&nbsp;
      Suggested stop-loss: $${positionLevels.stopLoss.toFixed(2)} &nbsp;|&nbsp;
      Suggested take-profit: $${positionLevels.takeProfit.toFixed(2)}
    </p>
  `;
}

function renderPriceTarget(outcome, currentPrice) {
  if (outcome.priceTarget === null && outcome.priceTargetError === null) {
    return '';
  }
  if (outcome.priceTargetError) {
    return `<p class="excluded">Analyst price target unavailable: ${outcome.priceTargetError}</p>`;
  }
  const pt = outcome.priceTarget;
  const upside = ((pt.consensus - currentPrice) / currentPrice) * 100;
  const direction = upside >= 0 ? 'upside' : 'downside';
  return `
    <p class="price-target">
      Analyst consensus target: $${pt.consensus.toFixed(2)}
      (range $${pt.low.toFixed(2)} to $${pt.high.toFixed(2)}, median $${pt.median.toFixed(2)})
      &nbsp;|&nbsp; ${Math.abs(upside).toFixed(1)}% ${direction} from current price
    </p>
  `;
}

function renderNews(outcome) {
  if (outcome.news === null && outcome.newsError === null) {
    return '';
  }
  if (outcome.newsError) {
    return `<p class="excluded">Headlines unavailable: ${outcome.newsError}</p>`;
  }
  if (!outcome.news || outcome.news.length === 0) {
    return `<p class="excluded">No recent headlines found for ${outcome.ticker}.</p>`;
  }
  const items = outcome.news
    .map(
      (item) => `
        <li>
          <a href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
          <span class="news-meta">${item.source ?? ''}</span>
        </li>
      `
    )
    .join('');
  return `<div class="news"><h3>Related headlines</h3><ul>${items}</ul></div>`;
}

// Portfolio level summary: how many tickers survived the thesis filter, and
// whether the weights actually sum to 1 (surfaced clearly per the
// instructor's guardrail, rather than silently trusting the math).
function renderPortfolioSummary(outcomes, survivors, weighting, portfolioStats, additionalRiskMetrics, rollingData, rollingError, yieldCurve, yieldCurveError, hhi, shareAllocation) {
  const total = outcomes.length;
  const survivorCount = survivors.length;

  if (survivorCount === 0) {
    return `
      <div class="portfolio-summary">
        <h2>Portfolio</h2>
        <p class="error">None of the ${total} ticker(s) passed the thesis (RSI under 70 and MACD above its signal line).</p>
      </div>
    `;
  }

  const weightRows = survivors
    .map((s) => {
      const w = weighting.weights[s.ticker];
      if (!w) return '';
      return `<li>${s.ticker}: ${(w.weight * 100).toFixed(1)}%</li>`;
    })
    .join('');

  const sumWarning = weighting.weightsAreValid
    ? ''
    : `<p class="error">Warning: weights do not sum to 1. Check the volatility calculation before trusting these numbers.</p>`;

  const droppedNote = weighting.dropped.length
    ? `<p class="excluded">Dropped from weighting (zero or missing volatility): ${weighting.dropped.join(', ')}</p>`
    : '';

  const statsHtml = portfolioStats.ok
    ? `<p class="portfolio-stats">
        Annualized return: ${(portfolioStats.annualizedReturn * 100).toFixed(1)}% &nbsp;|&nbsp;
        Annualized volatility: ${(portfolioStats.annualizedVolatility * 100).toFixed(1)}%
        <span class="days-used">(${portfolioStats.daysUsed} overlapping trading days)</span>
      </p>`
    : `<p class="excluded">Portfolio return/volatility not available: ${portfolioStats.message}</p>`;

  const riskMetricsHtml = additionalRiskMetrics
    ? `<p class="portfolio-stats">
        Max drawdown: ${(additionalRiskMetrics.maxDrawdownPct * 100).toFixed(1)}% &nbsp;|&nbsp;
        Sortino ratio: ${additionalRiskMetrics.sortino === null ? 'undefined (no down days)' : additionalRiskMetrics.sortino.toFixed(2)} &nbsp;|&nbsp;
        95% daily VaR: ${(additionalRiskMetrics.var95 * 100).toFixed(2)}%
      </p>`
    : '';

  const hhiHtml = hhi
    ? `<p class="portfolio-stats">
        Concentration (HHI): ${hhi.hhi.toFixed(3)} vs. equal-weight benchmark ${hhi.equalWeightBenchmark.toFixed(3)}
        <span class="days-used">(${hhi.read})</span>
      </p>`
    : '';

  const shareAllocationHtml = renderShareAllocation(shareAllocation);

  const yieldCurveHtml = renderYieldCurve(yieldCurve, yieldCurveError);

  const rollingHtml = renderRollingSection(survivorCount, rollingData, rollingError);

  return `
    <div class="portfolio-summary">
      <h2>Portfolio (${survivorCount} of ${total} passed the thesis)</h2>
      <div class="weight-row">
        <ul>${weightRows}</ul>
        <div class="chart-block pie-block"><canvas id="weights-pie-chart"></canvas></div>
      </div>
      ${statsHtml}
      ${riskMetricsHtml}
      ${hhiHtml}
      ${shareAllocationHtml}
      ${yieldCurveHtml}
      ${sumWarning}
      ${droppedNote}
      ${rollingHtml}
    </div>
  `;
}

// Renders the share allocation table: how many whole shares of each
// survivor to buy given the entered investment amount, and how much cash is
// left unspent from rounding down. Returns an empty string if no investment
// amount was entered, so the section simply does not appear.
function renderShareAllocation(shareAllocation) {
  if (!shareAllocation) {
    return '';
  }

  const rows = Object.entries(shareAllocation.perTicker)
    .map(([ticker, a]) => {
      return `<li>${ticker}: ${a.shares} share(s) @ $${a.price.toFixed(2)} = $${a.spent.toFixed(2)} spent, $${a.leftover.toFixed(2)} left over from rounding</li>`;
    })
    .join('');

  return `
    <h3 class="rolling-title">Share allocation</h3>
    <ul>${rows}</ul>
    <p class="portfolio-stats">
      Total invested: $${shareAllocation.totalInvested.toFixed(2)} &nbsp;|&nbsp;
      Total cash remaining: $${shareAllocation.totalCashRemaining.toFixed(2)}
    </p>
  `;
}

// Shows the 10 year minus 2 year Treasury spread with a plain language read.
// Positive is the normal, healthy shape. Negative (inverted) is the
// historically watched recession warning. This is genuinely independent of
// everything else in the app, it says nothing about any specific ticker,
// only about the broader economic backdrop the whole portfolio sits inside.
function renderYieldCurve(yieldCurve, yieldCurveError) {
  if (yieldCurve === null && yieldCurveError === null) {
    return '';
  }
  if (yieldCurveError) {
    return `<p class="excluded">Yield curve data unavailable: ${yieldCurveError}</p>`;
  }
  const isInverted = yieldCurve.value < 0;
  const read = isInverted
    ? 'inverted, a historically watched recession warning sign'
    : 'normal shape, not currently signaling a recession warning by this measure';
  return `
    <p class="portfolio-stats">
      10yr-2yr Treasury spread (${yieldCurve.date}): ${yieldCurve.value.toFixed(2)} points, ${read}
    </p>
  `;
}

// Shows the latest value of each rolling diagnostic plus the three charts.
// Requires at least 2 survivors (correlation needs a pair) and enough
// history for the rolling windows to have produced at least one value.
function renderRollingSection(survivorCount, rollingData, rollingError) {
  if (survivorCount < 2) {
    return `<p class="excluded">Rolling diagnostics need at least 2 surviving tickers.</p>`;
  }
  if (rollingError) {
    return `<p class="excluded">Rolling diagnostics unavailable: ${rollingError}</p>`;
  }
  if (!rollingData) {
    return '';
  }

  const lastValid = (arr) => {
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && !Number.isNaN(arr[i])) return arr[i];
    }
    return null;
  };

  const latestCorrShort = lastValid(rollingData.correlationShort);
  const latestCorrLong = lastValid(rollingData.correlationLong);
  const latestSharpe = lastValid(rollingData.sharpeShort);
  const latestBeta = rollingData.betaShort ? lastValid(rollingData.betaShort.series) : null;

  const fmt = (v, decimals = 2) => (v === null ? '—' : v.toFixed(decimals));

  return `
    <h3 class="rolling-title">Rolling diagnostics</h3>
    <p class="portfolio-stats">
      Avg pairwise correlation (30d / 90d): ${fmt(latestCorrShort)} / ${fmt(latestCorrLong)} &nbsp;|&nbsp;
      Rolling Sharpe (30d): ${fmt(latestSharpe)} &nbsp;|&nbsp;
      Rolling beta vs SPY (30d): ${latestBeta === null ? 'unavailable' : fmt(latestBeta)}
    </p>
    <div class="chart-row">
      <div class="chart-block"><canvas id="rolling-correlation-chart"></canvas></div>
      <div class="chart-block"><canvas id="rolling-sharpe-chart"></canvas></div>
      <div class="chart-block"><canvas id="rolling-beta-chart"></canvas></div>
    </div>
  `;
}

// Draws the three portfolio-level rolling charts. Called after the summary
// HTML (including their canvases) is already in the DOM.
function drawRollingCharts(rollingData) {
  const labels = rollingData.dates;

  if (rollingData.correlationShort && document.getElementById('rolling-correlation-chart')) {
    drawChart('rolling-correlation-chart', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '30d avg correlation', data: rollingData.correlationShort, borderColor: '#14213d', pointRadius: 0, borderWidth: 1.5 },
          { label: '90d avg correlation', data: rollingData.correlationLong, borderColor: '#9a6b2c', pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: chartOptions({ scales: { x: { ticks: { maxTicksLimit: 6, font: { size: 9 } } }, y: { min: -1, max: 1, ticks: { font: { size: 9 } } } } }),
    });
  }

  if (rollingData.sharpeShort && document.getElementById('rolling-sharpe-chart')) {
    drawChart('rolling-sharpe-chart', {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: '30d rolling Sharpe', data: rollingData.sharpeShort, borderColor: '#14213d', pointRadius: 0, borderWidth: 1.5 }],
      },
      options: chartOptions(),
    });
  }

  if (rollingData.betaShort && document.getElementById('rolling-beta-chart')) {
    drawChart('rolling-beta-chart', {
      type: 'line',
      data: {
        labels: rollingData.betaShort.dates,
        datasets: [{ label: '30d rolling beta vs SPY', data: rollingData.betaShort.series, borderColor: '#14213d', pointRadius: 0, borderWidth: 1.5 }],
      },
      options: chartOptions(),
    });
  }
}

// Explains, in plain English, why a ticker that fetched successfully did not
// make it into the weighted portfolio, so the "Excluded" line on its card is
// specific rather than a generic message.
function exclusionReason(outcome, survivors, weighting) {
  const s = outcome.signals;
  if (s.rsi === null || s.macd === null || s.macdSignal === null) {
    return 'not enough price history yet for a full signal reading';
  }
  if (weighting.dropped.includes(outcome.ticker)) {
    return 'zero or missing volatility, cannot weight safely';
  }
  if (s.rsi >= 70) {
    return `RSI is ${s.rsi}, overbought (70 or above)`;
  }
  if (s.macd <= s.macdSignal) {
    return 'MACD is not above its signal line';
  }
  return 'did not pass the thesis';
}
