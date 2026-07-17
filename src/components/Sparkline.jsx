import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#1a1d27',
      border: '1px solid #4f6ef7',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: '0.78rem',
      color: '#e2e8f0',
    }}>
      <div style={{ color: '#718096', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{formatter ? formatter(payload[0].value) : payload[0].value}</div>
    </div>
  );
}

export default function Sparkline({ data, dates, color = '#4ade80', formatter }) {
  if (!data || data.length < 2) return null;

  const chartData = [...data].reverse().map((v, i) => ({
    value: v,
    date: dates ? dates[dates.length - 1 - i] : i,
  }));

  return (
    <ResponsiveContainer width="100%" height={60}>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" hide />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip content={<CustomTooltip formatter={formatter} />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#grad-${color.replace('#', '')})`}
          dot={false}
          activeDot={{ r: 4, fill: color }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
