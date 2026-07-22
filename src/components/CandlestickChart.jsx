import { useState, useEffect, useRef } from 'react';
import { fetchCandles } from '../tradingApi';

const PERIOD_MAP = {
  '1D': { interval: '5m', range: 2 },
  '1W': { interval: '1h', range: 7 },
  '1M': { interval: '1d', range: 35 },
  '3M': { interval: '1d', range: 95 },
  '1Y': { interval: '1wk', range: 400 },
};

export default function CandlestickChart({ symbol, period = '1D' }) {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tooltip, setTooltip] = useState(null);
  const [fadeKey, setFadeKey] = useState(0);
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);

  const { interval, range } = PERIOD_MAP[period] || PERIOD_MAP['1D'];

  function load() {
    if (!symbol) return;
    fetchCandles(symbol, interval, range)
      .then(d => { setCandles(d); setLoading(false); setFadeKey(k => k + 1); })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    setLoading(true);
    setTooltip(null);
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [symbol, period]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = !loading && candles.length > 0 && width > 0;

  const height = 340;
  const margin = { top: 12, right: 12, bottom: 28, left: 48 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  let allHigh = 0, allLow = 0, yMin = 0, yMax = 0, gap = 0, candleW = 0;
  let yScale = () => 0, xPos = () => 0, yTicks = [], xStep = 1;

  if (ready) {
    allHigh = Math.max(...candles.map(c => c.high));
    allLow = Math.min(...candles.map(c => c.low));
    const pad = (allHigh - allLow) * 0.08 || 1;
    yMin = allLow - pad;
    yMax = allHigh + pad;
    gap = innerW / candles.length;
    candleW = Math.max(4, Math.min(gap * 0.65, 40));
    yScale = (v) => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
    xPos = (i) => margin.left + i * gap + gap / 2;
    yTicks = Array.from({ length: 5 }, (_, i) => yMin + (i / 4) * (yMax - yMin));
    xStep = Math.max(1, Math.floor(candles.length / 8));
  }

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {loading && <p className="at-empty">Loading candles…</p>}
      {!loading && !candles.length && <p className="at-empty">No candle data.</p>}
      {ready && (
        <svg width={width} height={height} className="cs-svg" key={fadeKey}>
          <defs>
            <filter id="glow-blur-green" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
            </filter>
            <filter id="glow-blur-red" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
            </filter>
          </defs>

          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={margin.left} x2={width - margin.right} y1={yScale(v)} y2={yScale(v)} stroke="#232634" />
              <text x={margin.left - 6} y={yScale(v) + 4} textAnchor="end" fill="#6b7280" fontSize={11}>
                ${v.toFixed(0)}
              </text>
            </g>
          ))}

          {candles.map((c, i) => {
            const up = c.close >= c.open;
            const color = up ? '#4ade80' : '#f87171';
            const bodyTop = yScale(Math.max(c.open, c.close));
            const bodyBot = yScale(Math.min(c.open, c.close));
            const bodyH = Math.max(1, bodyBot - bodyTop);
            const x = xPos(i);
            return (
              <g key={i} className="cs-candle"
                style={{ animationDelay: `${i * Math.min(40, 1500 / candles.length)}ms` }}
                onMouseEnter={() => setTooltip({ i, ...c, x, y: yScale(c.high) })}
                onMouseLeave={() => setTooltip(null)}
              >
                <rect x={x - gap / 2} y={margin.top} width={gap} height={innerH} fill="transparent" />
                {/* Soft glow behind candle */}
                <ellipse cx={x} cy={bodyTop + bodyH / 2} rx={candleW / 2 + 4} ry={bodyH / 2 + 6}
                  fill={up ? '#4ade80' : '#f87171'} opacity={0.35}
                  filter={up ? 'url(#glow-blur-green)' : 'url(#glow-blur-red)'} />
                {/* Wick */}
                <line x1={x} x2={x} y1={yScale(c.high)} y2={yScale(c.low)} stroke={color} strokeWidth={1.5} />
                {/* Body */}
                <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH}
                  fill={up ? '#0f1117' : color} stroke={color} strokeWidth={1.5} rx={2} />
              </g>
            );
          })}

          {candles.map((c, i) => i % xStep === 0 ? (
            <text key={i} x={xPos(i)} y={height - 6} textAnchor="middle" fill="#6b7280" fontSize={11}>
              {c.date}
            </text>
          ) : null)}

          {tooltip && (() => {
            const tx = tooltip.x + 14 + 155 > width ? tooltip.x - 165 : tooltip.x + 14;
            const ty = Math.max(margin.top, tooltip.y - 10);
            const up = tooltip.close >= tooltip.open;
            return (
              <g className="cs-tooltip-g">
                <line x1={tooltip.x} x2={tooltip.x} y1={margin.top} y2={margin.top + innerH}
                  stroke="#4f6ef7" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
                <rect x={tx} y={ty} width={155} height={84} rx={8}
                  fill="#1a1d27" stroke="#2d3148" strokeWidth={1} />
                <text x={tx + 12} y={ty + 20} fill="#9ca3af" fontSize={11}>{tooltip.date}</text>
                <text x={tx + 12} y={ty + 38} fill="#e2e8f0" fontSize={12} fontFamily="monospace">
                  O {tooltip.open.toFixed(2)}  H {tooltip.high.toFixed(2)}
                </text>
                <text x={tx + 12} y={ty + 54} fill="#e2e8f0" fontSize={12} fontFamily="monospace">
                  L {tooltip.low.toFixed(2)}   C {tooltip.close.toFixed(2)}
                </text>
                <text x={tx + 12} y={ty + 74} fill={up ? '#4ade80' : '#f87171'} fontSize={12} fontWeight={700}>
                  {up ? '▲' : '▼'} {((tooltip.close - tooltip.open) / tooltip.open * 100).toFixed(2)}%
                </text>
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}
