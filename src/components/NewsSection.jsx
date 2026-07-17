import { useState, useEffect } from 'react';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function NewsSection({ ticker }) {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    setError('');
    fetch(`/api/news/${ticker}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setArticles(data);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [ticker]);

  return (
    <div className="news-section">
      <h2 className="section-title">📰 Latest News</h2>
      {loading && <div className="news-loading">Loading news…</div>}
      {error && <div className="news-error">Could not load news.</div>}
      {!loading && !error && (
        <div className="news-grid">
          {articles.map((a, i) => (
            <a key={i} href={a.link} target="_blank" rel="noopener noreferrer" className="news-card">
              {a.thumbnail && (
                <div className="news-thumb">
                  <img src={a.thumbnail} alt="" onError={e => { e.target.parentElement.style.display = 'none'; }} />
                </div>
              )}
              <div className="news-body">
                <div className="news-title">{a.title}</div>
                <div className="news-meta">
                  <span className="news-publisher">{a.publisher}</span>
                  <span className="news-time">{timeAgo(a.publishedAt)}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
