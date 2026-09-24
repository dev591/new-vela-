import { API_URL, POLL_INTERVALS } from "../utils/config";
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getUser, logout } from '../utils/auth'
import { LayoutGrid, Users, AlertTriangle, UserPlus, FileText, LogOut, ChevronLeft, ChevronRight } from 'lucide-react'

type NavItem = { 
  label: string; 
  path: string; 
  icon: React.ElementType; 
  hasBadge?: boolean;
  count?: number;
}

export default function DoctorSidebar({ onExpandChange }: { onExpandChange: (expanded: boolean) => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(() => localStorage.getItem('vela_sidebar') === 'true')
  const [emergencyCount, setEmergencyCount] = useState(0)

  useEffect(() => {
    onExpandChange(expanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const fetchEmergency = async () => {
      try {
        const res = await fetch(`${API_URL}/api/patients/emergency`)
        const data = await res.json()
        if (res.ok && data.status === 'success') {
          setEmergencyCount(Array.isArray(data.patients) ? data.patients.length : 0)
        }
      } catch {
        setEmergencyCount(0)
      }
    }

    fetchEmergency()
    const timer = setInterval(fetchEmergency, POLL_INTERVALS.emergency)
    return () => clearInterval(timer)
  }, [])

  const user = getUser()

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    localStorage.setItem('vela_sidebar', next.toString())
    onExpandChange(next)
  }

  const navItems: NavItem[] = [
    { label: 'Overview', path: '/dashboard', icon: LayoutGrid },
    { label: 'Patients', path: '/patients', icon: Users },
    { label: 'Emergency', path: '/emergency', icon: AlertTriangle, hasBadge: true, count: emergencyCount },
    { label: 'Add Patient', path: '/patients/add', icon: UserPlus },
    { label: 'Handover', path: '/handover', icon: FileText }
  ]

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  return (
    <aside 
      className="fixed left-0 top-0 h-screen z-50 flex flex-col transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
      style={{
        width: expanded ? 260 : 72,
        backgroundColor: 'rgba(255,255,255,0.82)',
        backdropFilter: 'saturate(180%) blur(24px)',
        WebkitBackdropFilter: 'saturate(180%) blur(24px)',
        borderRight: '0.5px solid rgba(0,0,0,0.10)'
      }}
    >
      {/* Brand */}
      <div className="h-20 flex items-center justify-center relative border-b border-black/[0.08]">
        <div className={`transition-all duration-300 absolute flex items-center gap-2 ${expanded ? 'left-6 opacity-100' : 'opacity-0 scale-90'}`}>
          <img src="/vela-icon.png" alt="Vela" style={{ height: 36, width: "auto", objectFit: "contain" }} />
          <span className="text-xs font-semibold text-ink-2">MD</span>
        </div>
        <div className={`transition-all duration-300 absolute overflow-hidden ${!expanded ? 'opacity-100 scale-100' : 'opacity-0 scale-90'}`}>
          <div className="w-8 h-8 flex items-center justify-center">
            <img src="/vela-icon.png" alt="Vela" style={{ height: 32, width: "auto", objectFit: "contain" }} />
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-8 px-3 space-y-1">
        {navItems.map((item) => {
          const active = location.pathname === item.path
          return (
            <button
              type="button"
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`w-full group relative flex items-center h-11 px-3 rounded-lg transition-all duration-200 ${
                active 
                  ? 'bg-brand-tint text-brand' 
                  : 'text-ink-2 hover:text-ink hover:bg-black/[0.05]'
              }`}
            >
              <item.icon 
                size={20} 
                strokeWidth={1.5}
                className={`flex-shrink-0 transition-colors duration-200 ${active ? 'text-brand' : 'text-current'}`} 
              />
              
              <span 
                className={`ml-3 font-sans text-[15px] font-medium whitespace-nowrap overflow-hidden transition-all duration-300 ${
                  expanded ? 'opacity-100 translate-x-0 w-auto' : 'opacity-0 -translate-x-2 w-0'
                }`}
              >
                {item.label}
              </span>

              {item.hasBadge && item.count !== undefined && item.count > 0 && (
                <span 
                  className={`absolute right-2 flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-mono font-bold transition-all duration-300 ${
                    active ? 'bg-brand text-white' : 'bg-danger text-white'
                  } ${expanded ? 'opacity-100 scale-100' : 'opacity-100 scale-100 top-0 right-0 -mr-1 -mt-1 h-4 min-w-[16px]'}`}
                >
                  {item.count}
                </span>
              )}
              
              {!expanded && active && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-brand rounded-r-full" />
              )}
            </button>
          )
        })}
      </nav>

      {/* User Section */}
      <div className="p-4 border-t border-black/[0.08]">
        <div className={`flex items-center gap-3 overflow-hidden transition-all duration-300 ${expanded ? 'opacity-100' : 'flex-col gap-4'}`}>
          <div className="w-9 h-9 rounded-full bg-brand text-white flex items-center justify-center font-semibold shrink-0">
             {user?.name?.[0] || 'D'}
          </div>
          
          <div className={`flex flex-col min-w-0 transition-all duration-300 ${expanded ? 'opacity-100 w-full' : 'opacity-0 w-0 hidden'}`}>
            <span className="font-sans text-sm text-ink font-medium truncate">{user?.name || 'Doctor'}</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
              <span className="text-xs text-ink-2">Online</span>
            </div>
          </div>

          <button 
            type="button"
            onClick={handleLogout}
            className={`flex items-center justify-center rounded-md text-ink-2 hover:text-danger transition-colors ${expanded ? 'ml-auto p-2' : ''}`}
          >
            <LogOut size={18} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Collapse Toggle */}
      <button
        type="button"
        onClick={toggle}
        className="absolute -right-3 top-24 w-6 h-6 bg-white border border-black/10 rounded-full flex items-center justify-center text-ink-2 hover:text-ink transition-colors cursor-pointer z-50 shadow-md"
      >
        {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>
    </aside>
  )
}
