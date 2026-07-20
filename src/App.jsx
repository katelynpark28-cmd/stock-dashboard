import { useState, useEffect, useRef } from 'react';
import { fetchAll } from './api';
import Dashboard from './components/Dashboard';
import MarketOverview from './components/MarketOverview';
import ChatBot from './components/ChatBot';
import AutoTrader from './components/AutoTrader';
import './App.css';

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function App() {
  const [ticker, setTicker] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [view, setView] = useState('trader'); // 'research' | 'trader'
  const debouncedQuery = useDebounce(ticker, 220);
  const wrapperRef = useRef(null);

  // Fetch suggestions as user types
  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 1) { setSuggestions([]); return; }
    fetch(`/api/search?q=${encodeURIComponent(debouncedQuery)}`)
      .then(r => r.json())
      .then(hits => { setSuggestions(hits); setShowSuggestions(true); })
      .catch(() => {});
  }, [debouncedQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function search(sym) {
    const symbol = (typeof sym === 'string' ? sym : ticker).trim().toUpperCase();
    if (!symbol) return;
    setTicker(symbol);
    setShowSuggestions(false);
    setSuggestions([]);
    setLoading(true);
    setError('');
    setData(null);
    try {
      const result = await fetchAll(symbol);
      if (!result.profile) throw new Error('Ticker not found.');
      setData(result);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    search(ticker);
  }

  function handleSuggestionClick(symbol) {
    search(symbol);
  }

  return (
    <div className="app">
      <p className="at-attribution">
        This tool is built by Katelyn Park with Claude Code, Groq, Gemini, Alpaca. This uses fake money for simulation purposes only. If you have any questions or comments, please reach out to <a href="mailto:katelyn_park@brown.edu">katelyn_park@brown.edu</a>.
      </p>
      <header className="app-header">
        <div className="header-inner">
          <div className="logo" style={{ cursor: 'pointer' }} onClick={() => { setView('research'); setData(null); setError(''); setTicker(''); }}>
            📊 StocKP
          </div>
          <nav className="header-nav">
            <button
              className={`nav-btn ${view === 'research' ? 'active' : ''}`}
              onClick={() => setView('research')}
            >Research</button>
            <button
              className={`nav-btn ${view === 'trader' ? 'active' : ''}`}
              onClick={() => setView('trader')}
            >🤖 Auto-Trader</button>
          </nav>
          <form onSubmit={handleSubmit} className="search-form" ref={wrapperRef} style={{ visibility: view === 'trader' ? 'hidden' : 'visible' }}>
            <div className="search-wrap">
              <input
                className="search-input"
                value={ticker}
                onChange={e => { setTicker(e.target.value); setShowSuggestions(true); }}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Ticker or company name (e.g. Apple, AAPL)"
                spellCheck={false}
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="suggestions-dropdown">
                  {suggestions.map(s => (
                    <div key={s.symbol} className="suggestion-item" onMouseDown={() => handleSuggestionClick(s.symbol)}>
                      <span className="sug-symbol">{s.symbol}</span>
                      <span className="sug-name">{s.name}</span>
                      <span className="sug-exchange">{s.exchange}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button className="search-btn" type="submit" disabled={loading}>
              {loading ? 'Loading…' : 'Search'}
            </button>
          </form>
        </div>
      </header>

      <main className="main">
        {view === 'trader' ? (
          <AutoTrader />
        ) : (
          <>
            {!data && !loading && !error && <MarketOverview onSearch={search} />}
            {loading && (
              <div className="loading-state">
                <div className="spinner" />
                <p>Fetching financial data…</p>
              </div>
            )}
            {error && (
              <div className="error-state">
                <div className="error-icon">⚠️</div>
                <p>{error}</p>
              </div>
            )}
            {data && <Dashboard data={data} />}
          </>
        )}
      </main>
      {view === 'research' && <ChatBot currentStock={data?.profile?.symbol ?? null} />}
    </div>
  );
}
