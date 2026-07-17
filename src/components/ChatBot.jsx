import { useState, useRef, useEffect } from 'react';

export default function ChatBot({ currentStock }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [open, messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg = { role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, stock: currentStock }),
      });
      const { reply } = await r.json();
      setMessages(m => [...m, { role: 'assistant', content: reply }]);
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Something went wrong. Try again.' }]);
    }
    setLoading(false);
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const placeholder = currentStock
    ? `Ask anything about ${currentStock}…`
    : 'Ask me about any stock…';

  return (
    <div className="chatbot-container">
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-header">
            <span>💬 StocKP Assistant</span>
            {currentStock && <span className="chatbot-stock-badge">{currentStock}</span>}
            <button className="chatbot-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="chatbot-messages">
            {messages.length === 0 && (
              <div className="chatbot-empty">
                {currentStock
                  ? `Ask me anything about ${currentStock} — financials, valuation, outlook, comparisons.`
                  : 'Search a stock above, or ask me anything about investing.'}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chatbot-msg ${m.role}`}>
                <div className="chatbot-bubble">{m.content}</div>
              </div>
            ))}
            {loading && (
              <div className="chatbot-msg assistant">
                <div className="chatbot-bubble chatbot-typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="chatbot-input-row">
            <textarea
              ref={inputRef}
              className="chatbot-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={placeholder}
              rows={1}
            />
            <button className="chatbot-send" onClick={send} disabled={loading || !input.trim()}>
              ➤
            </button>
          </div>
        </div>
      )}
      <button className="chatbot-fab" onClick={() => setOpen(o => !o)}>
        {open ? '✕' : '💬'}
      </button>
    </div>
  );
}
