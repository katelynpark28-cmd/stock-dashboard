import { useEffect, useState } from 'react';
import { LineChart, Line, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { fetchScreener, fetchMarketOverview } from '../api';

const PROFILES = {
  growth: {
    label: 'High Growth & Volatile',
    icon: '⚡',
    description: 'Ranked by trailing 30-day realized volatility — stocks actually swinging right now, not just ones that had a big move sometime in the past year. High upside potential, high drawdown risk.',
  },
  stable: {
    label: 'Long-term & Reliable',
    icon: '🏛️',
    description: 'Ranked by lowest trailing 30-day realized volatility among established companies — the steadiest movers right now, with durable earnings and wide moats.',
  },
};

function fmt(n) {
  if (n == null) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtCap(n) {
  if (!n) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
}

function MiniChart({ data, up }) {
  if (!data?.length) return <div style={{ height: 48 }} />;
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data}>
        <YAxis domain={['auto', 'auto']} hide />
        <Line type="monotone" dataKey="value" stroke={up ? '#4ade80' : '#f87171'} strokeWidth={1.5} dot={false} />
        <Tooltip
          contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 6, fontSize: 11, padding: '4px 8px' }}
          itemStyle={{ color: '#e2e8f0' }}
          formatter={v => [`$${v?.toFixed(2)}`, '']}
          labelFormatter={() => ''}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function MarketOverview({ onSearch }) {
  const [profile, setProfile] = useState(() => localStorage.getItem('investProfile') || 'stable');
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem('investProfile', profile);
    setStocks([]);
    setLoading(true);
    setError('');
    fetchScreener(profile)
      .then(screened => {
        const symbols = screened.map(s => s.symbol);
        const metaBySymbol = Object.fromEntries(screened.map(s => [s.symbol, s]));
        return fetchMarketOverview(symbols).then(overview => {
          // Merge screener metadata (beta, pe, dividendYield) into overview cards
          return overview.map(s => ({ ...s, ...metaBySymbol[s.symbol] }));
        });
      })
      .then(setStocks)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [profile]);

  const active = PROFILES[profile];

  return (
    <div className="market-overview">
      <div className="profile-toggle">
        {Object.entries(PROFILES).map(([key, p]) => (
          <button
            key={key}
            className={`profile-btn ${profile === key ? 'active' : ''}`}
            onClick={() => setProfile(key)}
          >
            <span className="profile-btn-icon">{p.icon}</span>
            <span className="profile-btn-label">{p.label}</span>
          </button>
        ))}
      </div>
      <p className="profile-desc">{active.description}</p>

      {loading && (
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading market data…</p>
        </div>
      )}
      {error && <div className="error-state">⚠️ {error}</div>}

      {!loading && !error && (
        <div className="overview-grid">
          {stocks.map(s => {
            const up = (s.changePct ?? 0) >= 0;
            return (
              <div key={s.symbol} className="overview-card" onClick={() => onSearch(s.symbol)}>
                <div className="ov-top">
                  <div>
                    <div className="ov-ticker">{s.symbol}</div>
                    <div className="ov-name">{s.name}</div>
                  </div>
                  <div className="ov-right">
                    <div className="ov-price">{fmt(s.price)}</div>
                    <div className={`ov-change ${up ? 'up' : 'down'}`}>
                      {up ? '▲' : '▼'} {Math.abs(s.changePct ?? 0).toFixed(2)}%
                    </div>
                  </div>
                </div>
                <MiniChart data={s.chartData} up={up} />
                <div className="ov-meta">
                  <span>Mkt Cap {fmtCap(s.mktCap)}</span>
                  {s.rangeScore != null && <span className={profile === 'growth' ? 'up' : ''}>30d volatility {s.rangeScore}%</span>}
                  {s.beta != null && <span>β {s.beta.toFixed(2)}</span>}
                  {s.dividendYield != null && s.dividendYield > 0 && <span>Div {(s.dividendYield * 100).toFixed(1)}%</span>}
                </div>
                {s.reason && <div className="ov-reason">{s.reason}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
