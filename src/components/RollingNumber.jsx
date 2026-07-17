import { useState, useEffect, useRef } from 'react';

const DIGITS = '0123456789';
const DIGIT_H = 1;

function RollingDigit({ digit, animate }) {
  const idx = DIGITS.indexOf(digit);
  const isDigit = idx !== -1;

  if (!isDigit) return <span className="rn-static">{digit}</span>;

  return (
    <span className="rn-slot">
      <span
        className="rn-strip"
        style={{
          transform: `translateY(-${idx * DIGIT_H}em)`,
          transition: animate ? 'transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
        }}
      >
        {DIGITS.split('').map(d => (
          <span className="rn-digit" key={d}>{d}</span>
        ))}
      </span>
    </span>
  );
}

export default function RollingNumber({ value, flash }) {
  const [displayValue, setDisplayValue] = useState(value);
  const [animate, setAnimate] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    if (value !== prevRef.current) {
      setAnimate(true);
      setDisplayValue(value);
      prevRef.current = value;
    }
  }, [value]);

  const flashCls = flash === 'up' ? 'rn-flash-up' : flash === 'down' ? 'rn-flash-down' : '';

  return (
    <span className={`rn-wrap ${flashCls}`}>
      {displayValue.split('').map((ch, i) => (
        <RollingDigit key={i} digit={ch} animate={animate} />
      ))}
    </span>
  );
}
