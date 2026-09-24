import { API_URL } from "../utils/config";
import { useEffect, useState, useRef } from 'react'
import DoctorSidebar from '../components/DoctorSidebar'
import toast from 'react-hot-toast'
import { FileText, Printer, Copy, Check, AlertTriangle, ArrowRight } from 'lucide-react'
import gsap from 'gsap'

type Patient = {
  id: string
  name: string
  risk_score: number
  ward: string
  condition?: string
  last_updated?: string
}

export default function Handover() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [patients, setPatients] = useState<Patient[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [report, setReport] = useState('')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    const fetchPatients = async () => {
      setLoading(true)
      try {
        const hospitalId = localStorage.getItem("vela_hospital_id")
        const url = hospitalId
          ? `${API_URL}/api/patients/list?hospital_id=${hospitalId}`
          : `${API_URL}/api/patients/list`
        const res = await fetch(url)
        const data = await res.json()
        if (res.ok && data.status === 'success') {
          setPatients(data.patients || [])
        } else {
          throw new Error(data.message || 'Could not load patients')
        }
      } catch (err) {
        setPatients([])
        toast.error('Could not load patients — is the backend running?')
      } finally {
        setLoading(false)
      }
    }
    fetchPatients()
  }, [])

  useEffect(() => {
    if (patients.length > 0 && listRef.current) {
        gsap.fromTo(listRef.current.children, 
            { opacity: 0, y: 10 },
            { opacity: 1, y: 0, stagger: 0.05, duration: 0.4, ease: 'power2.out' }
        )
    }
  }, [patients])

  const toggle = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleAll = () => {
    const allSelected = patients.every(p => selected[p.id])
    const newSelected: Record<string, boolean> = {}
    patients.forEach(p => {
        newSelected[p.id] = !allSelected
    })
    setSelected(newSelected)
  }

  const selectedIds = Object.keys(selected).filter((id) => selected[id])

  const generate = async () => {
    if (!selectedIds.length) return
    setGenerating(true)

    try {
      const res = await fetch(`${API_URL}/api/handover/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_ids: selectedIds })
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setReport(data.report || '')
        toast.success('Handover report generated')
      } else {
        // Never fabricate clinical content — a handover with invented vitals
        // is worse than no handover.
        throw new Error(data.message || 'Report generation failed')
      }
    } catch (error: any) {
      toast.error(error.message || 'Could not generate handover — check that the backend is running')
    } finally {
      setGenerating(false)
    }
  }

  const copy = async () => {
    await navigator.clipboard.writeText(report)
    toast.success('Copied to clipboard')
  }

  const handlePrint = () => {
      const printWindow = window.open('', '_blank')
      if (printWindow) {
          printWindow.document.write(`<pre style="font-family: monospace; white-space: pre-wrap;">${report}</pre>`)
          printWindow.document.close()
          printWindow.print()
      }
  }

  return (
    <div className="min-h-screen bg-[var(--bg-color)] text-[var(--text-primary)] font-sans selection:bg-[var(--accent-color)] selection:text-ink">
        
        <DoctorSidebar onExpandChange={setSidebarExpanded} />
        
        <main
            style={{
                marginLeft: sidebarExpanded ? '240px' : '64px',
                transition: 'margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            className="p-8 min-h-screen"
        >
            <div className="max-w-6xl mx-auto space-y-8">
                {/* Header */}
                <div className="flex items-end justify-between border-b border-[var(--border-color)] pb-6">
                    <div>
                        <h1 className="font-serif text-4xl mb-2">Shift Handover</h1>
                        <p className="font-mono text-sm text-[var(--text-secondary)] uppercase tracking-wider flex items-center gap-2">
                            <FileText size={14} />
                            Active Shift &middot; {new Date().toLocaleDateString()}
                        </p>
                    </div>
                    {report && (
                         <div className="flex gap-3">
                            <button onClick={copy} className="flex items-center gap-2 px-4 py-2 border border-[var(--border-color)] text-[var(--text-primary)] font-mono text-xs hover:bg-[var(--surface-hover)] transition-colors uppercase">
                                <Copy size={14} /> Copy
                            </button>
                            <button onClick={handlePrint} className="flex items-center gap-2 px-4 py-2 border border-[var(--border-color)] text-[var(--text-primary)] font-mono text-xs hover:bg-[var(--surface-hover)] transition-colors uppercase">
                                <Printer size={14} /> Print
                            </button>
                         </div>
                    )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-[calc(100vh-200px)]">
                    
                    {/* Patient Selection Column */}
                    <div className="lg:col-span-5 flex flex-col h-full border border-[var(--border-color)] bg-[var(--surface-color)]">
                        <div className="p-4 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-color)] sticky top-0 z-10">
                            <div className="flex items-center gap-3">
                                <h2 className="font-mono text-sm uppercase tracking-wider text-[var(--text-secondary)]">Select Patients</h2>
                                <span className="bg-[var(--border-color)] text-[var(--text-primary)] text-xs font-mono px-2 py-0.5 rounded-full">
                                    {selectedIds.length} / {patients.length}
                                </span>
                            </div>
                            <button 
                                onClick={toggleAll}
                                className="text-xs font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                            >
                                {patients.every(p => selected[p.id]) ? 'Deselect All' : 'Select All'}
                            </button>
                        </div>
                        
                        <div className="overflow-y-auto flex-1 p-2 space-y-1" ref={listRef}>
                            {loading ? (
                                <div className="p-8 text-center font-mono text-sm text-[var(--text-secondary)]">Loading patient list...</div>
                            ) : (
                                patients.map((patient) => {
                                    const isSelected = !!selected[patient.id]
                                    const isCritical = patient.risk_score > 70
                                    
                                    return (
                                        <div 
                                            key={patient.id}
                                            onClick={() => toggle(patient.id)}
                                            className={`
                                                group relative flex items-center justify-between p-3 cursor-pointer border transition-all duration-200
                                                ${isSelected 
                                                    ? 'bg-[var(--bg-color)] border-[var(--text-primary)] shadow-sm' 
                                                    : 'bg-transparent border-transparent hover:bg-[var(--surface-hover)] border-b-[var(--border-color)] hover:border-[var(--border-color)]'
                                                }
                                            `}
                                        >
                                            <div className="flex items-center gap-4">
                                                <div className={`
                                                    w-4 h-4 border flex items-center justify-center transition-colors
                                                    ${isSelected ? 'bg-[var(--text-primary)] border-[var(--text-primary)]' : 'border-[var(--text-secondary)] group-hover:border-[var(--text-primary)]'}
                                                `}>
                                                    {isSelected && <Check size={10} className="text-[var(--bg-color)]" />}
                                                </div>
                                                <div>
                                                    <div className="font-medium text-[var(--text-primary)] leading-tight">{patient.name}</div>
                                                    <div className="text-xs font-mono text-[var(--text-secondary)] mt-1 flex items-center gap-2">
                                                        <span>{patient.ward}</span>
                                                        {patient.condition && (
                                                            <>
                                                                <span className="w-1 h-1 bg-[var(--text-secondary)] rounded-full"></span>
                                                                <span>{patient.condition}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            <div className="flex items-center gap-3">
                                                 {isCritical && <AlertTriangle size={14} className="text-danger" />}
                                                 <div className={`
                                                    font-mono text-xs px-2 py-1 border 
                                                    ${isCritical 
                                                        ? 'border-danger-soft bg-danger-tint text-danger' 
                                                        : 'border-success-soft bg-success-tint text-success'
                                                    }
                                                 `}>
                                                    Risk: {patient.risk_score}
                                                 </div>
                                            </div>
                                        </div>
                                    )
                                })
                            )}
                        </div>

                        <div className="p-4 border-t border-[var(--border-color)] bg-[var(--bg-color)]">
                             <button
                                onClick={generate}
                                disabled={selectedIds.length === 0 || generating}
                                className={`
                                    w-full py-3 px-4 font-mono text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition-all
                                    ${selectedIds.length === 0 || generating
                                        ? 'bg-[var(--surface-color)] text-[var(--text-secondary)] cursor-not-allowed border border-[var(--border-color)]'
                                        : 'bg-[var(--text-primary)] text-[var(--bg-color)] hover:bg-brand hover:text-white border border-transparent hover:shadow-lg'
                                    }
                                `}
                            >
                                {generating ? (
                                    <>
                                        <div className="animate-spin h-3 w-3 border-2 border-[var(--bg-color)] border-t-transparent rounded-full"></div>
                                        Processing...
                                    </>
                                ) : (
                                    <>
                                        Generate Report <ArrowRight size={14} />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Report Preview Column */}
                    <div className="lg:col-span-7 h-full flex flex-col border border-[var(--border-color)] bg-[var(--bg-color)] relative overflow-hidden">
                        <div className="p-4 border-b border-[var(--border-color)] bg-[var(--surface-color)] flex justify-between items-center">
                            <h2 className="font-mono text-sm uppercase tracking-wider text-[var(--text-secondary)]">Report Preview</h2>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-6 bg-canvas font-mono text-sm leading-relaxed text-[var(--text-primary)] relative">
                             {report ? (
                                 <div className="animate-in fade-in duration-500 whitespace-pre-wrap max-w-[65ch] mx-auto">
                                    {report}
                                 </div>
                             ) : (
                                 <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--text-secondary)] opacity-50 pointer-events-none p-8 text-center">
                                     <FileText size={48} strokeWidth={1} className="mb-4 text-[var(--border-color-dark)]" />
                                     <p className="font-serif text-xl mb-2">No Report Generated</p>
                                     <p className="font-mono text-xs max-w-xs">Select patients from the list and click "Generate Report" to create a handover summary.</p>
                                 </div>
                             )}
                        </div>
                    </div>

                </div>
            </div>
        </main>
    </div>
  )
}
