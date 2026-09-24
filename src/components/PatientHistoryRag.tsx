import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { API_URL } from '../utils/config';
import toast from 'react-hot-toast';

interface RagCitation {
  document_id: string;
  filename: string;
  report_date: string;
  excerpt: string;
  relevance_score: number;
}

interface TimelineEntry {
  document_id?: string;
  filename: string;
  date: string;
  key_findings: string[];
  risk_level: string;
}

interface PatientHistoryRagProps {
  patientId: string;
}

export default function PatientHistoryRag({ patientId }: PatientHistoryRagProps) {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<RagCitation[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineSummary, setTimelineSummary] = useState('');
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);

  const [progression, setProgression] = useState('');
  const [progressionSpan, setProgressionSpan] = useState('');
  const [progressionDocs, setProgressionDocs] = useState(0);
  const [isProgressing, setIsProgressing] = useState(false);

  useEffect(() => {
    fetchTimeline();
  }, [patientId]);

  const fetchTimeline = async () => {
    setIsLoadingTimeline(true);
    try {
      const res = await fetch(`${API_URL}/api/patient/history/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId })
      });
      if (res.ok) {
        const data = await res.json();
        setTimeline(data.timeline || []);
        setTimelineSummary(data.summary || '');
      }
    } catch (e) {
      console.error('Failed to load timeline:', e);
    } finally {
      setIsLoadingTimeline(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);
    setAnswer('');
    setCitations([]);

    try {
      const res = await fetch(`${API_URL}/api/patient/history/query/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId, query })
      });

      if (!res.ok) throw new Error('Search failed');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullAnswer = '';
      let finalData: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = '';

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
            try {
              const parsed = JSON.parse(currentData);
              if (currentEvent === 'token') {
                fullAnswer += parsed.t;
                setAnswer(fullAnswer);
              } else if (currentEvent === 'done') {
                finalData = parsed;
              } else if (currentEvent === 'error') {
                toast.error(parsed.message);
              }
            } catch (e) {
              buffer = line + '\n';
            }
            currentEvent = '';
            currentData = '';
          } else if (line.trim() === '') {
            currentEvent = '';
            currentData = '';
          } else {
            buffer = line;
          }
        }
      }

      if (finalData) {
        setAnswer(finalData.answer || fullAnswer);
        setCitations(finalData.citations || []);
      }
    } catch (e: any) {
      toast.error('Search failed: ' + e.message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleProgression = async () => {
    setIsProgressing(true);
    setProgression('');
    setProgressionSpan('');
    setProgressionDocs(0);

    try {
      const res = await fetch(`${API_URL}/api/patient/history/progression/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId })
      });

      if (!res.ok) throw new Error('Progression failed');
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullNarrative = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = '';

        let currentEvent = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (currentEvent === 'token') {
                fullNarrative += parsed.t;
                setProgression(fullNarrative);
              } else if (currentEvent === 'done') {
                setProgression(parsed.narrative || fullNarrative);
                setProgressionSpan(parsed.span || '');
                setProgressionDocs(parsed.document_count || 0);
              } else if (currentEvent === 'error') {
                toast.error(parsed.message);
              }
            } catch {
              buffer = line + '\n';
            }
            currentEvent = '';
          } else if (line.trim() === '') {
            currentEvent = '';
          } else {
            buffer = line;
          }
        }
      }
    } catch (e: any) {
      toast.error('Progression failed: ' + e.message);
    } finally {
      setIsProgressing(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 32, alignItems: 'start' }}>
      
      {/* LEFT: Search & Results */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Search Medical History</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 20 }}>
            Ask complex questions across years of uploaded reports. Atlas will cite its sources.
          </p>

          <button
            type="button"
            onClick={handleProgression}
            disabled={isProgressing}
            style={{
              width: '100%', marginBottom: 16, padding: '12px 16px', borderRadius: 8,
              background: 'transparent', border: '1px solid var(--accent)',
              color: 'var(--accent)', fontWeight: 600, fontSize: 14,
              cursor: isProgressing ? 'default' : 'pointer',
              opacity: isProgressing ? 0.7 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
            }}
          >
            {isProgressing ? 'Reviewing full history…' : '✦ Summarize progression over time'}
          </button>

          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 12 }}>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="E.g., Has this patient ever had elevated liver enzymes?"
              style={{
                flex: 1, padding: '14px 16px', borderRadius: 8,
                background: 'var(--background)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', fontSize: 15
              }}
              disabled={isSearching}
            />
            <button
              type="submit"
              disabled={isSearching || !query.trim()}
              style={{
                padding: '0 24px', borderRadius: 8, background: 'var(--accent)',
                color: '#111', fontWeight: 600, border: 'none', cursor: 'pointer',
                opacity: isSearching || !query.trim() ? 0.7 : 1
              }}
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </form>
        </div>

        <AnimatePresence>
          {(progression || isProgressing) && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--accent)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--accent)', textTransform: 'uppercase' }}>
                  {isProgressing ? 'Atlas is reviewing the full history…' : 'Progression Summary'}
                </span>
                {!isProgressing && progressionSpan && (
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {progressionSpan} · {progressionDocs} reports
                  </span>
                )}
              </div>
              <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                {progression}
                {isProgressing && <span style={{ display: 'inline-block', width: 4, height: 14, background: 'var(--accent)', marginLeft: 4, animation: 'blink 1s infinite' }} />}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {(answer || isSearching) && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--border-color)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: isSearching ? 'var(--accent)' : 'var(--text-secondary)' }} />
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {isSearching ? 'Atlas is reviewing records...' : 'Atlas Synthesis'}
                </span>
              </div>
              
              <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                {answer}
                {isSearching && <span style={{ display: 'inline-block', width: 4, height: 14, background: 'var(--accent)', marginLeft: 4, animation: 'blink 1s infinite' }} />}
              </p>

              {citations.length > 0 && (
                <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
                  <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 12, letterSpacing: '0.05em' }}>
                    Source Citations ({citations.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {citations.map((cit, i) => (
                      <div key={i} style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>{cit.filename}</span>
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)' }}>{cit.report_date}</span>
                        </div>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontStyle: 'italic', lineHeight: 1.5 }}>"{cit.excerpt}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* RIGHT: Timeline */}
      <div style={{ background: 'var(--surface)', padding: 24, borderRadius: 16, border: '1px solid var(--border-color)' }}>
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Clinical Timeline</h3>
        
        {isLoadingTimeline ? (
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Building timeline...</p>
        ) : timeline.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No history available. Upload reports to build timeline.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {timelineSummary && (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
                {timelineSummary}
              </p>
            )}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {timeline.map((entry, i) => (
                <div key={i} style={{ position: 'relative', paddingLeft: 16 }}>
                  <div style={{ position: 'absolute', left: 0, top: 6, bottom: i === timeline.length - 1 ? 'auto' : -20, width: 2, background: 'var(--border-color)' }} />
                  <div style={{ position: 'absolute', left: -3, top: 6, width: 8, height: 8, borderRadius: '50%', background: entry.risk_level === 'high' || entry.risk_level === 'critical' ? 'var(--danger)' : 'var(--text-secondary)' }} />
                  
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>{entry.date}</div>
                  <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>{entry.filename}</div>
                  <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-secondary)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {entry.key_findings.map((f, j) => <li key={j}>{f}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
