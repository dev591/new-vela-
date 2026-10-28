import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface AtlasAnswerCardProps {
  question: string;
  answer: string;
  streamingText?: string;
  onClose: () => void;
}

export default function AtlasAnswerCard({ question, answer, streamingText, onClose }: AtlasAnswerCardProps) {
  const [timeLeft, setTimeLeft] = useState(12);
  const [expanded, setExpanded] = useState(false);

  const isStreaming = !answer && !!streamingText;
  const displayText = answer || streamingText || "";

  // Only start the auto-dismiss timer once streaming is complete (answer is set)
  useEffect(() => {
    if (!answer) return; // Don't count down while still streaming
    if (timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft(prev => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft, answer]);

  // Reset timer when a new answer arrives
  useEffect(() => {
    if (answer) setTimeLeft(12);
  }, [answer]);

  const timestamp = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 10, opacity: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        style={{
          position: 'relative',
          width: 380,
          maxWidth: '100%',
          borderRadius: 24,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'saturate(180%) blur(24px)',
          WebkitBackdropFilter: 'saturate(180%) blur(24px)',
          border: '0.5px solid rgba(0,0,0,0.10)',
          padding: 20,
          boxShadow: '0 12px 40px rgba(0,0,0,0.14)',
          zIndex: 10000
        }}
      >
        {/* Top Row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <motion.div
              animate={isStreaming
                ? { opacity: [1, 0.3, 1], scale: [1, 1.2, 1] }
                : { opacity: [1, 0.4, 1] }
              }
              transition={{ duration: isStreaming ? 0.8 : 2, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: '50%', background: '#0071E3' }}
            />
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: '#0071E3' }}>
              {isStreaming ? 'Atlas is answering' : 'Atlas'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 4, lineHeight: 1 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* Question */}
        <div style={{ marginBottom: 12 }}>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>You asked</p>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.45 }}>“{question}”</p>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'rgba(0,0,0,0.08)', margin: '12px 0' }} />

        {/* Answer / Streaming Text */}
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <p style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 16,
            color: 'var(--text)',
            lineHeight: 1.55,
            display: !expanded ? '-webkit-box' : 'block',
            WebkitLineClamp: !expanded ? 5 : undefined,
            WebkitBoxOrient: !expanded ? 'vertical' : undefined,
            overflow: !expanded ? 'hidden' : 'visible'
          } as React.CSSProperties}>
            {displayText}
            {isStreaming && (
              <motion.span
                animate={{ opacity: [1, 0, 1] }}
                transition={{ duration: 0.6, repeat: Infinity, ease: 'easeInOut' }}
                style={{
                  display: 'inline-block',
                  width: 2,
                  height: 14,
                  background: '#0071E3',
                  marginLeft: 2,
                  verticalAlign: 'text-bottom',
                  borderRadius: 1,
                }}
              />
            )}
          </p>
          {!expanded && displayText.length > 200 && !isStreaming && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              style={{ fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: '#0071E3', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginTop: 4 }}
            >
              Show more
            </button>
          )}
        </div>

        {/* Disclaimer */}
        <div style={{ padding: '8px 12px', background: 'var(--bg)', borderRadius: 10, marginBottom: 12 }}>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>
            AI-generated. Verify with source document.
          </p>
        </div>

        {/* Bottom Row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-tertiary)' }}>{timestamp}</span>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {isStreaming ? 'Generating…' : `Auto-close in ${timeLeft}s`}
          </span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
