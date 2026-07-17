import { useState, useEffect, useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fetchPriceHistory } from '../api';

const PERIODS = ['1D', '1W', '1M', 'YTD', '1Y', '5Y', 'ALL'];

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{label}</div>
      <div className="tooltip-value">${payload[0].value?.toFixed(2)}</div>
    </div>
  );
}

export default function PriceChart({ ticker }) {
  const [period, setPeriod] = useState('1D');
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dataRef = useRef([]);

  // Initial load + reload when period/ticker changes
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchPriceHistory(ticker, period)
      .then(d => {
        if (!cancelled) {
          dataRef.current = d;
          setData(d);
          setLoading(false);
        }
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [ticker, period]);

  // Live polling — append/update latest point every 3s
  useEffect(() => {
    if (!ticker || loading) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/quote/${ticker}`);
        const q = await r.json();
        if (!q.price) return;
        // Always update the last point so the line tip moves without adding mismatched candles
        const last = dataRef.current[dataRef.current.length - 1];
        if (!last) return;
        const updated = [...dataRef.current.slice(0, -1), { ...last, value: +q.price.toFixed(2) }];
        dataRef.current = updated;
        setData([...updated]);
      } catch (_) {}
    }, 3000);
    return () => clearInterval(id);
  }, [ticker, period, loading]);

  const vals = data.map(d => d.value).filter(v => v != null);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;
  const first = vals[0];
  const last = vals[vals.length - 1];
  const periodChange = first ? ((last - first) / Math.abs(first)) * 100 : 0;
  const up = periodChange >= 0;
  const color = up ? '#4ade80' : '#f87171';

  const pad = (max - min) * 0.08 || 1;
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;

  return (
    <div className="price-chart-card">
      <div className="pc-header">
        <div className="pc-periods">
          {PERIODS.map(p => (
            <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>{p}</button>
          ))}
        </div>
        <div className="pc-stats">
          <span className="pc-stat"><span className="pc-stat-label">Low</span> ${min.toFixed(2)}</span>
          <span className="pc-stat"><span className="pc-stat-label">High</span> ${max.toFixed(2)}</span>
          <span className={`pc-stat ${up ? 'up' : 'down'}`}>
            <span className="pc-stat-label">Period</span>
            {up ? '+' : ''}{periodChange.toFixed(2)}%
          </span>
        </div>
      </div>

      <div className="pc-body">
        {loading && <div className="pc-loading"><div className="spinner" /></div>}
        {error && <div className="pc-error">⚠️ {error}</div>}
        {!loading && !error && data.length > 0 && (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
              <defs>
                <linearGradient id="pcGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2235" />
              <XAxis dataKey="date" tick={{ fill: '#718096', fontSize: 11 }} tickLine={false} interval="preserveStartEnd" />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fill: '#718096', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `$${v.toFixed(0)}`}
                width={60}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                fill="url(#pcGrad)"
                dot={false}
                activeDot={{ r: 5, fill: color, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {!loading && !error && data.length === 0 && (
          <div className="pc-loading" style={{ color: '#718096' }}>No data for this period.</div>
        )}
      </div>
    </div>
  );
}
