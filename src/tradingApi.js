async function get(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Error ${res.status}`);
  }
  return res.json();
}

export const fetchAccount   = () => get('/api/alpaca/account');
export const fetchPositions = () => get('/api/alpaca/positions');
export const fetchOrders    = () => get('/api/alpaca/orders');
export const fetchTrader    = () => get('/api/trader');
export const saveTraderConfig = (patch) => post('/api/trader/config', patch);
export const runTraderNow   = () => post('/api/trader/run', {});
export const fetchCandles   = (symbol, interval = '1d', range) => get(`/api/trader/candles/${symbol}?interval=${interval}${range ? `&range=${range}` : ''}`);
export const fetchAtrLevels = (symbols) => post('/api/trader/atr-levels', { symbols });
export const fetchPrices    = (symbols) => post('/api/trader/prices', { symbols });
