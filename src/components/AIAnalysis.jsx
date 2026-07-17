import { useState, useEffect } from 'react';

async function fetchAnalysis(data) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.json();
}

export default function AIAnalysis({ data }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data?.profile?.symbol) return;
    setResult(null);
    setError('');
    setLoading(true);
    fetchAnalysis({
      profile: data.profile,
      income: data.income,
      balance: data.balance,
      cashflow: data.cashflow,
      ratios: data.ratios,
    })
      .then(setResult)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [data?.profile?.symbol]);

  return (
    <div className="ai-panel">
      <div className="ai-title-row">
        <span className="ai-icon">✦</span>
        <span className="ai-label">AI Summary</span>
        <span className="ai-badge">Groq · Llama 3.3</span>
      </div>

      {loading && (
        <div className="ai-loading">
          <div className="ai-dots"><span /><span /><span /></div>
          <p>Analyzing…</p>
        </div>
      )}
      {error && <div className="ai-error-inline">⚠️ {error}</div>}

      {result && (
        <div className="ai-result">
          <p className="ai-summary-text">{result.summary}</p>

          <div className="ai-sections">
            {result.strengths?.length > 0 && (
              <div className="ai-section">
                <div className="ai-section-title up">Strengths</div>
                <ul className="ai-list">
                  {result.strengths.map((s, i) => <li key={i} className="ai-list-item up-item">{s}</li>)}
                </ul>
              </div>
            )}
            {result.concerns?.length > 0 && (
              <div className="ai-section">
                <div className="ai-section-title down">Concerns</div>
                <ul className="ai-list">
                  {result.concerns.map((c, i) => <li key={i} className="ai-list-item down-item">{c}</li>)}
                </ul>
              </div>
            )}
          </div>

          {result.verdict && (
            <div className="ai-verdict">
              <span className="ai-verdict-label">Verdict</span>
              <span className="ai-verdict-text">{result.verdict}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
