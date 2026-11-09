import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VirtualConsult from './VirtualConsult'

// The sidebar and the chart library are not what is being tested here.
vi.mock('../components/DoctorSidebar', () => ({ default: () => <nav aria-label="sidebar" /> }))
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <svg data-testid="trend">{children}</svg>,
  Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
}))

const records = {
  status: 'success',
  patient: { id: 'p1', name: 'Mohammed Irfan', vela_id: 'VLA-9002', age: 61, gender: 'Male', blood_group: 'O-', allergies: 'Sulfa drugs', existing_conditions: 'Chronic kidney disease' },
  reports: [{ id: 'd1', filename: 'Kidney_Panel_Nov_2026.pdf', date: '2026-11-03', risk_score: 78, summary: 'Kidney function continues to fall.', flags: ['High potassium'], has_file: false,
    values: [{ test: 'Potassium', unit: 'mmol/L', result: '5.9', status: 'Critical', reference: '3.5 - 5.1', number: 5.9, low: 3.5, high: 5.1 }] }],
  abnormal: [{ test: 'Potassium', unit: 'mmol/L', result: '5.9', status: 'Critical', reference: '3.5 - 5.1', number: 5.9, low: 3.5, high: 5.1, date: '2026-11-03', report: 'Kidney_Panel_Nov_2026.pdf' }],
  trends: [{ test: 'Potassium', unit: 'mmol/L', reference: '3.5 - 5.1', points: [{ date: '2026-04-02', value: 4.9, status: 'Normal' }, { date: '2026-11-03', value: 5.9, status: 'Critical' }] }],
}
const analysis = { headline: 'Kidney function is declining and potassium is high.', summary: 'Needs attention.', explanations: { Potassium: 'High potassium can affect the heart rhythm.' },
  findings: [{ title: 'High potassium', detail: 'Potassium is critically high.', level: 'concern' }], questions_to_ask: ['Any palpitations?'], consider: ['Consider repeating the test.'] }

const mockApi = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.endsWith('/api/virtual-consult/open')) return new Response(JSON.stringify(records))
  if (url.endsWith('/api/virtual-consult/analysis')) return new Response(JSON.stringify({ status: 'success', analysis }))
  if (url.endsWith('/api/virtual-consult/speak')) return new Response(JSON.stringify({ status: 'success', script: 'आपकी किडनी कमज़ोर हो रही है।', audio: 'AAAA', lang: 'hi-IN' }))
  return new Response(JSON.stringify({}), { status: 404 })
})
const open = async (id = 'vla-9002') => {
  render(<MemoryRouter><VirtualConsult /></MemoryRouter>)
  fireEvent.change(screen.getByLabelText('VELA ID'), { target: { value: id } })
  fireEvent.click(screen.getByRole('button', { name: /Open records/ }))
}

afterEach(cleanup)

describe('VirtualConsult', () => {
  it('shows the presentation note about OTP up front', () => {
    render(<MemoryRouter><VirtualConsult /></MemoryRouter>)
    expect(screen.getByRole('note').textContent).toMatch(/one-time code \(OTP\)/)
  })

  it('opens a patient, shows reports and numbers at once, then fills in the plain-language reading', async () => {
    const fetchSpy = mockApi()
    await open()
    expect(await screen.findByText('Mohammed Irfan')).toBeTruthy()
    expect(screen.getByText(/Allergic: Sulfa drugs/)).toBeTruthy()
    expect(screen.getByText('Numbers to look at')).toBeTruthy()
    expect(screen.getByText('How it has changed')).toBeTruthy()
    expect(await screen.findByText('Kidney function is declining and potassium is high.')).toBeTruthy()   // after the analysis call
    expect(screen.getByText('High potassium can affect the heart rhythm.')).toBeTruthy()                     // per-value explanation
    expect(screen.getByText('Any palpitations?')).toBeTruthy()
    const body = JSON.parse(String((fetchSpy.mock.calls.find(c => String(c[0]).endsWith('/open'))![1] as RequestInit).body))
    expect(body.vela_id).toBe('VLA-9002')                                                                    // upper-cased before sending
  })

  it('reads the explanation aloud in Hindi when asked', async () => {
    mockApi()
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('Audio', vi.fn(() => ({ play, pause: vi.fn() })))
    await open()
    fireEvent.click(await screen.findByRole('button', { name: /हिन्दी/ }))
    expect(await screen.findByText(/आपकी किडनी कमज़ोर हो रही है/)).toBeTruthy()
    expect(play).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('shows a friendly message for an unknown VELA ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'x' }), { status: 404 }))
    await open('VLA-0000')
    expect((await screen.findByRole('alert')).textContent).toMatch(/No patient found/)
  })

  it('says when a patient has no reports yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...records, reports: [], abnormal: [], trends: [] })))
    await open()
    await waitFor(() => expect(screen.getByText(/No reports on file for Mohammed Irfan yet/)).toBeTruthy())
  })
})
