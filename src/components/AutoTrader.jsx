import { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import CandlestickChart from './CandlestickChart';
import RollingNumber from './RollingNumber';
import {
  fetchAccount, fetchPositions, fetchTrader,
  saveTraderConfig, runTraderNow, fetchAtrLevels, fetchCandles, fetchPrices,
} from '../tradingApi';
import { fetchPriceHistory } from '../api';

const money = (n) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const timeAgo = (iso) => {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// Every ticker mention across the page uses this: opens that ticker's
// research page in a new tab, and shows the full company name on hover.
function TickerLink({ symbol, name, className = '' }) {
  return (
    <a
      href={`?ticker=${symbol}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`at-ticker-link ${className}`}
      onClick={e => e.stopPropagation()}
    >
      {symbol}
      {name && <span className="at-ticker-tooltip">{name}</span>}
    </a>
  );
}

export default function AutoTrader() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginKey, setLoginKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [trader, setTrader] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [candleSymbol, setCandleSymbol] = useState('');
  const [newTicker, setNewTicker] = useState('');
  const [candlePeriod, setCandlePeriod] = useState('1D');
  const [linePeriod, setLinePeriod] = useState('1M');
  const [showPatterns, setShowPatterns] = useState(false);

  // Auto-scroll state
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollIndexRef = useRef(0);

  // Ticker tape prices
  const [tickerPrices, setTickerPrices] = useState([]);
  // Full company names for every ticker ever shown on this page (watchlist,
  // positions, journal) — keyed by symbol, never pruned so historical
  // symbols keep their name after rotating out of the watchlist.
  const [tickerNames, setTickerNames] = useState({});
  const prevAccountRef = useRef({});
  const [cardFlash, setCardFlash] = useState({});

  // Line chart data for side-by-side view
  const [lineData, setLineData] = useState([]);

  const [form, setForm] = useState(null);
  const loadedForm = useRef(false);
  const overrideSaveTimers = useRef({});

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginKey.trim()) return;
    setLoginLoading(true);
    setLoginError('');
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: loginKey.trim() }),
      });
      const d = await r.json();
      if (d.admin) {
        setIsAdmin(true);
        setShowLogin(false);
        setLoginKey('');
      } else {
        setLoginError('Invalid key');
      }
    } catch {
      setLoginError('Connection error');
    }
    setLoginLoading(false);
  };

  const refresh = useCallback(async () => {
    try {
      const [a, p, t] = await Promise.all([
        fetchAccount(), fetchPositions(), fetchTrader(),
      ]);
      setAccount(a); setPositions(p); setTrader(t);
      if (!loadedForm.current) {
        setForm({ ...t.config, watchlistText: t.config.watchlist.join(', ') });
        setCandleSymbol(s => s || t.config.watchlist[0] || 'AAPL');
        loadedForm.current = true;
      }
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  // Fetch ticker tape prices (watchlist + ^GSPC)
  useEffect(() => {
    if (!trader) return;
    const symbols = [...trader.config.watchlist, '^GSPC', '^DJI', '^IXIC'];
    fetchPrices(symbols).then(setTickerPrices).catch(() => {});
    const id = setInterval(() => {
      fetchPrices(symbols).then(setTickerPrices).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [trader?.config.watchlist.join(',')]);

  // Look up full company names for every ticker shown anywhere on this page
  // (watchlist, open positions, trade journal) so hover tooltips work even
  // for symbols that have since rotated out of the watchlist.
  useEffect(() => {
    if (!trader) return;
    const symbols = [...new Set([
      ...trader.config.watchlist,
      ...positions.map(p => p.symbol),
      ...trader.log.map(d => d.symbol),
    ])].filter(Boolean);
    if (!symbols.length) return;
    fetchPrices(symbols).then(data => {
      setTickerNames(prev => {
        const next = { ...prev };
        data.forEach(d => { if (d.name) next[d.symbol] = d.name; });
        return next;
      });
    }).catch(() => {});
  }, [trader?.config.watchlist.join(','), positions.map(p => p.symbol).join(','), trader?.log.length]);

  // Flash account cards when values change
  useEffect(() => {
    if (!account) return;
    const prev = prevAccountRef.current;
    const flashes = {};
    const fields = [
      ['equity', account.equity],
      ['dayPL', account.dayPL],
      ['cash', account.cash],
      ['totalPL', account.totalPL],
    ];
    for (const [key, val] of fields) {
      if (prev[key] != null && val != null && val !== prev[key]) {
        flashes[key] = val > prev[key] ? 'up' : 'down';
      }
    }
    fields.forEach(([key, val]) => { if (val != null) prev[key] = val; });
    if (Object.keys(flashes).length > 0) {
      setCardFlash(flashes);
      setTimeout(() => setCardFlash({}), 800);
    }
  }, [account?.equity, account?.buyingPower, account?.dayPL, account?.cash]);

  // Fetch line chart data using the same API as the Research tab
  useEffect(() => {
    if (!candleSymbol) return;
    function loadLine() {
      fetchPriceHistory(candleSymbol, linePeriod)
        .then(d => setLineData(d.map(p => ({ date: p.date, price: p.value }))))
        .catch(() => setLineData([]));
    }
    loadLine();
    const id = setInterval(loadLine, 15000);
    return () => clearInterval(id);
  }, [candleSymbol, linePeriod]);

  // Auto-scroll through tickers every 5 seconds
  useEffect(() => {
    if (!autoScroll || !trader) return;
    const wl = trader.config.watchlist;
    if (wl.length === 0) return;
    const id = setInterval(() => {
      scrollIndexRef.current = (scrollIndexRef.current + 1) % wl.length;
      setCandleSymbol(wl[scrollIndexRef.current]);
    }, 10000);
    return () => clearInterval(id);
  }, [autoScroll, trader?.config.watchlist.join(',')]);

  async function pushConfig(patch) {
    setSaving(true);
    try {
      const t = await saveTraderConfig(patch);
      setTrader(t);
      setForm({ ...t.config, watchlistText: t.config.watchlist.join(', ') });
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    await pushConfig({ enabled: !trader.config.enabled });
  }

  // Per-ticker exit rule edits auto-save (debounced) instead of requiring a
  // separate click on the shared "Save settings" button — previously these
  // silently reset on reload if the user forgot to click Save. Updates only
  // `trader` (not the whole `form`) so it doesn't clobber other in-progress
  // edits elsewhere on the settings panel.
  function setTickerOverride(sym, field, val) {
    const ovr = form.tickerOverrides?.[sym] || {};
    const updatedOverrides = { ...form.tickerOverrides, [sym]: { ...ovr, [field]: val } };
    setForm(f => ({ ...f, tickerOverrides: updatedOverrides }));

    clearTimeout(overrideSaveTimers.current[sym]);
    overrideSaveTimers.current[sym] = setTimeout(async () => {
      const cleaned = {};
      for (const s of Object.keys(updatedOverrides)) {
        const o = updatedOverrides[s];
        const hasSl = o?.stopLossPct !== '' && o?.stopLossPct != null;
        const hasTp = o?.takeProfitPct !== '' && o?.takeProfitPct != null;
        if (hasSl || hasTp) {
          cleaned[s] = {};
          if (hasSl) cleaned[s].stopLossPct = +o.stopLossPct;
          if (hasTp) cleaned[s].takeProfitPct = +o.takeProfitPct;
        }
      }
      try {
        const t = await saveTraderConfig({ tickerOverrides: cleaned });
        setTrader(t);
      } catch (e) {
        setError(e.message);
      }
    }, 800);
  }

  async function saveSettings() {
    const watchlist = form.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const tickerOverrides = {};
    for (const sym of watchlist) {
      const ovr = form.tickerOverrides?.[sym];
      if (ovr && (ovr.stopLossPct !== '' || ovr.takeProfitPct !== '')) {
        tickerOverrides[sym] = {};
        if (ovr.stopLossPct !== '' && ovr.stopLossPct != null) tickerOverrides[sym].stopLossPct = +ovr.stopLossPct;
        if (ovr.takeProfitPct !== '' && ovr.takeProfitPct != null) tickerOverrides[sym].takeProfitPct = +ovr.takeProfitPct;
      }
    }
    await pushConfig({
      watchlist,
      intervalMinutes: +form.intervalMinutes,
      perTradeDollars: +form.perTradeDollars,
      maxPositionDollars: +form.maxPositionDollars,
      maxTradesPerDay: +form.maxTradesPerDay,
      stopLossPct: +form.stopLossPct,
      takeProfitPct: +form.takeProfitPct,
      tickerOverrides,
    });
  }

  async function runNow() {
    setRunning(true);
    try {
      const t = await runTraderNow();
      setTrader(t);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const [atrLoading, setAtrLoading] = useState(false);

  const DEFAULTS = {
    intervalMinutes: 15,
    perTradeDollars: 2000,
    maxPositionDollars: 60000,
    maxTradesPerDay: 10,
    stopLossPct: -3,
    takeProfitPct: 5,
    tickerOverrides: {},
  };

  async function autoSetFromATR() {
    const watchlist = trader.config.watchlist;
    if (!watchlist.length) return;
    setAtrLoading(true);
    try {
      const levels = await fetchAtrLevels(watchlist);
      const overrides = { ...(form.tickerOverrides || {}) };
      for (const sym of watchlist) {
        if (levels[sym]) {
          overrides[sym] = {
            ...(overrides[sym] || {}),
            stopLossPct: levels[sym].stopLossPct,
            takeProfitPct: levels[sym].takeProfitPct,
          };
        }
      }
      const updatedForm = { ...form, tickerOverrides: overrides };
      setForm(updatedForm);
      const wl = updatedForm.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      await pushConfig({
        watchlist: wl,
        intervalMinutes: +updatedForm.intervalMinutes,
        perTradeDollars: +updatedForm.perTradeDollars,
        maxPositionDollars: +updatedForm.maxPositionDollars,
        maxTradesPerDay: +updatedForm.maxTradesPerDay,
        stopLossPct: +updatedForm.stopLossPct,
        takeProfitPct: +updatedForm.takeProfitPct,
        tickerOverrides: overrides,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setAtrLoading(false);
    }
  }

  async function restoreDefaults() {
    const watchlist = trader.config.watchlist;
    const newForm = {
      ...DEFAULTS,
      watchlist,
      watchlistText: watchlist.join(', '),
    };
    setForm(newForm);
    await pushConfig({
      watchlist,
      ...DEFAULTS,
    });
  }

  function handleTickerClick(sym) {
    setCandleSymbol(sym);
    setAutoScroll(false);
    const wl = trader.config.watchlist;
    scrollIndexRef.current = wl.indexOf(sym);
  }

  if (!trader || !form) {
    return <div className="at-loading"><div className="spinner" /><p>Connecting to Alpaca…</p></div>;
  }

  const enabled = trader.config.enabled;

  const journal = trader.log.filter(d => d.executed);

  // Duplicate tape items for seamless scrolling
  const tapeItems = tickerPrices.length > 0 ? [...tickerPrices, ...tickerPrices] : [];

  return (
    <div className="at-wrap">
      {/* Scrolling ticker tape */}
      {tapeItems.length > 0 && (
        <div className="at-tape-wrap">
          <div className="at-tape">
            {tapeItems.map((t, i) => {
              const isIndex = t.symbol.startsWith('^');
              const displaySym = t.symbol === '^GSPC' ? 'S&P 500' : t.symbol === '^DJI' ? 'Dow Jones' : t.symbol === '^IXIC' ? 'NASDAQ' : t.symbol;
              return (
                <span className="at-tape-item" key={i}>
                  {isIndex ? (
                    <span className="at-tape-sym">{displaySym}</span>
                  ) : (
                    <TickerLink symbol={t.symbol} name={t.name} className="at-tape-sym" />
                  )}
                  <span className="at-tape-price">{t.price != null ? `$${t.price.toFixed(2)}` : '—'}</span>
                  <span className={`at-tape-change ${(t.change ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                    {t.change != null ? `${t.change >= 0 ? '+' : ''}${t.change.toFixed(2)}%` : ''}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="at-titlebar">
        <h1>🤖 Auto-Trader</h1>
        <div className="at-titlebar-right">
          <a className="at-alpaca-link" href="https://app.alpaca.markets/paper/dashboard/overview" target="_blank" rel="noopener noreferrer">
            Open Alpaca ↗
          </a>
          <span className="at-paper-badge">PAPER · fake money</span>
        </div>
      </div>
      {error && <div className="at-error">⚠️ {error}</div>}

      {/* Account summary */}
      <div className="at-cards">
        <div className="at-card">
          <span className="at-card-label">Total Fund</span>
          <span className="at-card-value">
            <RollingNumber value={money(account?.equity)} flash={cardFlash.equity} />
          </span>
        </div>
        <div className="at-card">
          <span className="at-card-label">Total Stock</span>
          <span className="at-card-value">
            <RollingNumber value={money(account ? account.equity - account.cash : null)} flash={cardFlash.totalStock} />
          </span>
        </div>
        <div className="at-card">
          <span className="at-card-label">Avail Fund</span>
          <span className="at-card-value">
            <RollingNumber value={money(account?.cash)} flash={cardFlash.cash} />
          </span>
        </div>
        <div className="at-card">
          <span className="at-card-label">Today's P&L</span>
          <span className={`at-card-value ${account?.dayPL >= 0 ? 'pos' : 'neg'}`}>
            <RollingNumber
              value={account ? `${account.dayPL >= 0 ? '+' : ''}${money(account.dayPL)}` : '—'}
              flash={cardFlash.dayPL}
            />
            <small> {account ? pct(account.dayPLPct) : ''}</small>
          </span>
        </div>
        <div className="at-card">
          <span className="at-card-label">Total Profits</span>
          <span className={`at-card-value ${(account?.totalPL ?? 0) >= 0 ? 'pos' : 'neg'}`}>
            <RollingNumber
              value={account ? `${account.totalPL >= 0 ? '+' : ''}${money(account.totalPL)}` : '—'}
              flash={cardFlash.totalPL}
            />
            <small> {account ? pct(account.totalPLPct) : ''}</small>
          </span>
        </div>
      </div>

      {/* Charts — candlestick + line side by side */}
      <div className="at-panel" onClick={() => autoScroll && setAutoScroll(false)}>
        <div className="at-charts-head">
          <h2 className="at-panel-title">{candleSymbol} Charts</h2>
          <button
            className={`at-autoscroll-btn ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(!autoScroll)}
          >
            {autoScroll ? '⏸ Pause' : '▶ Auto-scroll'}
          </button>
        </div>
        <div className="at-candle-picker">
          {trader.config.watchlist.map(s => (
            <button key={s}
              className={`at-candle-btn ${candleSymbol === s ? 'active' : ''}`}
              onClick={() => handleTickerClick(s)}
            >{s}</button>
          ))}
        </div>
        <div className="at-charts-split">
          <div className="at-chart-half">
            <div className="at-chart-label-row at-chart-label-row-candle">
              <h3 className="at-chart-label">Candlestick <button className="at-patterns-btn" onClick={() => setShowPatterns(true)} title="Candlestick patterns guide">?</button></h3>
              <div className="at-interval-picker">
                {['1D', '1W', '1M', '3M', '1Y'].map(p => (
                  <button key={p}
                    className={`at-interval-btn ${candlePeriod === p ? 'active' : ''}`}
                    onClick={() => setCandlePeriod(p)}
                  >{p}</button>
                ))}
              </div>
            </div>
            {candleSymbol && <CandlestickChart symbol={candleSymbol} period={candlePeriod} />}
          </div>
          <div className="at-chart-half">
            <div className="at-chart-label-row">
              <h3 className="at-chart-label">Price</h3>
              <div className="at-interval-picker">
                {['1D', '1W', '1M', 'YTD', '1Y', '5Y', 'ALL'].map(p => (
                  <button key={p}
                    className={`at-interval-btn ${linePeriod === p ? 'active' : ''}`}
                    onClick={() => setLinePeriod(p)}
                  >{p}</button>
                ))}
              </div>
            </div>
            {lineData.length > 0 ? (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={lineData} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke="#232634" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} minTickGap={40} />
                  <YAxis domain={['auto', 'auto']} width={60} tick={{ fontSize: 11, fill: '#6b7280' }}
                    tickFormatter={v => '$' + v.toFixed(0)} />
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8, color: '#e2e8f0' }}
                    formatter={(v) => ['$' + Number(v).toFixed(2), 'Price']} />
                  <Line type="monotone" dataKey="price" stroke="#4f6ef7" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="at-empty">Loading…</p>
            )}
          </div>
        </div>
      </div>

      {/* Bot control — read-only for visitors, editable for admin */}
      <div className="at-panel">
        <div className="at-bot-header">
          <div>
            <div className="at-bot-title">
              Bot is <span className={enabled ? 'on' : 'off'}>{enabled ? 'ON' : 'OFF'}</span>
              {!isAdmin && (
                <button className="at-lock-btn" onClick={() => setShowLogin(true)} title="Admin login">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </button>
              )}
              {isAdmin && <span className="at-admin-badge">Admin</span>}
            </div>
            <div className="at-bot-sub">
              Last run {timeAgo(trader.lastRun)}{trader.lastRunNote ? ` · ${trader.lastRunNote}` : ''} ·
              {' '}{trader.trades.count}/{trader.config.maxTradesPerDay} trades today
            </div>
            {trader.engines && (
              <div className="at-engines">
                <span className="at-engines-label">AI failover:</span>
                {trader.engines.map((e, idx) => (
                  <span key={e.name}>
                    {idx > 0 && <span className="at-engines-arrow"> → </span>}
                    <span className={`at-engine-chip ${e.available ? 'on' : 'off'}`}>
                      {e.name}{e.available ? '' : ' (no key)'}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="at-bot-actions">
            <button className="at-run-btn" onClick={runNow} disabled={running || !isAdmin}>
              {running ? 'Analyzing…' : 'Run analysis now'}
            </button>
            <button className={`at-toggle ${enabled ? 'on' : 'off'}`} onClick={toggleEnabled} disabled={saving || !isAdmin}>
              <span className="at-toggle-knob" />
              {enabled ? 'Turn OFF' : 'Turn ON'}
            </button>
          </div>
        </div>

        {/* Settings */}
        <div className="at-settings">
          <div className="at-field at-field-wide">
            <span>Watchlist</span>
            <div className="at-watchlist-tags">
              {form.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).map(sym => (
                <span className="at-wl-tag" key={sym}>
                  {sym}
                  {isAdmin && <button className="at-wl-remove" onClick={() => {
                    const list = form.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(s => s && s !== sym);
                    setForm({ ...form, watchlistText: list.join(', ') });
                  }}>×</button>}
                </span>
              ))}
              {isAdmin && <div className="at-wl-add">
                <input
                  className="at-wl-input"
                  placeholder="TICKER"
                  value={newTicker}
                  onChange={e => setNewTicker(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newTicker.trim()) {
                      const existing = form.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                      if (!existing.includes(newTicker.trim())) {
                        setForm({ ...form, watchlistText: [...existing, newTicker.trim()].join(', ') });
                      }
                      setNewTicker('');
                    }
                  }}
                />
                <button className="at-wl-add-btn" onClick={() => {
                  if (!newTicker.trim()) return;
                  const existing = form.watchlistText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                  if (!existing.includes(newTicker.trim())) {
                    setForm({ ...form, watchlistText: [...existing, newTicker.trim()].join(', ') });
                  }
                  setNewTicker('');
                }}>Add</button>
              </div>}
            </div>
          </div>
          <label className="at-field">
            <span>Check every (min)</span>
            <input type="number" min="1" max="240" value={form.intervalMinutes} disabled={!isAdmin}
              onChange={e => setForm({ ...form, intervalMinutes: e.target.value })} />
          </label>
          <label className="at-field">
            <span>$ per trade</span>
            <input type="number" min="1" value={form.perTradeDollars} disabled={!isAdmin}
              onChange={e => setForm({ ...form, perTradeDollars: e.target.value })} />
          </label>
          <label className="at-field">
            <span>Max $ per position</span>
            <input type="number" min="1" value={form.maxPositionDollars} disabled={!isAdmin}
              onChange={e => setForm({ ...form, maxPositionDollars: e.target.value })} />
          </label>
          <label className="at-field">
            <span>Max trades / day</span>
            <input type="number" min="1" value={form.maxTradesPerDay} disabled={!isAdmin}
              onChange={e => setForm({ ...form, maxTradesPerDay: e.target.value })} />
          </label>
          <label className="at-field">
            <span>Stop loss %</span>
            <input type="number" max="0" step="0.5" value={form.stopLossPct} disabled={!isAdmin}
              onChange={e => setForm({ ...form, stopLossPct: e.target.value })} />
          </label>
          <label className="at-field">
            <span>Take profit %</span>
            <input type="number" min="0" step="0.5" value={form.takeProfitPct} disabled={!isAdmin}
              onChange={e => setForm({ ...form, takeProfitPct: e.target.value })} />
          </label>
          {isAdmin && <div className="at-settings-actions">
            <button className="at-save-btn" onClick={saveSettings} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button className="at-restore-btn" onClick={restoreDefaults} disabled={saving}>
              Restore defaults
            </button>
          </div>}
        </div>

        {/* Per-ticker exit overrides */}
        <div className="at-overrides">
          <div className="at-overrides-head">
            <div>
              <h3 className="at-overrides-title">Per-Ticker Exit Rules</h3>
              <p className="at-overrides-sub">Leave blank to use the global defaults above. Changes save automatically. Currently held stocks always show here, even if rotated out of today's watchlist.</p>
            </div>
            {isAdmin && <button className="at-atr-btn" onClick={autoSetFromATR} disabled={atrLoading}>
              {atrLoading ? 'Calculating…' : 'Auto-set from volatility'}
            </button>}
          </div>
          <div className="at-overrides-grid">
            {[...new Set([...trader.config.watchlist, ...positions.map(p => p.symbol)])].map(sym => {
              const ovr = form.tickerOverrides?.[sym] || {};
              const setOvr = (field, val) => setTickerOverride(sym, field, val);
              const inWatchlist = trader.config.watchlist.includes(sym);
              return (
                <div className="at-ovr-row" key={sym}>
                  <TickerLink symbol={sym} name={tickerNames[sym]} className="at-ovr-sym" />
                  {!inWatchlist && <span className="at-ovr-held" title="Currently held but rotated out of today's watchlist">held</span>}
                  <label className="at-ovr-field">
                    <span>SL %</span>
                    <input type="number" max="0" step="0.5" disabled={!isAdmin}
                      placeholder={form.stopLossPct}
                      value={ovr.stopLossPct ?? ''}
                      onChange={e => setOvr('stopLossPct', e.target.value)} />
                  </label>
                  <label className="at-ovr-field">
                    <span>TP %</span>
                    <input type="number" min="0" step="0.5" disabled={!isAdmin}
                      placeholder={form.takeProfitPct}
                      value={ovr.takeProfitPct ?? ''}
                      onChange={e => setOvr('takeProfitPct', e.target.value)} />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Positions */}
      <div className="at-panel">
        <h2 className="at-panel-title">Positions ({positions.length})</h2>
        {positions.length === 0 ? (
          <p className="at-empty">No open positions.</p>
        ) : (
          <table className="at-table">
            <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Price</th><th>Value</th><th>P&L</th></tr></thead>
            <tbody>
              {positions.map(p => (
                <tr key={p.symbol}>
                  <td className="at-sym"><TickerLink symbol={p.symbol} name={tickerNames[p.symbol]} /></td>
                  <td>{p.qty}</td>
                  <td>{money(p.avgEntry)}</td>
                  <td>{money(p.current)}</td>
                  <td>{money(p.marketValue)}</td>
                  <td className={p.unrealizedPL >= 0 ? 'pos' : 'neg'}>
                    {money(p.unrealizedPL)} <small>{pct(p.unrealizedPLPct)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Trade journal */}
      <div className="at-panel">
        <h2 className="at-panel-title">Trade Journal ({journal.length})</h2>
        {journal.length === 0 ? (
          <p className="at-empty">No executed trades yet.</p>
        ) : (
          <table className="at-table">
            <thead><tr><th>Time</th><th>Symbol</th><th>Action</th><th>Detail</th><th>Price</th><th>Engine</th></tr></thead>
            <tbody>
              {journal.map((d, i) => (
                <tr key={i}>
                  <td>{new Date(d.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="at-sym"><TickerLink symbol={d.symbol} name={tickerNames[d.symbol]} /></td>
                  <td className={d.action === 'buy' ? 'pos' : 'neg'}>{d.action}</td>
                  <td>{d.note}</td>
                  <td>{money(d.price)}</td>
                  <td>{d.engine && <span className={`at-engine at-engine-${d.engine.toLowerCase()}`}>{d.engine}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showLogin && (
        <div className="at-modal-overlay" onClick={() => setShowLogin(false)}>
          <div className="at-login-modal" onClick={e => e.stopPropagation()}>
            <button className="at-modal-close" onClick={() => { setShowLogin(false); setLoginError(''); setLoginKey(''); }}>&times;</button>
            <div className="at-login-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4f6ef7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h3>Admin Access</h3>
            <p>Enter your admin key to manage the bot.</p>
            <form onSubmit={handleLogin}>
              <input
                type="password"
                className="at-login-input"
                placeholder="Admin key"
                value={loginKey}
                onChange={e => { setLoginKey(e.target.value); setLoginError(''); }}
                autoFocus
              />
              {loginError && <div className="at-login-error">{loginError}</div>}
              <button type="submit" className="at-login-submit" disabled={loginLoading || !loginKey.trim()}>
                {loginLoading ? 'Verifying…' : 'Unlock'}
              </button>
            </form>
          </div>
        </div>
      )}

      {showPatterns && (
        <div className="at-modal-overlay" onClick={() => setShowPatterns(false)}>
          <div className="at-modal" onClick={e => e.stopPropagation()}>
            <div className="at-modal-header">
              <h3>Candlestick Patterns Guide</h3>
              <button className="at-modal-close" onClick={() => setShowPatterns(false)}>&times;</button>
            </div>
            <div className="at-modal-body">
              <div className="at-pattern-section">
                <h4 className="at-pattern-heading bullish">Bullish Patterns</h4>
                <div className="at-pattern-grid">
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="50" y1="15" x2="50" y2="90" stroke="#4ade80" strokeWidth="4"/><rect x="38" y="15" width="24" height="22" fill="#0f1117" stroke="#4ade80" strokeWidth="4" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Hammer</strong>
                      <p>Small body at the top with a long lower wick. Signals a potential reversal after a downtrend — buyers stepped in and pushed the price back up.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="32" y1="30" x2="32" y2="75" stroke="#f87171" strokeWidth="3"/><rect x="22" y="45" width="20" height="25" fill="#f87171" stroke="#f87171" strokeWidth="3" rx="2"/><line x1="68" y1="15" x2="68" y2="85" stroke="#4ade80" strokeWidth="3"/><rect x="58" y="20" width="20" height="55" fill="#0f1117" stroke="#4ade80" strokeWidth="3" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Bullish Engulfing</strong>
                      <p>A large green candle completely engulfs the previous red candle. Strong reversal signal showing buyers have overwhelmed sellers.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="50" y1="15" x2="50" y2="90" stroke="#4ade80" strokeWidth="4"/><rect x="38" y="15" width="24" height="6" fill="#0f1117" stroke="#4ade80" strokeWidth="4" rx="1"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Dragonfly Doji</strong>
                      <p>Open and close are nearly equal at the top with a long lower wick. Indicates rejection of lower prices and potential upward reversal.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="20" y1="25" x2="20" y2="80" stroke="#f87171" strokeWidth="3"/><rect x="12" y="35" width="16" height="35" fill="#f87171" stroke="#f87171" strokeWidth="3" rx="2"/><line x1="50" y1="55" x2="50" y2="75" stroke="#9ca3af" strokeWidth="3"/><rect x="42" y="60" width="16" height="10" fill="#0f1117" stroke="#9ca3af" strokeWidth="3" rx="1"/><line x1="80" y1="15" x2="80" y2="70" stroke="#4ade80" strokeWidth="3"/><rect x="72" y="20" width="16" height="40" fill="#0f1117" stroke="#4ade80" strokeWidth="3" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Morning Star</strong>
                      <p>Three-candle pattern: a long red candle, a small-bodied candle that gaps down, then a long green candle. Signals a strong bottom reversal.</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="at-pattern-section">
                <h4 className="at-pattern-heading bearish">Bearish Patterns</h4>
                <div className="at-pattern-grid">
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="50" y1="10" x2="50" y2="85" stroke="#f87171" strokeWidth="4"/><rect x="38" y="63" width="24" height="22" fill="#f87171" stroke="#f87171" strokeWidth="4" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Shooting Star</strong>
                      <p>Small body at the bottom with a long upper wick. After an uptrend, signals sellers pushed the price back down — potential reversal.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="32" y1="10" x2="32" y2="55" stroke="#4ade80" strokeWidth="3"/><rect x="22" y="15" width="20" height="25" fill="#0f1117" stroke="#4ade80" strokeWidth="3" rx="2"/><line x1="68" y1="5" x2="68" y2="80" stroke="#f87171" strokeWidth="3"/><rect x="58" y="10" width="20" height="55" fill="#f87171" stroke="#f87171" strokeWidth="3" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Bearish Engulfing</strong>
                      <p>A large red candle completely engulfs the previous green candle. Shows sellers have taken control — strong reversal to the downside.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="50" y1="10" x2="50" y2="85" stroke="#f87171" strokeWidth="4"/><rect x="38" y="79" width="24" height="6" fill="#f87171" stroke="#f87171" strokeWidth="4" rx="1"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Gravestone Doji</strong>
                      <p>Open and close are nearly equal at the bottom with a long upper wick. Signals rejection of higher prices and potential drop.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="20" y1="15" x2="20" y2="70" stroke="#4ade80" strokeWidth="3"/><rect x="12" y="20" width="16" height="35" fill="#0f1117" stroke="#4ade80" strokeWidth="3" rx="2"/><line x1="50" y1="10" x2="50" y2="30" stroke="#9ca3af" strokeWidth="3"/><rect x="42" y="15" width="16" height="10" fill="#0f1117" stroke="#9ca3af" strokeWidth="3" rx="1"/><line x1="80" y1="25" x2="80" y2="80" stroke="#f87171" strokeWidth="3"/><rect x="72" y="35" width="16" height="40" fill="#f87171" stroke="#f87171" strokeWidth="3" rx="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Evening Star</strong>
                      <p>Three-candle pattern: a long green candle, a small-bodied candle that gaps up, then a long red candle. Signals a top reversal.</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="at-pattern-section">
                <h4 className="at-pattern-heading neutral">Reading the Candle</h4>
                <div className="at-pattern-grid">
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="30" y1="8" x2="30" y2="92" stroke="#4ade80" strokeWidth="4"/><rect x="20" y="25" width="20" height="45" fill="#0f1117" stroke="#4ade80" strokeWidth="4" rx="2"/><text x="45" y="12" fill="#6b7280" fontSize="10">High</text><text x="45" y="30" fill="#4ade80" fontSize="10">Close</text><text x="45" y="72" fill="#4ade80" fontSize="10">Open</text><text x="45" y="92" fill="#6b7280" fontSize="10">Low</text><line x1="43" y1="9" x2="32" y2="9" stroke="#6b7280" strokeWidth="1" strokeDasharray="2"/><line x1="43" y1="27" x2="40" y2="27" stroke="#4ade80" strokeWidth="1" strokeDasharray="2"/><line x1="43" y1="69" x2="40" y2="69" stroke="#4ade80" strokeWidth="1" strokeDasharray="2"/><line x1="43" y1="90" x2="32" y2="90" stroke="#6b7280" strokeWidth="1" strokeDasharray="2"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Anatomy of a Candle</strong>
                      <p>The body shows open-to-close range. Green = close above open (bullish). Red = close below open (bearish). Wicks show the high and low reached during the period.</p>
                    </div>
                  </div>
                  <div className="at-pattern-card">
                    <div className="at-pattern-icon">
                      <svg viewBox="0 0 100 100" width="64" height="64"><line x1="50" y1="20" x2="50" y2="80" stroke="#9ca3af" strokeWidth="4"/><rect x="38" y="47" width="24" height="6" fill="#1a1d27" stroke="#9ca3af" strokeWidth="4" rx="1"/></svg>
                    </div>
                    <div className="at-pattern-info">
                      <strong>Doji</strong>
                      <p>Open and close are nearly equal, creating a cross shape. Signals indecision — neither buyers nor sellers are in control. Watch for the next candle to confirm direction.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
