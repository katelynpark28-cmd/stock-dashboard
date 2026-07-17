import Alpaca from '@alpacahq/alpaca-trade-api';
import 'dotenv/config';

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;

// --- Paper-only safety guard -------------------------------------------------
// Alpaca paper keys start with "PK", live keys start with "AK". We hard-refuse
// to run against a live key, and we always route to the paper endpoint. This is
// a deliberate guardrail: this bot is an experiment with fake money only.
export function assertPaper() {
  if (!KEY || !SECRET) {
    throw new Error('ALPACA_KEY / ALPACA_SECRET are missing from .env');
  }
  if (KEY.startsWith('AK')) {
    throw new Error(
      'REFUSING TO START: ALPACA_KEY looks like a LIVE key (starts with "AK"). ' +
      'This bot is paper-only. Use a paper key (starts with "PK").'
    );
  }
  if (!KEY.startsWith('PK')) {
    throw new Error('REFUSING TO START: ALPACA_KEY does not look like a paper key (should start with "PK").');
  }
}

assertPaper();

export const alpaca = new Alpaca({
  keyId: KEY,
  secretKey: SECRET,
  paper: true, // always paper, never live
});

// Convenience wrappers used by the routes -----------------------------------
export async function getAccountSummary() {
  const a = await alpaca.getAccount();
  return {
    equity: +a.equity,
    lastEquity: +a.last_equity,
    buyingPower: +a.buying_power,
    cash: +a.cash,
    portfolioValue: +a.portfolio_value,
    dayPL: +a.equity - +a.last_equity,
    dayPLPct: +a.last_equity ? ((+a.equity - +a.last_equity) / +a.last_equity) * 100 : 0,
    totalPL: +a.equity - 100000,
    totalPLPct: ((+a.equity - 100000) / 100000) * 100,
    status: a.status,
    isPaper: true,
  };
}

export async function getPositions() {
  const positions = await alpaca.getPositions();
  return positions.map(p => ({
    symbol: p.symbol,
    qty: +p.qty,
    avgEntry: +p.avg_entry_price,
    current: +p.current_price,
    marketValue: +p.market_value,
    costBasis: +p.cost_basis,
    unrealizedPL: +p.unrealized_pl,
    unrealizedPLPct: +p.unrealized_plpc * 100,
    side: p.side,
  }));
}

export async function getRecentOrders(limit = 25) {
  const orders = await alpaca.getOrders({ status: 'all', limit, direction: 'desc', nested: false });
  return orders.map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty ? +o.qty : null,
    notional: o.notional ? +o.notional : null,
    type: o.type,
    status: o.status,
    filledQty: +o.filled_qty,
    filledAvgPrice: o.filled_avg_price ? +o.filled_avg_price : null,
    submittedAt: o.submitted_at,
  }));
}
