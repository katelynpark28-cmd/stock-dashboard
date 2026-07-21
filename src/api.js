async function get(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.json();
}

function toDateStr(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

// Merge sparse records that share the same date into one object
function mergeByDate(records) {
  const map = {};
  records.forEach(r => {
    const d = toDateStr(r.date);
    if (!map[d]) map[d] = { date: d };
    Object.assign(map[d], r, { date: d });
  });
  return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
}

export async function fetchAll(ticker) {
  const symbol = ticker.toUpperCase();
  const [profileData, finData] = await Promise.all([
    get(`/api/profile/${symbol}`),
    get(`/api/financials/${symbol}`),
  ]);

  const { financials: fin, balanceSheet: bs, cashFlow: cf } = finData;

  // Annual (type=annual returns periodType 12M, quarterly returns 3M)
  const annualFin   = mergeByDate(fin.filter(r => r.periodType === '12M'));
  const annualBs    = mergeByDate(bs.filter(r => r.periodType === '12M'));
  const annualCf    = mergeByDate(cf.filter(r => r.periodType === '12M'));
  const quarterlyFin = mergeByDate(fin.filter(r => r.periodType === '3M'));
  const quarterlyBs  = mergeByDate(bs.filter(r => r.periodType === '3M'));
  const quarterlyCf  = mergeByDate(cf.filter(r => r.periodType === '3M'));

  const income = annualFin.map(r => ({
    date: r.date,
    revenue: r.totalRevenue,
    grossProfit: r.grossProfit,
    operatingIncome: r.operatingIncome,
    netIncome: r.netIncome,
  })).filter(r => r.revenue);

  const balance = annualBs.map(r => ({
    date: r.date,
    totalAssets: r.totalAssets,
    totalDebt: r.totalDebt,
    cashAndCashEquivalents: r.cashAndCashEquivalents,
    totalStockholdersEquity: r.stockholdersEquity ?? r.commonStockEquity,
  })).filter(r => r.totalAssets);

  const cashflow = annualCf.map(r => ({
    date: r.date,
    operatingCashFlow: r.operatingCashFlow,
    freeCashFlow: r.freeCashFlow,
    capitalExpenditure: r.capitalExpenditure,
    dividendsPaid: r.dividendsPaid,
    depreciationAndAmortization: r.depreciationAndAmortization ?? r.depreciation,
  })).filter(r => r.operatingCashFlow ?? r.freeCashFlow);

  // Merge D&A into income rows to compute EBITDA = operatingIncome + D&A
  const cfByDate = Object.fromEntries(cashflow.map(r => [r.date, r]));
  income.forEach(r => {
    const da = cfByDate[r.date]?.depreciationAndAmortization;
    r.ebitda = (r.operatingIncome != null && da != null) ? r.operatingIncome + da : null;
  });

  const incomeQ = quarterlyFin.map(r => ({
    date: r.date,
    revenue: r.totalRevenue,
    grossProfit: r.grossProfit,
    operatingIncome: r.operatingIncome,
    netIncome: r.netIncome,
  })).filter(r => r.revenue);

  const balanceQ = quarterlyBs.map(r => ({
    date: r.date,
    totalAssets: r.totalAssets,
    totalDebt: r.totalDebt,
    cashAndCashEquivalents: r.cashAndCashEquivalents,
    totalStockholdersEquity: r.stockholdersEquity ?? r.commonStockEquity,
  })).filter(r => r.totalAssets);

  const cashflowQ = quarterlyCf.map(r => ({
    date: r.date,
    operatingCashFlow: r.operatingCashFlow,
    freeCashFlow: r.freeCashFlow,
    capitalExpenditure: r.capitalExpenditure,
    dividendsPaid: r.dividendsPaid,
    depreciationAndAmortization: r.depreciationAndAmortization ?? r.depreciation,
  })).filter(r => r.operatingCashFlow ?? r.freeCashFlow);

  const cfQByDate = Object.fromEntries(cashflowQ.map(r => [r.date, r]));
  incomeQ.forEach(r => {
    const da = cfQByDate[r.date]?.depreciationAndAmortization;
    r.ebitda = (r.operatingIncome != null && da != null) ? r.operatingIncome + da : null;
  });

  const fd = profileData.financialData || {};
  const ks = profileData.keyStats || {};
  const ratios = [{
    date: new Date().toISOString().slice(0, 10),
    grossProfitMargin: fd.grossMargins,
    operatingProfitMargin: fd.operatingMargins,
    netProfitMargin: fd.profitMargins,
    returnOnEquity: fd.returnOnEquity,
    debtEquityRatio: ks.debtToEquity ? ks.debtToEquity / 100 : null,
    priceEarningsRatio: ks.trailingPE,
    priceToFreeCashFlowsRatio: ks.priceToFreeCashflows,
    enterpriseValueMultiple: ks.enterpriseToEbitda,
  }];

  const q = profileData.quote || {};
  const ap = profileData.assetProfile || {};
  const profile = {
    symbol: q.symbol,
    companyName: q.longName || q.shortName,
    price: q.regularMarketPrice,
    changes: q.regularMarketChange,
    mktCap: q.marketCap,
    exchangeShortName: q.exchange,
    sector: ap.sector,
    industry: ap.industry,
    description: ap.longBusinessSummary,
    image: ap.website
      ? `https://logo.clearbit.com/${ap.website.replace(/https?:\/\/(www\.)?/, '').split('/')[0]}`
      : null,
  };

  return { income, balance, cashflow, incomeQ, balanceQ, cashflowQ, ratios, profile };
}

export async function fetchScreener(mode) {
  return get(`/api/screener?mode=${mode}`);
}

export async function fetchMarketOverview(symbols) {
  const query = symbols ? `?symbols=${symbols.join(',')}` : '';
  const data = await get(`/api/market-overview${query}`);
  return data.map(({ symbol, quote, history }) => {
    const quotes = (history.quotes || []).filter(q => {
      const price = q.close ?? q.adjclose;
      return price != null && price > 0;
    });
    // Default to the full 1-year daily series
    const chartData = quotes.map(q => ({
      value: parseFloat((q.close ?? q.adjclose).toFixed(2)),
    }));
    return {
      symbol,
      name: quote.longName || quote.shortName || symbol,
      price: quote.regularMarketPrice,
      change: quote.regularMarketChange,
      changePct: quote.regularMarketChangePercent,
      mktCap: quote.marketCap,
      chartData,
    };
  });
}

export async function fetchPriceHistory(ticker, period) {
  const intervalMap = { '1D': '5m', '1W': '1h', '1M': '1d', 'YTD': '1d', '1Y': '1wk', '5Y': '1mo', 'ALL': '1mo' };
  const periodMap   = { '1D': '1d', '1W': '1w',  '1M': '1mo','YTD': 'ytd','1Y': '1y',  '5Y': '5y',  'ALL': 'all'  };
  const data = await get(`/api/history/${ticker.toUpperCase()}?period=${periodMap[period] || '5y'}&interval=${intervalMap[period] || '1mo'}`);
  const showYear = period === '5Y' || period === 'ALL';
  return (data.quotes || []).map(q => {
    const price = q.close ?? q.adjclose;
    const d = new Date(q.date);
    let date;
    if (period === '1D') {
      date = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } else if (period === '1W') {
      date = d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric' });
    } else {
      date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(showYear ? { year: '2-digit' } : {}) });
    }
    return {
      date,
      value: price != null ? parseFloat(price.toFixed(2)) : null,
    };
  }).filter(q => q.value != null && !isNaN(q.value) && q.value > 0);
}
