import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinanceClass from 'yahoo-finance2';
import Groq from 'groq-sdk';
import 'dotenv/config';
import { getAccountSummary, getPositions, getRecentOrders } from './alpaca.js';
import { trader } from './trader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Last-resort safety net: a stray rejection or async error must never take the
// whole API server down (that's what caused the 502). Log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.message || err);
});

const yahooFinance = new YahooFinanceClass({ suppressNotices: ['yahooSurvey'] });

// Simple in-memory cache to avoid Yahoo Finance rate limits (429s)
const _cache = new Map();
function cached(key, ttlMs, fn) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);
  return fn().then(data => { _cache.set(key, { data, time: Date.now() }); return data; });
}

const app = express();
app.use(cors());
app.use(express.json());

// Ticker search by name or symbol
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json([]);
    const result = await yahooFinance.search(q, { newsCount: 0 });
    const hits = (result.quotes || [])
      .filter(r => r.symbol && (r.quoteType === 'EQUITY' || r.quoteType === 'ETF'))
      .slice(0, 8)
      .map(r => ({
        symbol: r.symbol,
        name: r.longname || r.shortname || r.symbol,
        exchange: r.exchDisp || r.exchange,
        type: r.quoteType,
      }));
    res.json(hits);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Lightweight live quote for polling (uses chart() to avoid crumb/429 issues)
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const chart = await cached(`quotechart:${req.params.symbol}`, 30000, () =>
      yahooFinance.chart(req.params.symbol, { period1: new Date(Date.now() - 2 * 86400000), period2: new Date(), interval: '1d' })
    );
    const meta = chart.meta || {};
    const quotes = (chart.quotes || []).filter(q => q.close != null);
    const last = quotes.length ? quotes[quotes.length - 1] : {};
    const price = meta.regularMarketPrice || last.close;
    const prev = meta.chartPreviousClose || (quotes.length > 1 ? quotes[quotes.length - 2].close : null);
    res.json({
      price,
      change: prev ? price - prev : null,
      changePct: prev ? ((price - prev) / prev) * 100 : null,
      high: last.high || meta.regularMarketDayHigh,
      low: last.low || meta.regularMarketDayLow,
      volume: last.volume || null,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Company profile + quote (uses chart() for price data to avoid crumb/429 issues)
app.get('/api/profile/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const [chart, summary] = await Promise.all([
      cached(`profilechart:${symbol}`, 30000, () =>
        yahooFinance.chart(symbol, { period1: new Date(Date.now() - 5 * 86400000), period2: new Date(), interval: '1d' })
      ),
      cached(`summary:${symbol}`, 300000, () => yahooFinance.quoteSummary(symbol, { modules: ['assetProfile', 'financialData', 'defaultKeyStatistics'] })),
    ]);
    const meta = chart.meta || {};
    const quotes = (chart.quotes || []).filter(q => q.close != null);
    const last = quotes.length ? quotes[quotes.length - 1] : {};
    const prev = meta.chartPreviousClose || (quotes.length > 1 ? quotes[quotes.length - 2].close : null);
    const quote = {
      symbol,
      shortName: meta.shortName || symbol,
      regularMarketPrice: meta.regularMarketPrice || last.close,
      regularMarketChange: prev ? (meta.regularMarketPrice || last.close) - prev : null,
      regularMarketChangePercent: prev ? (((meta.regularMarketPrice || last.close) - prev) / prev) * 100 : null,
      regularMarketDayHigh: last.high || null,
      regularMarketDayLow: last.low || null,
      regularMarketVolume: last.volume || null,
      regularMarketPreviousClose: prev,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
      marketCap: meta.marketCap || null,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || meta.fullExchangeName || '',
    };
    res.json({ quote, assetProfile: summary.assetProfile, financialData: summary.financialData, keyStats: summary.defaultKeyStatistics });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Financials using fundamentalsTimeSeries
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const period1 = '1985-01-01';

    const [finA, bsA, cfA, finQ, bsQ, cfQ] = await Promise.all([
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'financials',   period1, type: 'annual'    }),
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'balance-sheet',period1, type: 'annual'    }),
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'cash-flow',    period1, type: 'annual'    }),
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'financials',   period1, type: 'quarterly' }),
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'balance-sheet',period1, type: 'quarterly' }),
      yahooFinance.fundamentalsTimeSeries(symbol, { module: 'cash-flow',    period1, type: 'quarterly' }),
    ]);

    // Combine annual (12M) and quarterly (3M) into single arrays
    const financials   = [...finA, ...finQ];
    const balanceSheet = [...bsA,  ...bsQ];
    const cashFlow     = [...cfA,  ...cfQ];

    res.json({ financials, balanceSheet, cashFlow });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Historical price data
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { period = '5y', interval = '1mo' } = req.query;

    const now = new Date();
    let period1;
    if (period === '1d')       period1 = new Date(now - 2 * 86400000);
    else if (period === '1w')  period1 = new Date(now - 7 * 86400000);
    else if (period === '1mo') period1 = new Date(now - 30 * 86400000);
    else if (period === 'ytd') period1 = new Date(now.getFullYear(), 0, 1);
    else if (period === '1y')  period1 = new Date(now - 365 * 86400000);
    else if (period === '5y')  period1 = new Date(now - 5 * 365 * 86400000);
    else                       period1 = new Date('1990-01-01');

    const data = await cached(`history:${symbol}:${period}:${interval}`, 60000, () => yahooFinance.chart(symbol, { period1, period2: now, interval }));
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// AI analysis via Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.post('/api/analyze', async (req, res) => {
  try {
    const { profile, income, balance, cashflow, ratios } = req.body;

    const fmt = (n) => {
      if (n == null) return 'N/A';
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      if (abs >= 1e12) return `${sign}$${(abs/1e12).toFixed(2)}T`;
      if (abs >= 1e9)  return `${sign}$${(abs/1e9).toFixed(1)}B`;
      if (abs >= 1e6)  return `${sign}$${(abs/1e6).toFixed(1)}M`;
      return `${sign}$${abs.toFixed(2)}`;
    };
    const pct = (n) => n != null ? `${(n*100).toFixed(1)}%` : 'N/A';

    const recent = (arr, key, n=4) => arr.slice(0,n).map(r => `${r.date?.slice(0,7)}: ${fmt(r[key])}`).join(', ');
    const recentPct = (arr, key, n=4) => arr.slice(0,n).map(r => `${r.date?.slice(0,7)}: ${pct(r[key])}`).join(', ');

    const prompt = `You are a financial analyst. Analyze the following data for ${profile.companyName} (${profile.symbol}) and give a clear, direct, opinionated summary. Be concise but insightful. Write for a smart non-expert investor.

COMPANY: ${profile.companyName} (${profile.symbol})
Sector: ${profile.sector} | Industry: ${profile.industry}
Current Price: $${profile.price?.toFixed(2)} | Market Cap: ${fmt(profile.mktCap)}

INCOME (most recent years):
- Revenue: ${recent(income, 'revenue')}
- Gross Profit: ${recent(income, 'grossProfit')}
- Operating Income: ${recent(income, 'operatingIncome')}
- Net Income: ${recent(income, 'netIncome')}

MARGINS (current):
- Gross Margin: ${pct(ratios[0]?.grossProfitMargin)}
- Operating Margin: ${pct(ratios[0]?.operatingProfitMargin)}
- Net Margin: ${pct(ratios[0]?.netProfitMargin)}
- Return on Equity: ${pct(ratios[0]?.returnOnEquity)}

BALANCE SHEET (most recent):
- Total Assets: ${fmt(balance[0]?.totalAssets)}
- Total Debt: ${fmt(balance[0]?.totalDebt)}
- Cash: ${fmt(balance[0]?.cashAndCashEquivalents)}
- Shareholders Equity: ${fmt(balance[0]?.totalStockholdersEquity)}

CASH FLOW (most recent years):
- Operating CF: ${recent(cashflow, 'operatingCashFlow')}
- Free Cash Flow: ${recent(cashflow, 'freeCashFlow')}

VALUATION:
- P/E: ${ratios[0]?.priceEarningsRatio?.toFixed(1) ?? 'N/A'}
- EV/EBITDA: ${ratios[0]?.enterpriseValueMultiple?.toFixed(1) ?? 'N/A'}
- P/FCF: ${ratios[0]?.priceToFreeCashFlowsRatio?.toFixed(1) ?? 'N/A'}
- Debt/Equity: ${ratios[0]?.debtEquityRatio?.toFixed(2) ?? 'N/A'}

Respond in this exact JSON format:
{
  "summary": "2-3 sentence plain-English overview of what this company is and how it's performing",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "concerns": ["concern 1", "concern 2"],
  "verdict": "One punchy sentence: buy/hold/avoid and why, based purely on the fundamentals shown"
}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    });

    const result = JSON.parse(completion.choices[0].message.content);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dynamic screener — ranks by fundamentals + momentum, then uses AI for rationale
const GROWTH_UNIVERSE = [
  'MSTR','COIN','HOOD','TSLA','NVDA','AMD','PLTR','SMCI','CRWD','NET',
  'DDOG','SNOW','SHOP','SPOT','UBER','ARM','META','AMZN','NFLX','CRM',
  'NOW','ADBE','IONQ','DKNG','RBLX','SOFI','UPST','AXON','CELH','HIMS',
];

const STABLE_UNIVERSE = [
  'BRK-B','JNJ','PG','KO','WMT','HD','V','MA','MSFT','AAPL',
  'UNH','ABBV','MRK','CVX','XOM','LLY','JPM','BAC','GS','WFC',
  'MCD','PEP','CL','NEE','DUK','T','VZ','COST','TGT','LOW',
];

function scoreGrowth(q) {
  if (q.recentVolatility == null) return 0;
  // Filter out crashed stocks — must be within 35% of 52-week high
  const momentum = q.fiftyTwoWeekHigh ? q.regularMarketPrice / q.fiftyTwoWeekHigh : 1;
  if (momentum < 0.65) return 0;
  // Filter out stocks with negative forward EPS
  if (q.epsForward != null && q.epsForward < 0) return 0;
  // EPS growth bonus: forward EPS > trailing EPS
  const epsGrowth = (q.epsForward > 0 && q.epsTrailingTwelveMonths > 0 && q.epsForward > q.epsTrailingTwelveMonths) ? 1.4 : 1.0;
  return q.recentVolatility * momentum * epsGrowth;
}

function scoreStable(q) {
  if (!q.marketCap || q.marketCap < 50e9) return 0;
  if (q.recentVolatility == null) return 0;
  // Must have positive trailing EPS
  if (q.epsTrailingTwelveMonths != null && q.epsTrailingTwelveMonths <= 0) return 0;
  // Reward dividend payers
  const divBonus = q.dividendYield > 0 ? 1.3 : 1.0;
  // Lower recent volatility = higher score (invert)
  return (1 / (q.recentVolatility + 1)) * divBonus;
}

// Realized volatility over the trailing ~20 trading days (annualized stddev
// of daily log returns), as a percentage. This measures whether a stock is
// ACTUALLY swinging right now — unlike the 52-week high/low range, which
// stays "wide" forever after a single one-off spike even if the stock has
// been flat for months since.
function annualizedRecentVolatility(closes) {
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

async function fetchRecentVolatility(symbol) {
  const chart = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 45 * 86400000),
    period2: new Date(),
    interval: '1d',
  });
  const closes = (chart.quotes || []).map(q => q.close).filter(c => c != null && c > 0);
  return annualizedRecentVolatility(closes);
}

// FMP quote data doesn't need Yahoo's crumb token, so it isn't 429'd on Render.
// The free-tier key doesn't support batched multi-symbol requests, so each
// symbol is fetched (and cached) individually; both screener modes share the
// same per-symbol cache.
async function fetchFmpQuote(symbol) {
  const key = process.env.VITE_FMP_API_KEY;
  if (!key) throw new Error('FMP API key missing');
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${symbol}&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP error ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('FMP returned no data');
  return data[0];
}

app.get('/api/screener', async (req, res) => {
  try {
    const { mode = 'stable' } = req.query;
    const universe = mode === 'growth' ? GROWTH_UNIVERSE : STABLE_UNIVERSE;

    const quotes = await Promise.all(universe.map(async s => {
      const [q, recentVolatility] = await Promise.all([
        cached(`fmpquote:${s}`, 3600000, () => fetchFmpQuote(s)).catch(() => null),
        cached(`recentvol:${s}`, 3600000, () => fetchRecentVolatility(s)).catch(() => null),
      ]);
      if (!q) return null;
      return {
        symbol: s,
        shortName: q.name || s,
        longName: q.name || s,
        regularMarketPrice: q.price ?? null,
        regularMarketChangePercent: q.changePercentage ?? null,
        fiftyTwoWeekHigh: q.yearHigh ?? null,
        fiftyTwoWeekLow: q.yearLow ?? null,
        epsTrailingTwelveMonths: q.eps ?? null,
        epsForward: null,
        beta: null,
        trailingPE: q.pe ?? null,
        forwardPE: null,
        marketCap: q.marketCap ?? null,
        dividendYield: null,
        recentVolatility,
      };
    }));
    const valid = quotes.filter(q => q && q.regularMarketPrice > 0);

    const scored = valid
      .map(q => ({ ...q, _score: mode === 'growth' ? scoreGrowth(q) : scoreStable(q) }))
      .filter(q => q._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);

    // Ask Groq for a one-sentence reason for each pick
    const stockList = scored.map(q =>
      `${q.symbol} (${q.longName || q.shortName}): price $${q.regularMarketPrice?.toFixed(2)}, ` +
      `52w range $${q.fiftyTwoWeekLow?.toFixed(0)}–$${q.fiftyTwoWeekHigh?.toFixed(0)}, ` +
      `EPS TTM ${q.epsTrailingTwelveMonths?.toFixed(2) ?? 'N/A'}, EPS fwd ${q.epsForward?.toFixed(2) ?? 'N/A'}, ` +
      `beta ${q.beta?.toFixed(2) ?? 'N/A'}`
    ).join('\n');

    const prompt = mode === 'growth'
      ? `These stocks were selected as high-growth volatile picks based on momentum and earnings trajectory. For each one, write a single sentence (max 12 words) explaining why it's a compelling volatile/growth trade right now. Be specific to the company, not generic.\n\n${stockList}\n\nRespond as JSON: {"reasons": {"SYMBOL": "reason", ...}}`
      : `These stocks were selected as long-term stable picks based on low volatility and earnings consistency. For each one, write a single sentence (max 12 words) explaining why it's a reliable long-term hold. Be specific to the company, not generic.\n\n${stockList}\n\nRespond as JSON: {"reasons": {"SYMBOL": "reason", ...}}`;

    let reasons = {};
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      });
      reasons = JSON.parse(completion.choices[0].message.content).reasons || {};
    } catch (e) { console.error('screener reasons failed:', e.message); }

    res.json(scored.map(q => ({
      symbol: q.symbol,
      name: q.longName || q.shortName,
      beta: q.beta,
      rangeScore: q.recentVolatility != null ? +q.recentVolatility.toFixed(1) : null,
      high52w: q.fiftyTwoWeekHigh,
      low52w: q.fiftyTwoWeekLow,
      dividendYield: q.dividendYield,
      marketCap: q.marketCap,
      pe: q.trailingPE,
      epsForward: q.epsForward,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      reason: reasons[q.symbol] || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Market overview — accepts comma-separated symbols query param
app.get('/api/market-overview', async (req, res) => {
  try {
    const symbols = req.query.symbols
      ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'AVGO', 'JPM'];
    const period1 = new Date(Date.now() - 365 * 86400000);
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const [chartData, history] = await Promise.all([
          cached(`mktquote:${symbol}`, 30000, () =>
            yahooFinance.chart(symbol, { period1: new Date(Date.now() - 5 * 86400000), period2: new Date(), interval: '1d' })
          ),
          cached(`mktovw:${symbol}`, 3600000, () => yahooFinance.chart(symbol, { period1, period2: new Date(), interval: '1d' })),
        ]);
        const m = chartData.meta || {};
        const qs = (chartData.quotes || []).filter(q => q.close != null);
        const last = qs.length ? qs[qs.length - 1] : {};
        const prev = m.chartPreviousClose || (qs.length > 1 ? qs[qs.length - 2].close : null);
        const price = m.regularMarketPrice || last.close;
        const quote = {
          symbol, shortName: m.shortName || symbol,
          regularMarketPrice: price,
          regularMarketChange: prev ? price - prev : null,
          regularMarketChangePercent: prev ? ((price - prev) / prev) * 100 : null,
          regularMarketDayHigh: last.high || null,
          regularMarketDayLow: last.low || null,
          regularMarketVolume: last.volume || null,
        };
        return { symbol, quote, history };
      })
    );
    res.json(results);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Chatbot
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, stock } = req.body;
    const system = stock
      ? `You are StocKP Assistant, an expert financial analyst embedded in a stock research dashboard. The user is currently viewing ${stock}. Answer questions about this stock and general investing clearly and concisely. Be direct and opinionated where helpful. Never give generic disclaimers — the user knows investing involves risk.`
      : `You are StocKP Assistant, an expert financial analyst embedded in a stock research dashboard. Answer questions about stocks, markets, and investing clearly and concisely. Be direct and opinionated where helpful.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      temperature: 0.5,
      max_tokens: 512,
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// News for a ticker
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const result = await yahooFinance.search(symbol, { newsCount: 12, quotesCount: 0 });
    const articles = (result.news || []).map(n => ({
      title: n.title,
      link: n.link,
      publisher: n.publisher,
      publishedAt: n.providerPublishTime instanceof Date ? Math.floor(n.providerPublishTime.getTime() / 1000) : n.providerPublishTime,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));
    res.json(articles);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// OHLC candles for a symbol (used by the Auto-Trader candlestick chart)
app.get('/api/trader/candles/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '1d';
    const rangeDays = req.query.range ? +req.query.range : (interval === '1m' ? 2 : interval === '5m' ? 2 : interval === '15m' ? 10 : interval === '1h' ? 5 : interval === '1wk' ? 400 : 60);
    const period1 = new Date(Date.now() - rangeDays * 86400000);
    const chart = await cached(`candles:${symbol}:${interval}:${rangeDays}`, 60000, () => yahooFinance.chart(symbol, { period1, period2: new Date(), interval }));
    let quotes = (chart.quotes || [])
      .filter(q => q.open != null && q.close != null && q.high != null && q.low != null);
    // Filter to market hours only (9:30 AM - 4:00 PM ET)
    if (interval !== '1d' && interval !== '1wk' && interval !== '1mo') {
      quotes = quotes.filter(q => {
        const d = new Date(q.date);
        const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).format(d);
        const [h, m] = etTime.split(':').map(Number);
        const mins = h * 60 + m;
        return mins >= 570 && mins < 960;
      });
    }
    // For short intervals, show only the most recent trading session
    if ((interval === '1m' || interval === '5m') && quotes.length > 0) {
      const lastDate = new Date(quotes[quotes.length - 1].date).toDateString();
      quotes = quotes.filter(q => new Date(q.date).toDateString() === lastDate);
    }
    const candles = quotes.map(q => ({
        date: interval === '1d' || interval === '1wk' || interval === '1mo'
          ? new Date(q.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
          : interval === '1h'
            ? new Date(q.date).toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', timeZone: 'America/New_York' })
            : new Date(q.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
        open: +q.open.toFixed(2),
        high: +q.high.toFixed(2),
        low: +q.low.toFixed(2),
        close: +q.close.toFixed(2),
        volume: q.volume,
      }));
    res.json(candles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live prices for ticker tape (uses chart() instead of quote() to avoid crumb/429 issues)
app.post('/api/trader/prices', async (req, res) => {
  try {
    const symbols = req.body.symbols || [];
    if (!symbols.length) return res.json([]);
    const results = await Promise.all(symbols.map(async (sym) => {
      try {
        const chart = await cached(`pricechart:${sym}`, 30000, () =>
          yahooFinance.chart(sym, { period1: new Date(Date.now() - 5 * 86400000), period2: new Date(), interval: '1d' })
        );
        const meta = chart.meta || {};
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || meta.previousClose;
        if (price != null && prev != null && prev > 0) {
          return { symbol: sym, price, change: ((price - prev) / prev) * 100 };
        }
        const quotes = (chart.quotes || []).filter(q => q.close != null);
        if (!quotes.length) return { symbol: sym, price: null, change: null };
        const last = quotes[quotes.length - 1];
        const prevQ = quotes.length > 1 ? quotes[quotes.length - 2] : null;
        return { symbol: sym, price: last.close, change: prevQ ? ((last.close - prevQ.close) / prevQ.close) * 100 : null };
      } catch { return { symbol: sym, price: null, change: null }; }
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ATR-based auto stop-loss / take-profit for each ticker
app.post('/api/trader/atr-levels', async (req, res) => {
  try {
    const symbols = req.body.symbols || [];
    if (!symbols.length) return res.json({});
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
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin key verification
app.post('/api/auth/verify', (req, res) => {
  const { key } = req.body;
  const valid = key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
  res.json({ admin: !!valid });
});

// --- Alpaca paper trading + auto-trader bot ---------------------------------
app.get('/api/alpaca/account', async (req, res) => {
  try { res.json(await getAccountSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alpaca/positions', async (req, res) => {
  try { res.json(await getPositions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alpaca/orders', async (req, res) => {
  try { res.json(await getRecentOrders(+req.query.limit || 25)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trader', (req, res) => {
  res.json(trader.getState());
});

app.post('/api/trader/config', async (req, res) => {
  try { res.json(await trader.setConfig(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/trader/run', async (req, res) => {
  try { res.json(await trader.runNow()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// In production, serve the built React frontend
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('{*path}', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`API server running on http://localhost:${PORT}`);
  await trader.init();
});
