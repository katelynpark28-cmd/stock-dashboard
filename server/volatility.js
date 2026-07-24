import YahooFinanceClass from 'yahoo-finance2';

const yahooFinance = new YahooFinanceClass({ suppressNotices: ['yahooSurvey'] });

// Liquid, well-known high-beta names — the pool the growth screener ranks
// and the auto-trader bot's daily watchlist draws its top picks from.
export const GROWTH_UNIVERSE = [
  'MSTR', 'COIN', 'HOOD', 'TSLA', 'NVDA', 'AMD', 'PLTR', 'SMCI', 'CRWD', 'NET',
  'DDOG', 'SNOW', 'SHOP', 'SPOT', 'UBER', 'ARM', 'META', 'AMZN', 'NFLX', 'CRM',
  'NOW', 'ADBE', 'IONQ', 'DKNG', 'RBLX', 'SOFI', 'UPST', 'AXON', 'CELH', 'HIMS',
];

export const STABLE_UNIVERSE = [
  'BRK-B', 'JNJ', 'PG', 'KO', 'WMT', 'HD', 'V', 'MA', 'MSFT', 'AAPL',
  'UNH', 'ABBV', 'MRK', 'CVX', 'XOM', 'LLY', 'JPM', 'BAC', 'GS', 'WFC',
  'MCD', 'PEP', 'CL', 'NEE', 'DUK', 'T', 'VZ', 'COST', 'TGT', 'LOW',
];

// Realized volatility over the trailing ~20 trading days (annualized stddev
// of daily log returns), as a percentage. This measures whether a stock is
// ACTUALLY swinging right now — unlike the 52-week high/low range, which
// stays "wide" forever after a single one-off spike even if the stock has
// been flat for months since.
export function annualizedRecentVolatility(closes) {
  const window = closes.slice(-21); // ~20 return observations
  if (window.length < 6) return null;
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0 && window[i] > 0) returns.push(Math.log(window[i] / window[i - 1]));
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

export async function fetchRecentVolatility(symbol) {
  const chart = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 45 * 86400000),
    period2: new Date(),
    interval: '1d',
  });
  const closes = (chart.quotes || []).map(q => q.close).filter(c => c != null && c > 0);
  return annualizedRecentVolatility(closes);
}

// Ranks a universe of symbols by current realized volatility, highest first.
// Symbols whose volatility can't be computed are dropped.
export async function rankByVolatility(universe) {
  const scored = await Promise.all(universe.map(async symbol => {
    const vol = await fetchRecentVolatility(symbol).catch(() => null);
    return { symbol, volatility: vol };
  }));
  return scored
    .filter(s => s.volatility != null)
    .sort((a, b) => b.volatility - a.volatility);
}

// ATR(14)-based stop-loss/take-profit suggestion per symbol — wider exits for
// choppier stocks, tighter for calmer ones. Shared by the manual "Auto-set
// from volatility" button and the bot's automatic daily refresh.
export async function computeAtrLevels(symbols) {
  const period1 = new Date(Date.now() - 30 * 86400000);
  const results = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const chart = await yahooFinance.chart(sym, { period1, period2: new Date(), interval: '1d' });
      const quotes = (chart.quotes || []).filter(q => q.high != null && q.low != null && q.close != null);
      if (quotes.length < 15) return;
      const trs = [];
      for (let i = 1; i < quotes.length; i++) {
        const h = quotes[i].high, l = quotes[i].low, pc = quotes[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.slice(-14).length);
      const price = quotes[quotes.length - 1].close;
      const atrPct = (atr14 / price) * 100;
      const sl = +(atrPct * -2).toFixed(1);
      const tp = +(atrPct * 4).toFixed(1);
      results[sym] = { atr: +atr14.toFixed(2), atrPct: +atrPct.toFixed(2), stopLossPct: sl, takeProfitPct: tp };
    } catch {}
  }));
  return results;
}
