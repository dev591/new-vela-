// A small floating guide shown on every signed-in demo screen: which step of the judge's path
// this is, what to press here, and what to do next (with the next account's login ready to copy).
// Hidden outside demo mode and on pages that are not part of the path.
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowRight, Check, ChevronDown, Copy, Mic } from 'lucide-react'
import { DEMO_ACCOUNTS, DEMO_MODE, DEMO_STEPS, demoStepForRole, type DemoRole } from '../utils/demo'
import { logout } from '../utils/auth'

// Which screen belongs to which step.
const ROUTE_ROLE: Record<string, DemoRole> = {
  '/patient-dashboard': 'patient', '/portal': 'patient',
  '/receptionist': 'receptionist',
  '/dashboard': 'doctor', '/patients': 'doctor', '/virtual-consult': 'doctor',
}

const KEY = 'vela_demo_guide_collapsed'
// Remembered choice wins; otherwise start collapsed on narrow windows so it never covers the page's content.
const read = () => {
  try { const v = localStorage.getItem(KEY); if (v !== null) return v === '1' } catch { /* private mode */ }
  return typeof window !== 'undefined' && window.innerWidth < 1100
}

function CopyChip({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" aria-label={`Copy ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); window.setTimeout(() => setDone(false), 1400) }}
      className="inline-flex items-center gap-1.5 rounded-full bg-white/10 hover:bg-white/20 px-2.5 py-1 text-[12px] text-white/90">
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? 'Copied' : label}
    </button>
  )
}

export default function DemoJourney() {
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(read)
  const role = ROUTE_ROLE[pathname] ?? ROUTE_ROLE['/' + pathname.split('/')[1]]
  if (!DEMO_MODE || !role) return null

  const step = demoStepForRole(role)
  const next = DEMO_STEPS.find(s => s.n === step.n + 1)
  const nextAccount = next ? DEMO_ACCOUNTS[next.role] : null
  const toggle = () => setCollapsed(c => { try { localStorage.setItem(KEY, c ? '0' : '1') } catch { /* private mode */ } return !c })

  return (
    <aside aria-label="Demo guide"
      // Bottom right, above the Atlas orb (which sits at 24px), so it never covers the left navigation.
      className="fixed right-3 bottom-[104px] z-[90] w-[min(340px,calc(100vw-24px))] rounded-2xl bg-[#1D1D1F] text-white shadow-2xl border border-white/10">
      <button type="button" onClick={toggle} aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <span className="grid place-items-center w-7 h-7 rounded-full bg-[#0071E3] text-[13px] font-semibold">{step.n}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] uppercase tracking-wider text-white/50">Demo guide · step {step.n} of {DEMO_STEPS.length}</span>
          <span className="block text-[15px] font-semibold truncate">You are the {step.who.toLowerCase()}: {step.name}</span>
        </span>
        <ChevronDown size={18} className={`text-white/60 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 -mt-1">
          <ol className="space-y-2 text-[14px] leading-snug text-white/85">
            {step.todo.map((t, i) => (
              <li key={t} className="flex gap-2.5"><span className="text-[#2997FF] font-semibold">{i + 1}.</span><span>{t}</span></li>
            ))}
          </ol>

          <a href="/data-sources" target="_blank" rel="noreferrer" className="mt-3 inline-block text-[13px] text-[#2997FF] underline">Where does this data come from? Download the sample files</a>

          {next && nextAccount ? (
            <div className="mt-4 rounded-xl bg-white/[0.06] p-3">
              <div className="text-[12px] text-white/60 mb-2">Then: sign out and sign in as {next.who.toLowerCase()} ({next.name}).</div>
              <div className="flex flex-wrap gap-2 mb-3">
                <CopyChip label="Copy email" value={nextAccount.email} />
                {nextAccount.password && <CopyChip label="Copy password" value={nextAccount.password} />}
              </div>
              <button type="button" onClick={() => logout(`/login?as=${next.role}`)}
                className="w-full h-10 rounded-full bg-[#0071E3] hover:bg-[#0058B0] text-[14px] font-semibold inline-flex items-center justify-center gap-2">
                Sign out, go to {next.who} <ArrowRight size={16} />
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-xl bg-white/[0.06] p-3 text-[13px] text-white/80 flex gap-2">
              <Mic size={16} className="shrink-0 mt-0.5 text-[#2997FF]" />
              <span>That completes the path. Also try the public voice front desk at <a className="underline" href="/frontdesk">/frontdesk</a>: speak Hindi, Hinglish or English.</span>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
