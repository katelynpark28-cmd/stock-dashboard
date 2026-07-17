import { useState } from 'react';
import Sparkline from './Sparkline';
import ChartModal from './ChartModal';

export function fmt(n) {
  if (n === null || n === undefined) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function pct(n) {
  if (n === null || n === undefined) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

export function plain(n) {
  if (n === null || n === undefined) return 'N/A';
  return n.toFixed(2);
}

export default function MetricCard({ title, values, dates, quarterlyValues, quarterlyDates, formatter = fmt, color, ticker, description }) {
  const [modalOpen, setModalOpen] = useState(false);

  if (!values || values.length === 0) return null;
  const latest = values[0];
  const prev = values[1];
  const trend = prev !== undefined ? latest - prev : 0;
  const up = trend >= 0;
  const sparkColor = color || (up ? '#4ade80' : '#f87171');

  return (
    <>
      <div className="metric-card clickable" onClick={() => setModalOpen(true)}>
        <div className="metric-title">{title}</div>
        <div className="metric-value">{formatter(latest)}</div>
        <div className={`metric-trend ${up ? 'up' : 'down'}`}>
          {up ? '▲' : '▼'} {formatter(Math.abs(trend))} vs prior year
        </div>
        <Sparkline data={values} dates={dates} color={sparkColor} formatter={formatter} />
        <div className="card-hint">Click to expand</div>
      </div>

      <ChartModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={title}
        values={values}
        dates={dates}
        quarterlyValues={quarterlyValues}
        quarterlyDates={quarterlyDates}
        color={sparkColor}
        formatter={formatter}
        ticker={ticker}
        description={description}
      />
    </>
  );
}
