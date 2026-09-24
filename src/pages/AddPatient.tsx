import { API_URL } from "../utils/config";
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DoctorSidebar from '../components/DoctorSidebar'
import toast from 'react-hot-toast'

type Patient = { id: string; name: string; vela_id: string }

export default function AddPatient() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [form, setForm] = useState({ name: '', age: '', gender: 'Male', blood_group: '', height: '', weight: '', allergies: '', existing_conditions: '', emergency_contact: '', language: 'English', ward: 'General', room: '', doctor: '', diagnosis: '', registered_by: 'doctor' })
  const [loading, setLoading] = useState(false)
  const [created, setCreated] = useState<Patient | null>(null)
  const navigate = useNavigate()

  const handleChange = (key: string, value: string) => setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name || !form.age || !form.gender) {
      toast.error('Name, age and gender are required')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/receptionist/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setCreated(data.patient)
        toast.success(`Registered: ${data.patient.name} (${data.vela_id})`)
      }
    } catch {
      toast.error('List error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <DoctorSidebar onExpandChange={setSidebarExpanded} />
      <main style={{ marginLeft: sidebarExpanded ? '240px' : '64px', transition: 'margin-left 0.3s ease', padding: '32px', minHeight: '100vh', background: 'var(--bg)' }}>
        <h1 style={{ fontFamily: 'Bebas Neue', fontSize: 48 }}>Add Patient</h1>
        <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 20 }}>
          {['name','age','gender','blood_group','height','weight','allergies','existing_conditions','emergency_contact','language','ward','room','doctor','diagnosis'].map((key) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--text-muted)' }}>{key.replace('_',' ').toUpperCase()}</label>
              {key === 'gender' ? (
                <select value={(form as any)[key]} onChange={(e) => handleChange(key, e.target.value)} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <option>Male</option><option>Female</option><option>Other</option>
                </select>
              ) : (
                <input type={key === 'age' ? 'number' : 'text'} value={(form as any)[key]} onChange={(e) => handleChange(key, e.target.value)} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }} />
              )}
            </div>
          ))}
          <button type="submit" disabled={loading} style={{ gridColumn: 'span 2', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 8, padding: 12 }}>
            {loading ? 'Registering...' : 'Register Patient'}
          </button>
        </form>
        {created && (
          <div style={{ marginTop: 20, padding: 16, background: 'var(--bg-section)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div>Registered {created.name} as {created.vela_id}</div>
            <button type="button" onClick={() => navigate(`/patients/${created.id}`)} style={{ marginTop: 8, background: 'var(--blue)', color: 'white', border: 'none', padding: 10, borderRadius: 8 }}>Open Patient Dashboard</button>
          </div>
        )}
      </main>
    </>
  )
}
