import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YahooFinanceClass from 'yahoo-finance2';
import Groq from 'groq-sdk';
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { alpaca, getPositions, getAccountSummary } from './alpaca.js';
import { GROWTH_UNIVERSE, computeAtrLevels } from './volatility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'trader-state.json');

// Bot state (watchlist, ATR overrides, on/off, trade log) persists to a free
// Upstash Redis database when configured, so it survives Render's ephemeral
// disk resetting on every instance spin-down/redeploy. Falls back to the
// local JSON file for local dev where these env vars aren't set.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
// Render automatically sets RENDER=true on every deployed service, so this
// reliably tells local dev apart from production even if the same Upstash
// credentials are present in both .env files (as they are here, so Redis
// persistence can be tested locally). Without this, a local server run could
// silently read/overwrite the SAME live production state a real deployment is
// using — which happened once: a local test run's fresh, near-empty state
// got written to the shared key while production was still live, and was
// only caught and fixed by manually forcing production to re-save itself.
const REDIS_KEY = process.env.RENDER ? 'stockp:trader-state' : 'stockp:trader-state:local-dev';

async function redisGetState() {
  const res = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSetState(value) {
  const res = await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstash SET failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

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
    model: 'openai/gpt-oss-20b',
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
  perTradeDollars: 6000,   // dollars per buy order
  maxPositionDollars: 60000, // max total exposure per symbol
  maxTradesPerDay: 10,     // hard cap on orders placed per day
  minConfidence: 0.5,      // symmetric buy/sell threshold for the weighted score (|score| must clear this either direction)
  stopLossPct: -3,         // auto-sell if position drops this % (negative number)
  takeProfitPct: 5,        // auto-sell if position gains this %
  tickerOverrides: {},     // per-ticker overrides, e.g. { TSLA: { stopLossPct: -5, takeProfitPct: 8 } }
  minStockValue: 0,        // floor on total $ held in stock — 0 disables it
};

let state = {
  config: { ...DEFAULT_CONFIG },
  log: [],                 // newest-first decision log (mostly "hold" noise)
  executedTrades: [],       // newest-first, executed trades ONLY — what Trade Journal reads
  trades: { date: today(), count: 0 },
  equityHistory: [],       // [{ time, equity }] for the performance curve
  lastRun: null,
  lastRunNote: null,
  running: false,
  watchlistDate: null,     // last date the watchlist was auto-rotated
  lastBuyTime: {},         // { SYMBOL: ISO timestamp of last executed buy } — enforces BUY_COOLDOWN_MS
  entryExitRules: {},      // { SYMBOL: { entryPrice, lockedAt } } — set when a position opens, cleared when it closes
  watchlistHistory: [],    // [{ date, watchlist }] — one snapshot per day the watchlist actually rotated, newest first
  watchlistPinnedUntil: null, // date string — while set, auto-rotation is skipped entirely (for manual test watchlists)
};

// Minimum time between consecutive buys of the SAME symbol. Without this,
// a stock the AI keeps rating "buy" on back-to-back cycles gets bought again
// every single cycle, letting one position balloon to dominate the portfolio
// (seen in practice: 10 buys of one symbol in ~3.5 hours, ~44% of equity).
const BUY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- Daily watchlist rotation -------------------------------------------------
// Currently held positions always stay on the watchlist (so they keep getting
// fresh data/exit-rule checks no matter how their volatility ranks). On top of
// that, a fixed number of additional "worth watching" slots rotate daily to
// whichever non-held names are currently swinging the most — re-ranked each
// day by actual trailing 20-day realized volatility, same metric the "High
// Growth & Volatile" screener uses. This count is independent of how many
// positions are held, so there's always fresh daily rotation on top of
// whatever you're holding, rather than rotation shrinking to zero once
// holdings fill a fixed total size.
const ROTATING_PICKS = 8;

// Runs the same weighted scoring model used for live buy/sell decisions
// across the whole growth universe, so the daily rotation reflects "which of
// these does the model currently like" rather than just "which is moving the
// most" (volatility is direction-agnostic — a stock crashing hard looks just
// as volatile as one rallying hard). No position is held for any of these
// yet, so decide() can only ever return hold/buy here, never sell, which is
// fine since only the raw score is used for ranking.
async function rankUniverseByScore(symbols) {
  const scored = await Promise.all(symbols.map(async (symbol) => {
    try {
      const snap = await buildSnapshot(symbol);
      const decision = await decide(snap, null);
      return { symbol, score: decision.score };
    } catch {
      return { symbol, score: null };
    }
  }));
  return scored.filter(s => s.score != null).sort((a, b) => b.score - a.score);
}

async function rotateWatchlistIfNeeded() {
  const todayStr = today();
  if (state.watchlistPinnedUntil && todayStr <= state.watchlistPinnedUntil) return;
  if (state.watchlistDate === todayStr) return;
  try {
    const positions = await getPositions();
    const heldSymbols = positions.map(p => p.symbol);
    const ranked = await rankUniverseByScore(GROWTH_UNIVERSE.filter(s => !heldSymbols.includes(s)));
    const newPicks = ranked.slice(0, ROTATING_PICKS).map(r => r.symbol);
    if (heldSymbols.length || newPicks.length) {
      state.config.watchlist = [...heldSymbols, ...newPicks];
    }
    // Auto-refresh ATR-based stop-loss/take-profit for watchlist symbols with
    // no open position, same calculation as the manual "Auto-set from
    // volatility" button. Symbols with an open position (state.entryExitRules
    // has a lock for them) are skipped here so a held position's exit rule
    // doesn't drift day to day — it stays fixed to entry until the position
    // closes. A manual edit through the UI still applies immediately; only
    // this automatic daily recompute is held back.
    const toRefresh = state.config.watchlist.filter(sym => !state.entryExitRules[sym]);
    if (toRefresh.length) {
      const levels = await computeAtrLevels(toRefresh);
      const overrides = { ...state.config.tickerOverrides };
      for (const sym of toRefresh) {
        if (levels[sym]) {
          overrides[sym] = {
            ...(overrides[sym] || {}),
            stopLossPct: levels[sym].stopLossPct,
            takeProfitPct: levels[sym].takeProfitPct,
          };
        }
      }
      state.config.tickerOverrides = overrides;
    }
  } catch (e) {
    console.error('Watchlist volatility rotation failed, keeping previous watchlist:', e.message);
  }
  state.watchlistDate = todayStr;
  // One snapshot per calendar day, even if rotation itself failed above (that
  // still accurately records "watchlist stayed the same today"). Without
  // this, only today's list ever survives — there was no way to answer
  // "what was on the watchlist last Tuesday".
  if (!state.watchlistHistory.some(h => h.date === todayStr)) {
    state.watchlistHistory.unshift({ date: todayStr, watchlist: [...state.config.watchlist] });
    state.watchlistHistory = state.watchlistHistory.slice(0, 60);
  }
  await saveState();
}

async function loadState() {
  try {
    const raw = REDIS_URL && REDIS_TOKEN
      ? await redisGetState()
      : JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw) return;
    state.config = { ...DEFAULT_CONFIG, ...(raw.config || {}) };
    state.log = raw.log || [];
    // Backfill from the old shared log on first load after this change, so
    // trades already executed before the split aren't lost.
    state.executedTrades = raw.executedTrades || (raw.log || []).filter(e => e.executed);
    state.trades = raw.trades && raw.trades.date === today() ? raw.trades : { date: today(), count: 0 };
    state.equityHistory = raw.equityHistory || [];
    state.watchlistDate = raw.watchlistDate || null;
    state.lastBuyTime = raw.lastBuyTime || {};
    state.entryExitRules = raw.entryExitRules || {};
    state.watchlistHistory = raw.watchlistHistory || [];
    state.watchlistPinnedUntil = raw.watchlistPinnedUntil || null;
  } catch (e) {
    console.error('Failed to load trader state (first run is normal):', e.message);
  }
}

async function saveState() {
  const payload = { config: state.config, log: state.log.slice(0, 200), executedTrades: state.executedTrades.slice(0, 200), trades: state.trades, equityHistory: state.equityHistory.slice(-300), watchlistDate: state.watchlistDate, lastBuyTime: state.lastBuyTime, entryExitRules: state.entryExitRules, watchlistHistory: state.watchlistHistory.slice(0, 60), watchlistPinnedUntil: state.watchlistPinnedUntil };
  try {
    if (REDIS_URL && REDIS_TOKEN) {
      await redisSetState(payload);
    } else {
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    }
  } catch (e) {
    console.error('Failed to save trader state:', e.message);
  }
}

async function addLog(entry) {
  const withTime = { time: new Date().toISOString(), ...entry };
  state.log.unshift(withTime);
  state.log = state.log.slice(0, 200);
  // Trade Journal reads from its own list, capped independently of the
  // decision log. Sharing one 200-slot array meant every "hold" decision
  // (the vast majority of entries) could silently push executed trades out
  // of the visible history within hours once the bot ran on a reliable
  // schedule — executed trades now persist on their own regardless of how
  // much hold-decision volume accumulates.
  if (withTime.executed) {
    state.executedTrades.unshift(withTime);
    state.executedTrades = state.executedTrades.slice(0, 200);
  }
  await saveState();
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
  const [chart, newsResult] = await Promise.all([
    yahooFinance.chart(symbol, { period1, period2: new Date(), interval: '1d' }),
    yahooFinance.search(symbol, { newsCount: 3, quotesCount: 0 }).catch(() => ({ news: [] })),
  ]);
  const meta = chart.meta || {};
  const allQuotes = chart.quotes || [];
  const closes = allQuotes.map(q => q.close ?? q.adjclose).filter(v => v != null && v > 0);
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? (closes.length > 1 ? closes[closes.length - 2] : null);
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
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    sma20,
    sma50,
    rsi14: rsi(closes, 14),
    pctFromHigh52: meta.fiftyTwoWeekHigh ? ((price - meta.fiftyTwoWeekHigh) / meta.fiftyTwoWeekHigh) * 100 : null,
    pctFromLow52: meta.fiftyTwoWeekLow ? ((price - meta.fiftyTwoWeekLow) / meta.fiftyTwoWeekLow) * 100 : null,
    momentum5d: fiveDayAgo ? ((price - fiveDayAgo) / fiveDayAgo) * 100 : null,
    news: (newsResult.news || []).map(n => n.title).filter(Boolean).slice(0, 3),
    candles: recentCandles,
  };
}

// --- Weighted signal scoring --------------------------------------------------
// Every signal is scored on the same -1 (bearish) to +1 (bullish) scale, then
// combined via fixed weights into one number in [-1, 1]. Buy/sell requires
// clearing config.minConfidence in either direction — the SAME threshold both
// ways, so bullish and bearish evidence are held to an identical bar. This
// replaces the old setup where a hardcoded pattern rule could unilaterally
// force a sell regardless of what the rest of the evidence said (that's what
// caused a stock to get bought and sold again within ~15 minutes once).
const WEIGHTS = { rsi: 0.25, trend: 0.25, momentum: 0.15, pattern: 0.20, news: 0.15 };

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function scoreRSI(rsi14) {
  if (rsi14 == null) return 0;
  return clip((50 - rsi14) / 20, -1, 1); // RSI 30 -> +1 (oversold/bullish), RSI 70 -> -1 (overbought/bearish)
}

function scoreTrend(price, sma50) {
  if (!sma50 || price == null) return 0;
  return clip(((price - sma50) / sma50) / 0.05, -1, 1); // +-5% off SMA50 maxes out the score
}

function scoreMomentum(momentum5d) {
  if (momentum5d == null) return 0;
  return clip(momentum5d / 10, -1, 1); // +-10% 5-day move maxes out the score
}

// Pure shape-based candlestick scoring — deliberately mirrored (a bullish shape
// and its bearish mirror both count) and decoupled from RSI/trend, which are
// already scored separately above and would otherwise be double-counted.
function scorePattern(snap) {
  const candles = snap.candles;
  if (!candles || candles.length < 3) return 0;
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  let bullish = 0, bearish = 0;

  const bullEngulf = prev.c < prev.o && latest.c > latest.o && latest.o <= prev.c && latest.c >= prev.o;
  const bearEngulf = prev.c > prev.o && latest.c < latest.o && latest.o >= prev.c && latest.c <= prev.o;
  if (bullEngulf) bullish++;
  if (bearEngulf) bearish++;

  const body = Math.abs(latest.c - latest.o);
  const lowerWick = Math.min(latest.o, latest.c) - latest.l;
  const upperWick = latest.h - Math.max(latest.o, latest.c);
  if (body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5) bullish++; // Hammer
  if (body > 0 && upperWick >= body * 2 && lowerWick <= body * 0.5) bearish++; // Shooting Star

  const last3 = candles.slice(-3);
  if (last3.length === 3) {
    if (last3.every(c => c.c > c.o) && last3[0].c < last3[1].c && last3[1].c < last3[2].c) bullish++; // 3 rising green
    if (last3.every(c => c.c < c.o) && last3[0].c > last3[1].c && last3[1].c > last3[2].c) bearish++; // 3 declining red
  }

  return clip(bullish - bearish, -1, 1);
}

// The only remaining AI call: score headline sentiment from -1 to +1. Kept
// deliberately small/cheap, and fails soft (0 = neutral) instead of throwing,
// so an AI outage no longer blocks the bot from deciding at all — it just
// proceeds on technicals alone.
async function scoreNews(snap) {
  if (!snap.news || !snap.news.length) return 0;
  const prompt = `Rate the sentiment of these headlines about ${snap.symbol} for a trader, from -1 (very negative) to +1 (very positive), 0 if neutral/mixed/no clear signal:\n${snap.news.map(t => `- ${t}`).join('\n')}\n\nRespond as JSON: {"sentiment": <number from -1.0 to 1.0>}`;
  for (const eng of ENGINES) {
    if (!eng.available()) continue;
    try {
      const raw = await eng.fn(prompt);
      const out = JSON.parse(raw);
      if (typeof out.sentiment === 'number') return clip(out.sentiment, -1, 1);
    } catch {
      // try the next engine
    }
  }
  return 0;
}

async function decide(snap, position) {
  const rsiScore = scoreRSI(snap.rsi14);
  const trendScore = scoreTrend(snap.price, snap.sma50);
  const momentumScore = scoreMomentum(snap.momentum5d);
  const patternScore = scorePattern(snap);
  const newsScore = await scoreNews(snap).catch(() => 0);

  const score = rsiScore * WEIGHTS.rsi
    + trendScore * WEIGHTS.trend
    + momentumScore * WEIGHTS.momentum
    + patternScore * WEIGHTS.pattern
    + newsScore * WEIGHTS.news;

  const threshold = state.config.minConfidence;
  let action = 'hold';
  if (score >= threshold) action = 'buy';
  else if (score <= -threshold && position) action = 'sell'; // no shorting — sell only if holding

  const reason = `score ${score.toFixed(2)} (RSI ${rsiScore.toFixed(2)}, trend ${trendScore.toFixed(2)}, momentum ${momentumScore.toFixed(2)}, pattern ${patternScore.toFixed(2)}, news ${newsScore.toFixed(2)})`;

  return { action, confidence: Math.abs(score), reason, engine: 'Scoring', score };
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
    const lastBuy = state.lastBuyTime[snap.symbol];
    if (lastBuy && Date.now() - new Date(lastBuy).getTime() < BUY_COOLDOWN_MS) {
      const mins = Math.ceil((BUY_COOLDOWN_MS - (Date.now() - new Date(lastBuy).getTime())) / 60000);
      return { executed: false, note: `buy cooldown active (~${mins}m left)` };
    }
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
    state.lastBuyTime[snap.symbol] = new Date().toISOString();
    // Lock the entry price on the buy that OPENS a position, not on buys
    // that add to one already held — later averaging-in shouldn't move the
    // reference point the exit rule is measured against.
    if (!position || position.qty <= 0) {
      state.entryExitRules[snap.symbol] = { entryPrice: snap.price, lockedAt: new Date().toISOString() };
    }
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
    delete state.entryExitRules[snap.symbol]; // position fully closes — every sell here is the whole position
    return { executed: true, note: `sold ${position.qty} shares`, pl: position.unrealizedPL, plPct: position.unrealizedPLPct };
  }

  return { executed: false, note: 'hold' };
}

// If total stock value has fallen below config.minStockValue (e.g. after a
// wave of profit-taking sells), deploy cash into whichever watchlist symbols
// still score positively this cycle, strongest first, until back at the
// floor. Deliberately does NOT buy a symbol the model currently reads as
// bearish just to hit the number — if nothing scores above 0, the floor can
// go unmet rather than fight the model's own signal.
async function topUpToFloor(positions, positionsBySymbol, account, scores) {
  const floor = state.config.minStockValue;
  if (!floor) return;
  const totalStockValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
  let deficit = floor - totalStockValue;
  if (deficit <= 0) return;

  const candidates = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  let cashRemaining = account.cash * 0.95;
  for (const [symbol, score] of candidates) {
    if (deficit <= 0 || cashRemaining < 1) break;
    if (state.trades.count >= state.config.maxTradesPerDay) break;
    const position = positionsBySymbol[symbol];
    const currentExposure = position ? position.marketValue : 0;
    const room = state.config.maxPositionDollars - currentExposure;
    if (room <= 1) continue;
    const size = Math.min(state.config.perTradeDollars, room, deficit, cashRemaining);
    if (size < 1) continue;
    try {
      await alpaca.createOrder({ symbol, notional: +size.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' });
      state.trades.count++;
      state.lastBuyTime[symbol] = new Date().toISOString();
      // Entry-price lock for a brand-new position gets picked up by the
      // regular per-cycle backfill pass (using avgEntry once the order has
      // actually filled) — same path pre-existing/manual positions use.
      deficit -= size;
      cashRemaining -= size;
      await addLog({ symbol, action: 'buy', confidence: score, reason: `Floor rule: total stock value below $${floor.toLocaleString()} target`, engine: 'Floor Rule', executed: true, note: `bought ~$${size.toFixed(0)}` });
    } catch (e) {
      await addLog({ symbol, action: 'error', confidence: 0, reason: `floor rule buy failed: ${e.message}`, engine: 'Floor Rule', executed: false, note: 'error' });
    }
  }
}

// --- Main loop ---------------------------------------------------------------
let timer = null;

async function runOnce(manual = false) {
  if (state.running) return;
  state.running = true;
  try {
    await rotateWatchlistIfNeeded();
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
    try {
      const spyChart = await yahooFinance.chart('^GSPC', { period1: new Date(Date.now() - 5 * 86400000), period2: new Date(), interval: '1d' });
      const spyQuotes = (spyChart.quotes || []).filter(q => q.close != null);
      spyPrice = spyChart.meta?.regularMarketPrice ?? (spyQuotes.length ? spyQuotes[spyQuotes.length - 1].close : null);
    } catch { /* benchmark just gaps */ }
    state.equityHistory.push({ time: new Date().toISOString(), equity: account.equity, spy: spyPrice });
    if (state.equityHistory.length > 300) state.equityHistory = state.equityHistory.slice(-300);

    // Backfill a lock for any held position that doesn't have one yet — either
    // it was opened before this tracking existed, or bought outside the bot.
    // avgEntry is the best available stand-in for "price when bought" there.
    for (const pos of positions) {
      if (!state.entryExitRules[pos.symbol]) {
        state.entryExitRules[pos.symbol] = { entryPrice: pos.avgEntry, lockedAt: new Date().toISOString(), backfilled: true };
      }
    }
    for (const sym of Object.keys(state.entryExitRules)) {
      if (!positionsBySymbol[sym]) delete state.entryExitRules[sym]; // no longer held (e.g. closed manually via Alpaca)
    }

    // --- Exit strategy: check all positions for stop loss / take profit --------
    if (clock.is_open) {
      for (const pos of positions) {
        if (state.trades.count >= state.config.maxTradesPerDay) break;
        const ovr = state.config.tickerOverrides?.[pos.symbol] || {};
        const sl = ovr.stopLossPct ?? state.config.stopLossPct;
        const tp = ovr.takeProfitPct ?? state.config.takeProfitPct;
        // Measure against the price the position was actually opened at, not
        // Alpaca's average cost basis (which shifts every time shares are
        // added), so exit thresholds mean the same thing they did on day one.
        // Falls back to Alpaca's own figure for positions opened before this
        // tracking existed or opened manually outside the bot.
        const lock = state.entryExitRules[pos.symbol];
        const plPct = lock ? ((pos.current - lock.entryPrice) / lock.entryPrice) * 100 : pos.unrealizedPLPct;
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
            delete state.entryExitRules[pos.symbol];
            await addLog({ symbol: pos.symbol, action: 'sell', confidence: 1, reason: exitReason, engine: 'Exit', price: pos.current, rsi14: null, executed: true, note: `sold ${pos.qty} shares`, pl: pos.unrealizedPL, plPct: pos.unrealizedPLPct });
          } catch (e) {
            await addLog({ symbol: pos.symbol, action: 'error', confidence: 0, reason: `exit failed: ${e.message}`, engine: 'Exit', executed: false, note: 'error' });
          }
        }
      }
    }

    const scores = {};
    for (const symbol of state.config.watchlist) {
      try {
        const snap = await buildSnapshot(symbol);
        const decision = await decide(snap, positionsBySymbol[symbol]);
        if (typeof decision.score === 'number') scores[symbol] = decision.score;
        let result = { executed: false, note: 'analysis only' };
        if (clock.is_open) {
          result = await maybeTrade(snap, decision, positionsBySymbol, account);
        } else {
          result = { executed: false, note: 'market closed — not trading' };
        }
        await addLog({
          symbol,
          action: decision.action,
          confidence: decision.confidence,
          reason: decision.reason,
          engine: decision.engine,
          price: snap.price,
          rsi14: snap.rsi14,
          executed: result.executed,
          note: result.note,
          pl: result.pl,
          plPct: result.plPct,
        });
      } catch (e) {
        await addLog({ symbol, action: 'error', confidence: 0, reason: e.message, executed: false, note: 'error' });
      }
    }

    if (clock.is_open) {
      await topUpToFloor(positions, positionsBySymbol, account, scores);
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
  async init() {
    if (REDIS_URL && REDIS_TOKEN) {
      console.log('Trader state persistence: Upstash Redis (survives restarts)');
    } else {
      console.log('Trader state persistence: LOCAL FILE ONLY — UPSTASH_REDIS_REST_URL/TOKEN not set, state will reset on every restart/redeploy');
    }
    await loadState();
    await rotateWatchlistIfNeeded();
    scheduleLoop();
  },
  // Manual test override: replaces the watchlist and freezes daily
  // auto-rotation through the given date (inclusive), so the override
  // actually survives the next day-rollover instead of being silently
  // overwritten by the normal held+rotating-picks logic. Rotation resumes
  // automatically the day after pinnedUntil.
  async pinWatchlist(watchlist, pinnedUntil) {
    state.config.watchlist = watchlist;
    state.watchlistPinnedUntil = pinnedUntil;
    const todayStr = today();
    if (!state.watchlistHistory.some(h => h.date === todayStr)) {
      state.watchlistHistory.unshift({ date: todayStr, watchlist: [...watchlist] });
      state.watchlistHistory = state.watchlistHistory.slice(0, 60);
    } else {
      state.watchlistHistory[0] = { date: todayStr, watchlist: [...watchlist] };
    }
    await saveState();
    return this.getState();
  },
  getState() {
    return {
      config: state.config,
      log: state.log,
      executedTrades: state.executedTrades,
      trades: state.trades,
      lastRun: state.lastRun,
      lastRunNote: state.lastRunNote,
      engines: ENGINES.map(e => ({ name: e.name, available: e.available() })),
      equityHistory: state.equityHistory,
      watchlistHistory: state.watchlistHistory,
    };
  },
  async setConfig(patch) {
    state.config = { ...state.config, ...patch };
    // sanitize
    state.config.watchlist = (state.config.watchlist || [])
      .map(s => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 20);
    state.config.intervalMinutes = Math.max(1, Math.min(240, +state.config.intervalMinutes || 15));
    await saveState();
    scheduleLoop();
    return this.getState();
  },
  async runNow() {
    await runOnce(true);
    return this.getState();
  },
  // Deliberate, user-initiated buy that skips the confidence gate — for
  // putting idle cash to work on a symbol you've decided on yourself,
  // separate from the bot's own signal-driven buys. Still respects the
  // max-position cap and cash-on-hand limit, still gets the same
  // stop-loss/take-profit entry-price lock as any other position, and is
  // logged distinctly (engine "Manual") so it's never confused for a
  // scoring-engine decision in the Trade Journal.
  async manualBuy(symbolRaw, dollars) {
    const symbol = String(symbolRaw || '').trim().toUpperCase();
    if (!symbol) throw new Error('symbol required');
    const [positions, account] = await Promise.all([getPositions(), getAccountSummary()]);
    const position = positions.find(p => p.symbol === symbol);
    const currentExposure = position ? position.marketValue : 0;
    const room = state.config.maxPositionDollars - currentExposure;
    if (room <= 1) throw new Error('at max position size for symbol');
    const size = Math.min(+dollars || state.config.perTradeDollars, room, account.cash * 0.95);
    if (size < 1) throw new Error('insufficient cash');
    await alpaca.createOrder({ symbol, notional: +size.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' });
    state.trades.count++;
    state.lastBuyTime[symbol] = new Date().toISOString();
    const wasNewPosition = !position || position.qty <= 0;
    // Paper-order fills sometimes take a moment to show up in the position
    // list, so retry briefly rather than logging a blank price.
    let fillPrice = null;
    for (let attempt = 0; attempt < 4 && fillPrice == null; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      const updated = (await getPositions()).find(p => p.symbol === symbol);
      fillPrice = updated ? updated.avgEntry : null;
    }
    if (wasNewPosition && fillPrice != null) {
      state.entryExitRules[symbol] = { entryPrice: fillPrice, lockedAt: new Date().toISOString() };
    }
    await addLog({ symbol, action: 'buy', confidence: 1, reason: 'Manual buy', engine: 'Manual', price: fillPrice, executed: true, note: `bought ~$${size.toFixed(0)}` });
    return this.getState();
  },
};
