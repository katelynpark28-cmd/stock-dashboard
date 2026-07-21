import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinanceClass from 'yahoo-finance2';
import Groq from 'groq-sdk';
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { alpaca } from './alpaca.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'trader-state.json');

const yahooFinance = new YahooFinanceClass({ suppressNotices: ['yahooSurvey'] });

// --- AI engines: Groq is primary; Cerebras then Gemini are failovers --------
// Each has its own separate rate-limit pool, so when one is on cooldown the
// next one in the chain picks up the analysis. Engines without a key are
// skipped automatically, so the bot still works with whatever keys exist.
// maxRetries: 1 so a rate-limited engine fails over to the next one quickly
// instead of burning seconds on internal backoff retries.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 1 });
const cerebras = process.env.CEREBRAS_API_KEY ? new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY, maxRetries: 1 }) : null;
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

async function askGroq(prompt) {
  const c = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });
  return c.choices[0].message.content;
}

async function askCerebras(prompt) {
  if (!cerebras) throw new Error('no Cerebras key');
  const c = await cerebras.chat.completions.create({
    model: 'zai-glm-4.7',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });
  return c.choices[0].message.content;
}

async function askGemini(prompt) {
  if (!gemini) throw new Error('no Gemini key');
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
  });
  const r = await model.generateContent(prompt);
  return r.response.text();
}

// Failover chain, tried in order.
const ENGINES = [
  { name: 'Groq', fn: askGroq, available: () => true },
  { name: 'Cerebras', fn: askCerebras, available: () => !!cerebras },
  { name: 'Gemini', fn: askGemini, available: () => !!gemini },
];

// --- Persistent state --------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: false,
  watchlist: ['AAPL', 'NVDA', 'TSLA'],
  intervalMinutes: 15,
  perTradeDollars: 2000,   // dollars per buy order
  maxPositionDollars: 60000, // max total exposure per symbol
  maxTradesPerDay: 10,     // hard cap on orders placed per day
  minConfidence: 0.6,      // ignore AI calls below this confidence
  stopLossPct: -3,         // auto-sell if position drops this % (negative number)
  takeProfitPct: 5,        // auto-sell if position gains this %
  tickerOverrides: {},     // per-ticker overrides, e.g. { TSLA: { stopLossPct: -5, takeProfitPct: 8 } }
};

let state = {
  config: { ...DEFAULT_CONFIG },
  log: [],                 // newest-first decision log
  trades: { date: today(), count: 0 },
  equityHistory: [],       // [{ time, equity }] for the performance curve
  lastRun: null,
  lastRunNote: null,
  running: false,
  watchlistDate: null,     // last date the watchlist was auto-rotated
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- Daily watchlist rotation -------------------------------------------------
// Pool of liquid, well-known tickers to rotate through so the same handful of
// symbols isn't shown/traded every single day.
const WATCHLIST_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'AVGO',
  'JPM', 'V', 'MA', 'HD', 'COST', 'PEP', 'KO', 'PG', 'JNJ', 'UNH',
  'CRM', 'ORCL', 'ADBE', 'QCOM', 'TXN', 'INTC', 'CSCO', 'PYPL', 'SHOP', 'UBER',
  'DIS', 'NKE', 'SBUX', 'PANW', 'SNOW', 'PLTR', 'COIN', 'SOFI', 'DRAM',
];
const WATCHLIST_SIZE = 8;

// Deterministic shuffle seeded by a string (the date), so the pick is stable
// for a given day but different across days.
function seededShuffle(arr, seedStr) {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rotateWatchlistIfNeeded() {
  const todayStr = today();
  if (state.watchlistDate === todayStr) return;
  state.config.watchlist = seededShuffle(WATCHLIST_UNIVERSE, todayStr).slice(0, WATCHLIST_SIZE);
  state.watchlistDate = todayStr;
  saveState();
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.config = { ...DEFAULT_CONFIG, ...(raw.config || {}) };
    state.log = raw.log || [];
    state.trades = raw.trades && raw.trades.date === today() ? raw.trades : { date: today(), count: 0 };
    state.equityHistory = raw.equityHistory || [];
    state.watchlistDate = raw.watchlistDate || null;
  } catch {
    // first run — no state file yet
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ config: state.config, log: state.log.slice(0, 200), trades: state.trades, equityHistory: state.equityHistory.slice(-300), watchlistDate: state.watchlistDate }, null, 2));
  } catch (e) {
    console.error('Failed to save trader state:', e.message);
  }
}

function addLog(entry) {
  state.log.unshift({ time: new Date().toISOString(), ...entry });
  state.log = state.log.slice(0, 200);
  saveState();
}

// --- Technical indicators ----------------------------------------------------
function sma(closes, n) {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function buildSnapshot(symbol) {
  const period1 = new Date(Date.now() - 200 * 86400000); // ~200 days of daily bars
  const [quote, chart, newsResult] = await Promise.all([
    yahooFinance.quote(symbol),
    yahooFinance.chart(symbol, { period1, period2: new Date(), interval: '1d' }),
    yahooFinance.search(symbol, { newsCount: 3, quotesCount: 0 }).catch(() => ({ news: [] })),
  ]);
  const allQuotes = chart.quotes || [];
  const closes = allQuotes.map(q => q.close ?? q.adjclose).filter(v => v != null && v > 0);
  const price = quote.regularMarketPrice;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const fiveDayAgo = closes.length >= 6 ? closes[closes.length - 6] : null;
  const recentCandles = allQuotes.slice(-5)
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
    .map(q => ({
      date: new Date(q.date).toISOString().slice(5, 10),
      o: +q.open.toFixed(2),
      h: +q.high.toFixed(2),
      l: +q.low.toFixed(2),
      c: +q.close.toFixed(2),
    }));
  return {
    symbol,
    price,
    changePct: quote.regularMarketChangePercent,
    sma20,
    sma50,
    rsi14: rsi(closes, 14),
    pctFromHigh52: quote.fiftyTwoWeekHigh ? ((price - quote.fiftyTwoWeekHigh) / quote.fiftyTwoWeekHigh) * 100 : null,
    pctFromLow52: quote.fiftyTwoWeekLow ? ((price - quote.fiftyTwoWeekLow) / quote.fiftyTwoWeekLow) * 100 : null,
    momentum5d: fiveDayAgo ? ((price - fiveDayAgo) / fiveDayAgo) * 100 : null,
    news: (newsResult.news || []).map(n => n.title).filter(Boolean).slice(0, 3),
    candles: recentCandles,
  };
}

// --- Candlestick pattern rules (run before AI) ------------------------------
function detectPatterns(snap, position) {
  const candles = snap.candles;
  if (!candles || candles.length < 3) return null;
  if (snap.sma50 == null || snap.rsi14 == null) return null;

  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = snap.price;
  const rsi = snap.rsi14;

  // 1. Bullish engulfing + price near/above SMA50 + RSI < 40 → Buy
  const bullEngulf = prev.c < prev.o
    && latest.c > latest.o
    && latest.o <= prev.c
    && latest.c >= prev.o;
  if (bullEngulf && price >= snap.sma50 * 0.98 && rsi < 40) {
    return { action: 'buy', confidence: 0.8, reason: `Bullish engulfing near SMA50, RSI ${rsi.toFixed(0)} oversold`, engine: 'Pattern' };
  }

  // 2. Hammer + price above SMA50 + RSI < 35 → Buy
  const body = Math.abs(latest.c - latest.o);
  const lowerWick = Math.min(latest.o, latest.c) - latest.l;
  const upperWick = latest.h - Math.max(latest.o, latest.c);
  const hammer = body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5;
  if (hammer && price >= snap.sma50 && rsi < 35) {
    return { action: 'buy', confidence: 0.75, reason: `Hammer candle above SMA50, RSI ${rsi.toFixed(0)} oversold`, engine: 'Pattern' };
  }

  // 3. Bearish engulfing + price below SMA50 + RSI > 60 → Sell (only if holding)
  const bearEngulf = prev.c > prev.o
    && latest.c < latest.o
    && latest.o >= prev.c
    && latest.c <= prev.o;
  if (bearEngulf && price < snap.sma50 && rsi > 60 && position) {
    return { action: 'sell', confidence: 0.8, reason: `Bearish engulfing below SMA50, RSI ${rsi.toFixed(0)}`, engine: 'Pattern' };
  }

  // 4. Three red candles with declining closes + price below SMA50 → Sell (only if holding)
  const last3 = candles.slice(-3);
  const threeRed = last3.every(c => c.c < c.o);
  const declining = last3[0].c > last3[1].c && last3[1].c > last3[2].c;
  if (threeRed && declining && price < snap.sma50 && position) {
    return { action: 'sell', confidence: 0.75, reason: `3 red candles declining below SMA50`, engine: 'Pattern' };
  }

  return null;
}

// --- AI decision -------------------------------------------------------------
const f = (n, d = 2) => (n == null ? 'N/A' : n.toFixed(d));

async function decide(snap, position) {
  const posLine = position
    ? `HOLDING ${position.qty} shares @ avg $${f(position.avgEntry)}, unrealized P&L ${f(position.unrealizedPLPct)}%`
    : 'No current position';
  const newsLine = (snap.news && snap.news.length)
    ? snap.news.map(t => `- ${t}`).join('\n')
    : '(no recent headlines)';
  const candleLine = (snap.candles && snap.candles.length)
    ? snap.candles.map(c => `${c.date}: O=${c.o} H=${c.h} L=${c.l} C=${c.c}`).join('\n')
    : '(no candle data)';

  const prompt = `You are a disciplined systematic trading assistant running a PAPER account (fake money).
Decide an action for ${snap.symbol} based ONLY on this technical snapshot. Do not invent data.

Price: $${f(snap.price)} | Today: ${f(snap.changePct)}%
SMA20: $${f(snap.sma20)} | SMA50: $${f(snap.sma50)}
RSI(14): ${f(snap.rsi14, 1)}
From 52w high: ${f(snap.pctFromHigh52, 1)}% | From 52w low: ${f(snap.pctFromLow52, 1)}%
5-day momentum: ${f(snap.momentum5d, 1)}%
Position: ${posLine}

Last 5 daily candles (OHLC):
${candleLine}

Recent headlines:
${newsLine}

Guidelines (heuristics, not guarantees): oversold RSI<30 while price holds above SMA50 can be a buy;
overbought RSI>70 or a break below SMA50 can be a sell; respect the prevailing trend; prefer "hold" when mixed.
Also weigh the headlines: clearly negative news is a reason for caution even on good technicals; a positive catalyst can support a buy.
Check the candle shapes for reversal or continuation patterns (e.g. hammer, doji, engulfing, shooting star). These can confirm or contradict the other signals.
Only suggest "sell" if there is a position to sell.

Respond as JSON: {"action":"buy|sell|hold","confidence":0.0-1.0,"reason":"<=20 words, specific to these numbers"}`;

  // Try each engine in order; on rate-limit/cooldown/error, fall through to the next.
  let lastErr;
  for (const eng of ENGINES) {
    if (!eng.available()) continue;
    try {
      const raw = await eng.fn(prompt);
      const out = JSON.parse(raw);
      return {
        action: ['buy', 'sell', 'hold'].includes(out.action) ? out.action : 'hold',
        confidence: typeof out.confidence === 'number' ? Math.max(0, Math.min(1, out.confidence)) : 0,
        reason: String(out.reason || '').slice(0, 160),
        engine: eng.name,
      };
    } catch (e) {
      lastErr = e;
      // move to the next engine in the chain
    }
  }
  throw new Error(`all engines failed (last: ${lastErr?.message || 'unknown'})`);
}

// --- Guardrails + order placement -------------------------------------------
async function maybeTrade(snap, decision, positionsBySymbol, account) {
  const { config } = state;
  const position = positionsBySymbol[snap.symbol];

  // Confidence gate
  if (decision.confidence < config.minConfidence) {
    return { executed: false, note: `below confidence gate (${config.minConfidence})` };
  }

  // Daily trade cap
  if (state.trades.count >= config.maxTradesPerDay) {
    return { executed: false, note: 'daily trade cap reached' };
  }

  if (decision.action === 'buy') {
    const currentExposure = position ? position.marketValue : 0;
    const room = config.maxPositionDollars - currentExposure;
    if (room <= 1) return { executed: false, note: 'at max position size for symbol' };
    // Cap by cash on hand (not buying power, which includes margin) so the
    // account never goes into a negative cash balance.
    const size = Math.min(config.perTradeDollars, room, account.cash * 0.95);
    if (size < 1) return { executed: false, note: 'insufficient cash' };
    await alpaca.createOrder({
      symbol: snap.symbol,
      notional: +size.toFixed(2),
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    });
    state.trades.count++;
    return { executed: true, note: `bought ~$${size.toFixed(0)}` };
  }

  if (decision.action === 'sell') {
    if (!position || position.qty <= 0) {
      return { executed: false, note: 'no position to sell (no shorting)' };
    }
    await alpaca.createOrder({
      symbol: snap.symbol,
      qty: position.qty,
      side: 'sell',
      type: 'market',
      time_in_force: 'day',
    });
    state.trades.count++;
    return { executed: true, note: `sold ${position.qty} shares` };
  }

  return { executed: false, note: 'hold' };
}

// --- Main loop ---------------------------------------------------------------
let timer = null;

async function runOnce(manual = false) {
  if (state.running) return;
  state.running = true;
  try {
    rotateWatchlistIfNeeded();
    // Reset daily counter on date rollover
    if (state.trades.date !== today()) state.trades = { date: today(), count: 0 };

    const clock = await alpaca.getClock();
    if (!clock.is_open && !manual) {
      state.lastRun = new Date().toISOString();
      state.lastRunNote = 'market closed — skipped';
      return;
    }

    const [account, positions] = await Promise.all([
      import('./alpaca.js').then(m => m.getAccountSummary()),
      import('./alpaca.js').then(m => m.getPositions()),
    ]);
    const positionsBySymbol = Object.fromEntries(positions.map(p => [p.symbol, p]));

    // Record one equity point per cycle, plus S&P 500 price for the buy-and-hold benchmark
    let spyPrice = null;
    try { spyPrice = (await yahooFinance.quote('^GSPC')).regularMarketPrice ?? null; } catch { /* benchmark just gaps */ }
    state.equityHistory.push({ time: new Date().toISOString(), equity: account.equity, spy: spyPrice });
    if (state.equityHistory.length > 300) state.equityHistory = state.equityHistory.slice(-300);

    // --- Exit strategy: check all positions for stop loss / take profit --------
    if (clock.is_open) {
      for (const pos of positions) {
        if (state.trades.count >= state.config.maxTradesPerDay) break;
        const ovr = state.config.tickerOverrides?.[pos.symbol] || {};
        const sl = ovr.stopLossPct ?? state.config.stopLossPct;
        const tp = ovr.takeProfitPct ?? state.config.takeProfitPct;
        const plPct = pos.unrealizedPLPct;
        let exitReason = null;
        if (sl != null && plPct <= sl) {
          exitReason = `Stop loss triggered at ${plPct.toFixed(1)}% (limit ${sl}%)`;
        } else if (tp != null && plPct >= tp) {
          exitReason = `Take profit triggered at ${plPct.toFixed(1)}% (target ${tp}%)`;
        }
        if (exitReason) {
          try {
            await alpaca.createOrder({ symbol: pos.symbol, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day' });
            state.trades.count++;
            addLog({ symbol: pos.symbol, action: 'sell', confidence: 1, reason: exitReason, engine: 'Exit', price: pos.current, rsi14: null, executed: true, note: `sold ${pos.qty} shares` });
          } catch (e) {
            addLog({ symbol: pos.symbol, action: 'error', confidence: 0, reason: `exit failed: ${e.message}`, engine: 'Exit', executed: false, note: 'error' });
          }
        }
      }
    }

    for (const symbol of state.config.watchlist) {
      try {
        const snap = await buildSnapshot(symbol);
        const patternHit = detectPatterns(snap, positionsBySymbol[symbol]);
        const decision = patternHit || await decide(snap, positionsBySymbol[symbol]);
        let result = { executed: false, note: 'analysis only' };
        if (clock.is_open) {
          result = await maybeTrade(snap, decision, positionsBySymbol, account);
        } else {
          result = { executed: false, note: 'market closed — not trading' };
        }
        addLog({
          symbol,
          action: decision.action,
          confidence: decision.confidence,
          reason: decision.reason,
          engine: decision.engine,
          price: snap.price,
          rsi14: snap.rsi14,
          executed: result.executed,
          note: result.note,
        });
      } catch (e) {
        addLog({ symbol, action: 'error', confidence: 0, reason: e.message, executed: false, note: 'error' });
      }
    }
    state.lastRun = new Date().toISOString();
    state.lastRunNote = clock.is_open ? 'ran' : 'analysis only (market closed)';
  } catch (e) {
    // A whole-cycle failure (e.g. Alpaca clock/account fetch errored) must never
    // crash the server — log it and let the next cycle try again.
    console.error('trader cycle error:', e.message);
    state.lastRun = new Date().toISOString();
    state.lastRunNote = `cycle error: ${e.message}`.slice(0, 120);
  } finally {
    state.running = false;
  }
}

const safeRun = () => runOnce(false).catch(e => console.error('runOnce rejected:', e.message));

function scheduleLoop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (state.config.enabled) {
    timer = setInterval(safeRun, state.config.intervalMinutes * 60000);
    safeRun(); // kick off immediately
  }
}

// --- Public API --------------------------------------------------------------
export const trader = {
  init() {
    loadState();
    rotateWatchlistIfNeeded();
    scheduleLoop();
  },
  getState() {
    return {
      config: state.config,
      log: state.log,
      trades: state.trades,
      lastRun: state.lastRun,
      lastRunNote: state.lastRunNote,
      engines: ENGINES.map(e => ({ name: e.name, available: e.available() })),
      equityHistory: state.equityHistory,
    };
  },
  setConfig(patch) {
    state.config = { ...state.config, ...patch };
    // sanitize
    state.config.watchlist = (state.config.watchlist || [])
      .map(s => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 20);
    state.config.intervalMinutes = Math.max(1, Math.min(240, +state.config.intervalMinutes || 15));
    saveState();
    scheduleLoop();
    return this.getState();
  },
  async runNow() {
    await runOnce(true);
    return this.getState();
  },
};
