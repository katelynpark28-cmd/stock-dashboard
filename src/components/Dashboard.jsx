import { useState, useEffect } from 'react';
import Section from './Section';
import MetricCard, { fmt, pct, plain } from './MetricCard';
import PriceChart from './PriceChart';
import AIAnalysis from './AIAnalysis';
import NewsSection from './NewsSection';

const INFO = {
  ebitda: {
    what: 'EBITDA stands for Earnings Before Interest, Taxes, Depreciation, and Amortization. It measures how much cash a business generates from its core operations, stripping out financing and accounting decisions. It\'s calculated here as Operating Income + Depreciation & Amortization.',
    up: 'Growing EBITDA means the core business is generating more cash. It\'s one of the most watched metrics by institutional investors and is central to buyout valuations and debt capacity analysis.',
    down: 'Falling EBITDA signals deteriorating operating performance. If EBITDA drops while revenue grows, costs are spiraling. If both fall together, the business itself is shrinking.',
    context: 'EV/EBITDA (Enterprise Value divided by EBITDA) is one of the most common valuation multiples used in M&A. A lower multiple relative to peers can suggest undervaluation; a higher one suggests the market expects strong growth.',
  },
  revenue: {
    what: 'Revenue (also called "top line") is the total money a company earns from selling its products or services before any costs are deducted.',
    up: 'Growing revenue means the company is selling more — either by gaining customers, raising prices, or expanding into new markets. Consistent revenue growth is one of the strongest signals of a healthy business.',
    down: 'Declining revenue suggests the company is losing customers, facing pricing pressure, or operating in a shrinking market. It can signal deeper problems if the trend persists.',
    context: 'Revenue alone doesn\'t tell you if the company is profitable — a company can have huge revenue and still lose money. Always look at it alongside margins.',
  },
  grossProfit: {
    what: 'Gross profit is revenue minus the direct cost of making or delivering the product (Cost of Goods Sold). It shows how much money is left to cover operating expenses after the core business activity.',
    up: 'Rising gross profit means the company is either selling more or becoming more efficient at production. Higher gross profit gives more room to invest in growth, R&D, and marketing.',
    down: 'Falling gross profit can mean rising input costs, increased competition forcing price cuts, or a shift toward lower-margin products.',
    context: 'Gross profit margin (gross profit ÷ revenue) is a better comparison tool across companies than the raw dollar figure.',
  },
  operatingIncome: {
    what: 'Operating income is gross profit minus all operating expenses like salaries, rent, and marketing. It shows how much profit the core business generates before interest and taxes.',
    up: 'Growing operating income means the company is running a more efficient operation — either revenue is growing faster than costs, or management is cutting unnecessary expenses.',
    down: 'Shrinking operating income while revenue grows often means costs are spiraling. If it goes negative (operating loss), the company burns cash just running its operations.',
    context: 'Also called EBIT (Earnings Before Interest and Taxes). It\'s one of the clearest measures of business quality, since it strips out financing decisions and tax strategies.',
  },
  netIncome: {
    what: 'Net income (the "bottom line") is what\'s left after every expense — costs, interest, taxes, and one-time items — is deducted from revenue. It\'s the company\'s official profit.',
    up: 'Rising net income means the company is becoming more profitable. Sustained growth in net income can support dividends, share buybacks, and reinvestment.',
    down: 'Falling net income can stem from higher costs, increased debt interest, a one-time write-off, or a genuinely weakening business. Context matters — check whether it\'s a one-time hit or a trend.',
    context: 'Net income can be manipulated by accounting choices. Savvy investors also check free cash flow to confirm that reported profits translate into real money.',
  },
  grossMargin: {
    what: 'Gross margin is gross profit divided by revenue, expressed as a percentage. It shows how much of each dollar of revenue the company keeps after paying for the direct cost of its products.',
    up: 'Expanding gross margins signal stronger pricing power, cheaper inputs, or a more efficient production process. Companies with margins above 40–60% often have durable competitive advantages.',
    down: 'Compressing margins usually mean rising input costs, more competition, or a shift to lower-value products. A sustained decline is a red flag even if revenue is growing.',
    context: 'Margins vary enormously by industry — a grocery store at 25% is healthy; a software company at 25% is struggling. Always compare to industry peers.',
  },
  operatingMargin: {
    what: 'Operating margin is operating income divided by revenue. It shows what percentage of each revenue dollar becomes operating profit after running the business day-to-day.',
    up: 'Rising operating margins mean the company is scaling efficiently — costs are growing slower than revenue. This is a hallmark of high-quality, durable businesses.',
    down: 'Declining operating margins despite growing revenue are a warning sign: it takes more spending to generate each dollar of revenue. Watch for hiring binges or marketing blowouts without corresponding growth.',
    context: 'A useful measure of management effectiveness. Tracking it over many years reveals whether a company\'s competitive position is strengthening or eroding.',
  },
  netMargin: {
    what: 'Net margin is net income divided by revenue. It\'s the ultimate "how much profit do we actually keep per dollar sold" number after every expense including taxes and interest.',
    up: 'Expanding net margins show the whole business is becoming more profitable — not just the core operations but also how it\'s financed and taxed.',
    down: 'Shrinking net margins can come from any part of the income statement. Dig into whether it\'s one-time costs, rising debt interest, or a structural problem with the core business.',
    context: 'Net margin varies hugely by industry. Retailers often run at 2–5%; software companies can exceed 30%. One-time items like asset sales or write-offs can distort it in any given year.',
  },
  roe: {
    what: 'Return on Equity (ROE) measures how much profit a company generates for every dollar shareholders have invested. It\'s calculated as net income divided by shareholders\' equity.',
    up: 'High or rising ROE means management is deploying shareholder money effectively. ROE above 15–20% is generally considered strong, and sustained high ROE is a hallmark of great businesses.',
    down: 'Falling ROE can mean the business is becoming less efficient, taking on more equity dilution, or reinvesting at lower returns. Very high ROE can also be artificially inflated by heavy debt.',
    context: 'Compare ROE alongside debt levels — a company can boost ROE by borrowing heavily, which inflates returns but also increases risk. Look at debt/equity together.',
  },
  totalAssets: {
    what: 'Total assets is everything the company owns or controls that has monetary value: cash, inventory, equipment, real estate, intellectual property, and more.',
    up: 'Growing assets typically reflect a company investing in its future — buying equipment, acquiring businesses, or building cash reserves. Whether this is good depends on what the assets are and how productively they\'re used.',
    down: 'Shrinking assets can mean the company is selling off pieces of the business, writing down impaired investments, or returning cash to shareholders.',
    context: 'Assets alone aren\'t meaningful — what matters is what those assets earn. Compare alongside return metrics like ROE or ROA (Return on Assets) to see if assets are being used productively.',
  },
  totalDebt: {
    what: 'Total debt is the sum of all money the company has borrowed — short-term loans, long-term bonds, credit facilities, and other interest-bearing obligations.',
    up: 'Rising debt isn\'t automatically bad — companies borrow to fund growth, acquisitions, or buybacks. But rising debt with stagnant revenue or profit is dangerous: it increases the risk of financial distress.',
    down: 'Paying down debt strengthens the balance sheet, reduces interest costs, and lowers financial risk. Companies that consistently reduce debt often have strong free cash flow.',
    context: 'Always look at debt relative to earnings or cash flow (e.g. Debt/EBITDA). A company earning $5B/year can safely carry $15B in debt; a company earning $200M cannot.',
  },
  cash: {
    what: 'Cash and cash equivalents is the most liquid money the company has — actual cash in the bank plus short-term investments that can be converted to cash almost instantly.',
    up: 'Growing cash is a sign of financial health and optionality. Companies with large cash piles can weather downturns, make acquisitions, or return money to shareholders.',
    down: 'Falling cash reserves could mean the company is investing heavily in growth (good), burning through cash due to losses (bad), or returning capital to shareholders (depends on context).',
    context: 'Excess cash on a balance sheet can be unproductive. The best businesses tend to deploy cash at high returns rather than sitting on it. Look at what management does with free cash flow.',
  },
  equity: {
    what: 'Shareholders\' equity (also called book value) is total assets minus total liabilities. It represents the theoretical net worth of the company — what shareholders would receive if everything was liquidated and debts paid.',
    up: 'Growing equity generally means the company is retaining profits and building wealth for shareholders. It\'s the accounting foundation for calculating ROE.',
    down: 'Declining equity can result from net losses, large buybacks (which reduce equity mechanically), or write-downs. Some great companies deliberately run with low or even negative equity due to aggressive buybacks.',
    context: 'Book value is most meaningful for asset-heavy industries like banking or manufacturing. For technology or brand-driven companies, intangible assets like software and goodwill often make book value less representative of true worth.',
  },
  operatingCF: {
    what: 'Operating cash flow is the actual cash generated by running the business — not accounting profit, but real dollars collected from customers minus real dollars paid to suppliers and employees.',
    up: 'Rising operating cash flow is one of the strongest signals of business quality. It confirms that reported profits are real, and provides fuel for growth, debt repayment, and shareholder returns.',
    down: 'Falling operating cash flow while profits stay high is a warning sign — it could mean the company is having trouble collecting from customers, or that accounting tricks are masking cash problems.',
    context: 'Many investors consider operating cash flow more reliable than net income because it\'s much harder to manipulate. Warren Buffett is famous for focusing on cash generation over reported earnings.',
  },
  freeCF: {
    what: 'Free cash flow (FCF) is operating cash flow minus capital expenditures. It\'s the cash the business generates after maintaining and investing in its physical infrastructure — the money truly available to do whatever management wants.',
    up: 'Growing FCF is the gold standard of business health. It funds dividends, buybacks, debt paydown, and acquisitions. High FCF margins are associated with the best long-term stock performers.',
    down: 'Declining FCF can stem from heavy capital spending (building for future growth) or deteriorating operations. Distinguish between the two — a company investing heavily in new factories may have temporarily low FCF but strong future prospects.',
    context: 'FCF yield (FCF ÷ market cap) is a popular valuation tool: a 5%+ yield often signals an undervalued company. Negative FCF for sustained periods without a clear growth narrative is a serious warning sign.',
  },
  capex: {
    what: 'Capital expenditures (CapEx) is money spent on physical assets — factories, equipment, servers, vehicles, and other long-lived infrastructure needed to run or grow the business.',
    up: 'Rising CapEx often means the company is investing in future growth or maintaining aging infrastructure. In capital-intensive industries (manufacturing, telecoms), high CapEx is normal. In software, it\'s unusual.',
    down: 'Falling CapEx can mean the company is under-investing (risky long-term) or has completed a major build-out phase (positive). Asset-light businesses like software companies naturally have low CapEx.',
    context: 'CapEx must be viewed relative to the business model. Airlines and chipmakers need massive ongoing CapEx. A high-margin software company spending 2% of revenue on CapEx is very different from a manufacturer spending 15%.',
  },
  dividends: {
    what: 'Dividends paid is the total cash distributed to shareholders as regular income payments. Not all companies pay dividends — many prefer to reinvest cash into growth instead.',
    up: 'Growing dividends signal management confidence in sustained earnings and cash flow. Consistent dividend growth over many years is a hallmark of financially stable, mature companies.',
    down: 'A cut or elimination of dividends is one of the most serious signals a company can send — it usually means cash flow has deteriorated badly. Investors often sell aggressively on dividend cuts.',
    context: 'Note that this value is often shown as negative in financial data (cash going out). Dividend-paying stocks attract income investors, but a very high yield can be a "yield trap" if the business is struggling.',
  },
  pe: {
    what: 'The Price-to-Earnings (P/E) ratio is the stock price divided by earnings per share. It answers: "How many years of current earnings are you paying for this business?"',
    up: 'A rising P/E means investors are paying more per dollar of earnings — either because expectations for future growth are higher, or because the stock has become more expensive relative to fundamentals.',
    down: 'A falling P/E can mean the stock is becoming cheaper (potential opportunity) or that earnings are growing faster than the stock price (healthy). A very low P/E can also reflect genuine business deterioration.',
    context: 'The S&P 500 historically trades around 15–20x earnings. Growth companies routinely trade at 30–50x or more. A "cheap" P/E in a declining industry may be a value trap. Always consider industry context.',
  },
  pfcf: {
    what: 'The Price-to-Free Cash Flow (P/FCF) ratio compares the stock price to free cash flow per share. Many analysts prefer it to P/E because free cash flow is harder to manipulate than accounting earnings.',
    up: 'A rising P/FCF means investors are paying more per dollar of free cash generated — often justified by high growth expectations, but can also signal overvaluation.',
    down: 'A falling P/FCF can indicate the stock is becoming a better value, or that free cash flow is growing faster than the market is rewarding. Below 15x is often considered attractive for quality businesses.',
    context: 'P/FCF is especially useful for evaluating mature, cash-generative businesses. It\'s less useful for early-stage companies that reinvest all cash into growth and show minimal or negative FCF.',
  },
  evEbitda: {
    what: 'EV/EBITDA compares Enterprise Value (total company value including debt) to EBITDA (earnings before interest, taxes, depreciation, and amortization). It\'s a capital-structure-neutral valuation metric used heavily in M&A.',
    up: 'A rising EV/EBITDA means the company is becoming more expensive relative to its cash generation capacity. This is typical for high-growth companies commanding premium valuations.',
    down: 'A falling EV/EBITDA suggests the stock is getting cheaper, EBITDA is growing, or both. Below 10x is often considered inexpensive for a profitable business.',
    context: 'EV/EBITDA is one of the most widely used metrics in investment banking for comparing companies across industries and capital structures, because it\'s unaffected by how the company is financed.',
  },
  debtEquity: {
    what: 'The Debt-to-Equity ratio compares total debt to shareholders\' equity. It measures how leveraged the company is — how much it relies on borrowed money versus owner capital.',
    up: 'Rising D/E means the company is taking on more debt relative to equity. Moderate leverage can boost returns, but excessive debt increases financial risk, especially in downturns.',
    down: 'Falling D/E means the company is paying off debt, growing equity, or both — generally a sign of improving financial health and lower risk.',
    context: 'Acceptable D/E levels vary by industry. Banks and utilities routinely carry high debt. Technology companies often carry very little. A D/E above 2x warrants scrutiny; above 5x in a cyclical business is concerning.',
  },
};

export default function Dashboard({ data }) {
  const { income, balance, cashflow, incomeQ, balanceQ, cashflowQ, ratios, profile } = data;
  const ticker = profile?.symbol;

  const [liveQuote, setLiveQuote] = useState(null);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (!ticker) return;
    let prevPrice = null;
    const poll = async () => {
      try {
        const r = await fetch(`/api/quote/${ticker}`);
        const q = await r.json();
        if (q.price != null) {
          if (prevPrice !== null && q.price !== prevPrice) {
            setFlash(q.price > prevPrice ? 'flash-up' : 'flash-down');
            setTimeout(() => setFlash(''), 600);
          }
          prevPrice = q.price;
          setLiveQuote(q);
        }
      } catch (_) {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [ticker]);

  const displayPrice = liveQuote?.price ?? profile?.price;
  const displayChange = liveQuote?.change ?? profile?.changes;
  const displayChangePct = liveQuote?.changePct;

  const pick = (arr, key) => arr.map(r => r[key]).filter(v => v !== undefined && v !== null);
  const dates = (arr) => arr.map(r => r.date?.slice(0, 7)).filter(Boolean);

  return (
    <div className="dashboard">
      <div className="company-header">
        {profile?.image && (
          <img src={profile.image} alt={profile.companyName} className="company-logo"
            onError={e => { e.target.style.display = 'none'; }} />
        )}
        <div>
          <h1 className="company-name">{profile?.companyName}</h1>
          <span className="company-meta">{profile?.exchangeShortName} · {profile?.sector} · {profile?.industry}</span>
          <p className="company-desc">{profile?.description?.slice(0, 220)}…</p>
        </div>
        <div className="company-price">
          <div className={`price-value ${flash}`}>${displayPrice?.toFixed(2)}</div>
          <div className={`price-change ${displayChange >= 0 ? 'up' : 'down'}`}>
            {displayChange >= 0 ? '▲' : '▼'} {Math.abs(displayChange ?? 0).toFixed(2)}
            {displayChangePct != null && <span> ({displayChangePct >= 0 ? '+' : ''}{displayChangePct.toFixed(2)}%)</span>}
          </div>
          <div className="mktcap">Mkt Cap: {fmt(profile?.mktCap)}</div>
          <div className="live-dot"><span className="pulse" />LIVE</div>
        </div>
      </div>

      <div className="summary-row">
        <AIAnalysis data={data} />
        <PriceChart ticker={ticker} price={profile?.price} change={profile?.changes} />
      </div>

      <Section title="📈 Revenue & Profit Trends">
        <MetricCard title="Revenue" values={pick(income, 'revenue')} dates={dates(income)} quarterlyValues={pick(incomeQ, 'revenue')} quarterlyDates={dates(incomeQ)} ticker={ticker} description={INFO.revenue} />
        <MetricCard title="Gross Profit" values={pick(income, 'grossProfit')} dates={dates(income)} quarterlyValues={pick(incomeQ, 'grossProfit')} quarterlyDates={dates(incomeQ)} ticker={ticker} description={INFO.grossProfit} />
        <MetricCard title="Operating Income" values={pick(income, 'operatingIncome')} dates={dates(income)} quarterlyValues={pick(incomeQ, 'operatingIncome')} quarterlyDates={dates(incomeQ)} ticker={ticker} description={INFO.operatingIncome} />
        <MetricCard title="Net Income" values={pick(income, 'netIncome')} dates={dates(income)} quarterlyValues={pick(incomeQ, 'netIncome')} quarterlyDates={dates(incomeQ)} ticker={ticker} description={INFO.netIncome} />
        <MetricCard title="EBITDA" values={pick(income, 'ebitda')} dates={dates(income)} quarterlyValues={pick(incomeQ, 'ebitda')} quarterlyDates={dates(incomeQ)} ticker={ticker} description={INFO.ebitda} />
      </Section>

      <Section title="📊 Margin Trends">
        <MetricCard title="Gross Margin" values={pick(ratios, 'grossProfitMargin')} dates={dates(ratios)} formatter={pct} color="#60a5fa" ticker={ticker} description={INFO.grossMargin} />
        <MetricCard title="Operating Margin" values={pick(ratios, 'operatingProfitMargin')} dates={dates(ratios)} formatter={pct} color="#60a5fa" ticker={ticker} description={INFO.operatingMargin} />
        <MetricCard title="Net Margin" values={pick(ratios, 'netProfitMargin')} dates={dates(ratios)} formatter={pct} color="#60a5fa" ticker={ticker} description={INFO.netMargin} />
        <MetricCard title="Return on Equity" values={pick(ratios, 'returnOnEquity')} dates={dates(ratios)} formatter={pct} color="#60a5fa" ticker={ticker} description={INFO.roe} />
      </Section>

      <Section title="🏦 Balance Sheet Health">
        <MetricCard title="Total Assets" values={pick(balance, 'totalAssets')} dates={dates(balance)} quarterlyValues={pick(balanceQ, 'totalAssets')} quarterlyDates={dates(balanceQ)} ticker={ticker} description={INFO.totalAssets} />
        <MetricCard title="Total Debt" values={pick(balance, 'totalDebt')} dates={dates(balance)} quarterlyValues={pick(balanceQ, 'totalDebt')} quarterlyDates={dates(balanceQ)} color="#f87171" ticker={ticker} description={INFO.totalDebt} />
        <MetricCard title="Cash & Equivalents" values={pick(balance, 'cashAndCashEquivalents')} dates={dates(balance)} quarterlyValues={pick(balanceQ, 'cashAndCashEquivalents')} quarterlyDates={dates(balanceQ)} ticker={ticker} description={INFO.cash} />
        <MetricCard title="Shareholders Equity" values={pick(balance, 'totalStockholdersEquity')} dates={dates(balance)} quarterlyValues={pick(balanceQ, 'totalStockholdersEquity')} quarterlyDates={dates(balanceQ)} ticker={ticker} description={INFO.equity} />
      </Section>

      <Section title="💵 Cash Flow">
        <MetricCard title="Operating Cash Flow" values={pick(cashflow, 'operatingCashFlow')} dates={dates(cashflow)} quarterlyValues={pick(cashflowQ, 'operatingCashFlow')} quarterlyDates={dates(cashflowQ)} ticker={ticker} description={INFO.operatingCF} />
        <MetricCard title="Free Cash Flow" values={pick(cashflow, 'freeCashFlow')} dates={dates(cashflow)} quarterlyValues={pick(cashflowQ, 'freeCashFlow')} quarterlyDates={dates(cashflowQ)} ticker={ticker} description={INFO.freeCF} />
        <MetricCard title="Capital Expenditures" values={pick(cashflow, 'capitalExpenditure')} dates={dates(cashflow)} quarterlyValues={pick(cashflowQ, 'capitalExpenditure')} quarterlyDates={dates(cashflowQ)} color="#f87171" ticker={ticker} description={INFO.capex} />
        <MetricCard title="Dividends Paid" values={pick(cashflow, 'dividendsPaid')} dates={dates(cashflow)} quarterlyValues={pick(cashflowQ, 'dividendsPaid')} quarterlyDates={dates(cashflowQ)} color="#a78bfa" ticker={ticker} description={INFO.dividends} />
      </Section>

      <Section title="🔢 Valuation">
        <MetricCard title="P/E Ratio" values={pick(ratios, 'priceEarningsRatio')} dates={dates(ratios)} formatter={plain} color="#facc15" ticker={ticker} description={INFO.pe} />
        <MetricCard title="P/FCF Ratio" values={pick(ratios, 'priceToFreeCashFlowsRatio')} dates={dates(ratios)} formatter={plain} color="#facc15" ticker={ticker} description={INFO.pfcf} />
        <MetricCard title="EV/EBITDA" values={pick(ratios, 'enterpriseValueMultiple')} dates={dates(ratios)} formatter={plain} color="#facc15" ticker={ticker} description={INFO.evEbitda} />
        <MetricCard title="Debt / Equity" values={pick(ratios, 'debtEquityRatio')} dates={dates(ratios)} formatter={plain} color="#facc15" ticker={ticker} description={INFO.debtEquity} />
      </Section>

      <NewsSection ticker={ticker} />
    </div>
  );
}
