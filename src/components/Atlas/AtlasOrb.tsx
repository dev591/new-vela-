import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AtlasState } from './AtlasCore';

interface AtlasOrbProps {
  state: AtlasState
  onStop: () => void
}

/**
 * Atlas orb — the one persistent piece of the product that is always on screen,
 * so it carries a disproportionate amount of the app's character.
 *
 * Built as four stacked layers rather than a single animated circle:
 *   1. ripples  — expanding rings that read as "hearing you"
 *   2. halo     — soft coloured bloom that intensifies with activity
 *   3. ring     — rotating conic sweep, the "thinking" indicator
 *   4. core     — the sphere itself, with a specular highlight so it reads
 *                 as a physical object lit from above-left rather than a flat dot
 *
 * Previously the whole thing was keyed to a gold (#C8B89A) that predates the
 * blue rebrand, which is why it looked disconnected from the rest of the UI.
 */

const BRAND = '#0071E3';
const BRAND_LIGHT = '#2997FF';
const BLUE_CORE = 'radial-gradient(circle at 32% 26%, #6BB8FF, #0071E3 58%, #0058B0)';
const IDLE_CORE = 'linear-gradient(180deg, #FFFFFF, #F2F2F7)';

type OrbConfig = {
  core: string;
  ring: string;
  halo: string;
  haloScale: number;
  ripples: boolean;
  label: string;
};

export default function AtlasOrb({ state, onStop }: AtlasOrbProps) {
  const [isHovered, setIsHovered] = useState(false);

  const getConfig = (): OrbConfig => {
    switch (state) {
      case 'waking':
      case 'listening':
        return {
          core: BLUE_CORE,
          ring: BRAND_LIGHT,
          halo: `radial-gradient(circle, rgba(41,151,255,0.35), transparent 68%)`,
          haloScale: 2.1,
          ripples: true,
          label: 'Listening',
        };
      case 'processing':
        return {
          core: BLUE_CORE,
          ring: BRAND,
          halo: `radial-gradient(circle, rgba(0,113,227,0.22), transparent 70%)`,
          haloScale: 1.7,
          ripples: false,
          label: 'Thinking',
        };
      case 'streaming':
      case 'speaking':
        return {
          core: BLUE_CORE,
          ring: BRAND_LIGHT,
          halo: `radial-gradient(circle, rgba(41,151,255,0.28), transparent 68%)`,
          haloScale: 1.9,
          ripples: false,
          label: 'Speaking',
        };
      case 'error':
        return {
          core: 'radial-gradient(circle at 32% 26%, #FF8A84, #D70015 62%, #A80010)',
          ring: '#D70015',
          halo: `radial-gradient(circle, rgba(220,75,84,0.25), transparent 70%)`,
          haloScale: 1.6,
          ripples: false,
          label: 'Error',
        };
      default: // sleeping
        return {
          core: IDLE_CORE,
          ring: 'rgba(0,0,0,0.10)',
          halo: `radial-gradient(circle, rgba(0,113,227,0.10), transparent 70%)`,
          haloScale: 1.4,
          ripples: false,
          label: 'Ask Atlas',
        };
    }
  };

  const cfg = getConfig();
  const active = state !== 'sleeping';

  return (
    <div
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onStop}
    >
      {/* Tooltip / status */}
      <AnimatePresence>
        {(isHovered || active) && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.22 }}
            style={{
              position: 'absolute', top: -40, whiteSpace: 'nowrap',
              padding: '6px 12px', borderRadius: 999,
              color: '#fff', fontSize: 13, fontWeight: 500,
              fontFamily: 'var(--font-sans)',
              background: 'rgba(14,18,24,0.92)',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
              pointerEvents: 'none',
            }}
          >
            {cfg.label}
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ position: 'relative', width: 60, height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {/* 1 — ripples: only while actually hearing the room */}
        <AnimatePresence>
          {cfg.ripples && [0, 1].map((i) => (
            <motion.div
              key={i}
              initial={{ scale: 0.6, opacity: 0.5 }}
              animate={{ scale: 2.2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 2.2, repeat: Infinity, delay: i * 1.1, ease: 'easeOut' }}
              style={{
                position: 'absolute', width: 44, height: 44, borderRadius: '50%',
                border: `1px solid ${BRAND_LIGHT}`,
              }}
            />
          ))}
        </AnimatePresence>

        {/* 2 — halo bloom */}
        <motion.div
          animate={{
            scale: active ? [cfg.haloScale * 0.92, cfg.haloScale, cfg.haloScale * 0.92] : [1.3, 1.45, 1.3],
            opacity: active ? [0.75, 1, 0.75] : [0.5, 0.7, 0.5],
          }}
          transition={{ duration: active ? 2 : 5, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute', width: 52, height: 52, borderRadius: '50%',
            background: cfg.halo, filter: 'blur(4px)', pointerEvents: 'none',
          }}
        />

        {/* 3 — conic sweep: the thinking indicator */}
        {state === 'processing' && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
            style={{
              position: 'absolute', width: 54, height: 54, borderRadius: '50%',
              background: `conic-gradient(from 0deg, transparent 0deg, ${BRAND} 300deg, transparent 360deg)`,
              WebkitMask: 'radial-gradient(circle, transparent 60%, #000 62%)',
              mask: 'radial-gradient(circle, transparent 60%, #000 62%)',
            }}
          />
        )}

        {/* 4 — core sphere */}
        <motion.div
          animate={
            state === 'error'
              ? { x: [0, -3, 3, -2, 0] }
              : state === 'speaking'
              ? { scale: [1, 1.06, 1] }
              : active
              ? { scale: [1, 1.03, 1] }
              : { scale: [1, 1.015, 1] }
          }
          transition={{
            duration: state === 'error' ? 0.4 : state === 'speaking' ? 0.5 : active ? 1.6 : 5,
            repeat: state === 'error' ? 0 : Infinity,
            ease: 'easeInOut',
          }}
          whileHover={{ scale: 1.08 }}
          style={{
            position: 'relative',
            width: 44, height: 44, borderRadius: '50%',
            background: cfg.core,
            border: `1px solid ${cfg.ring}`,
            boxShadow: active
              ? `0 6px 20px rgba(0,113,227,0.35), inset 0 1px 1px rgba(255,255,255,0.35)`
              : `0 2px 10px rgba(0,0,0,0.10), inset 0 1px 1px rgba(255,255,255,0.9)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {/* specular highlight — sells it as a sphere, not a circle */}
          <div style={{
            position: 'absolute', top: 5, left: 10, width: 14, height: 9,
            borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
            filter: 'blur(4px)', pointerEvents: 'none',
          }} />

          {/* Inner indicator */}
          {state === 'listening' || state === 'waking' ? (
            <motion.div
              animate={{ scale: [1, 1.35, 1], opacity: [0.85, 1, 0.85] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
              style={{ width: 9, height: 9, borderRadius: '50%', background: '#fff',
                       boxShadow: '0 0 10px rgba(255,255,255,0.9)' }}
            />
          ) : state === 'speaking' || state === 'streaming' ? (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center', height: 18 }}>
              {[0, 1, 2, 3].map((i) => (
                <motion.div
                  key={i}
                  animate={{ height: [5, 16, 8, 14, 5] }}
                  transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }}
                  style={{ width: 2.5, borderRadius: 2, background: '#fff' }}
                />
              ))}
            </div>
          ) : state === 'processing' ? (
            <motion.div
              animate={{ opacity: [0.35, 1, 0.35] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }}
            />
          ) : (
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
                 stroke={state === 'error' ? '#fff' : BRAND}
                 strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          )}
        </motion.div>
      </div>
    </div>
  );
}
