import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const FUNDAMENTAL_PERIODS = ['4Q', '3Y', '5Y', 'ALL'];

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{label}</div>
      <div className="tooltip-value">{formatter ? formatter(payload[0].value) : payload[0].value}</div>
    </div>
  );
}

export default function ChartModal({ isOpen, onClose, title, values, dates, quarterlyValues, quarterlyDates, color, formatter, ticker, description }) {
  const [fundPeriod, setFundPeriod] = useState('5Y');
  const [tab, setTab] = useState('fundamental');

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const getFundamentalData = () => {
    // 4Q uses quarterly data; 3Y/5Y/ALL use annual
    const useQuarterly = fundPeriod === '4Q';
    const vals = useQuarterly ? (quarterlyValues || values) : values;
    const dts  = useQuarterly ? (quarterlyDates  || dates)  : dates;

    const allData = [...(vals || [])].reverse().map((v, i) => ({
      date: dts ? dts[dts.length - 1 - i] : `${i}`,
      value: v,
    }));

    if (fundPeriod === 'ALL') return allData;

    const now = new Date();
    const cutoffs = {
      '4Q': new Date(now - 15 * 30 * 24 * 60 * 60 * 1000), // ~15 months to catch 4 quarters
      '3Y': new Date(now - 3 * 365 * 24 * 60 * 60 * 1000),
      '5Y': new Date(now - 5 * 365 * 24 * 60 * 60 * 1000),
    };
    const cutoff = cutoffs[fundPeriod];
    const filtered = cutoff ? allData.filter(d => new Date(d.date) >= cutoff) : allData;
    return filtered.length > 0 ? filtered : allData;
  };

  const chartData = getFundamentalData();
  const vals = chartData.map(d => d.value).filter(v => v != null && !isNaN(v));
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;
  const first = vals[0];
  const last = vals[vals.length - 1];
  const change = first ? ((last - first) / Math.abs(first)) * 100 : 0;
  const up = change >= 0;
  const fmtFn = formatter || (n => n);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{title}</h2>
            <span className="modal-ticker">{ticker}</span>
          </div>
          <div className="modal-stats">
            {last != null && <span className="modal-latest">{fmtFn(last)}</span>}
            <span className={`modal-change ${up ? 'up' : 'down'}`}>
              {up ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
            </span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-tabs">
          <button className={`tab-btn ${tab === 'fundamental' ? 'active' : ''}`} onClick={() => setTab('fundamental')}>Fundamental</button>
          {description && <button className={`tab-btn ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>What is this?</button>}
        </div>

        {tab !== 'info' && (
          <div className="modal-periods">
            {FUNDAMENTAL_PERIODS.map(p => (
              <button key={p} className={`period-btn ${fundPeriod === p ? 'active' : ''}`} onClick={() => setFundPeriod(p)}>{p}</button>
            ))}
          </div>
        )}

        {tab === 'info' && description && (
          <div className="modal-info">
            {description.what && <><h3 className="info-heading">What is {title}?</h3><p className="info-body">{description.what}</p></>}
            {description.up && (
              <div className="info-signal up-signal">
                <span className="info-signal-icon">▲</span>
                <div><strong>Trending up</strong><p>{description.up}</p></div>
              </div>
            )}
            {description.down && (
              <div className="info-signal down-signal">
                <span className="info-signal-icon">▼</span>
                <div><strong>Trending down</strong><p>{description.down}</p></div>
              </div>
            )}
            {description.context && <p className="info-context">{description.context}</p>}
          </div>
        )}

        <div className="modal-chart" style={tab === 'info' ? { display: 'none' } : {}}>
          {chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 10 }}>
                <defs>
                  <linearGradient id="modalGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color || '#4f6ef7'} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={color || '#4f6ef7'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d3148" />
                <XAxis dataKey="date" tick={{ fill: '#718096', fontSize: 11 }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#718096', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtFn} width={85} />
                <Tooltip content={<CustomTooltip formatter={fmtFn} />} />
                <Area type="monotone" dataKey="value" stroke={color || '#4f6ef7'} strokeWidth={2.5}
                  fill="url(#modalGrad)" dot={chartData.length <= 20 ? { fill: color || '#4f6ef7', r: 4, strokeWidth: 0 } : false}
                  activeDot={{ r: 6, fill: color || '#4f6ef7' }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          {chartData.length === 0 && (
            <div className="modal-loading"><p>No data for this period.</p></div>
          )}
        </div>

        {tab !== 'info' && <div className="modal-footer-stats">
          <div className="stat-item"><span className="stat-label">Low</span><span className="stat-val">{fmtFn(min)}</span></div>
          <div className="stat-item"><span className="stat-label">High</span><span className="stat-val">{fmtFn(max)}</span></div>
          <div className="stat-item"><span className="stat-label">Latest</span><span className="stat-val">{fmtFn(last)}</span></div>
          <div className="stat-item"><span className="stat-label">Period change</span><span className={`stat-val ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{change.toFixed(1)}%</span></div>
        </div>}
      </div>
    </div>
  );
}
