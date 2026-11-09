import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WardBoard from './WardBoard'

const admission = {
  id: 'adm1', patient_id: 'p1', bed_id: 'b1', ward_id: 'w1', status: 'active', admitted_at: '2026-11-09T17:05:00', days: 2,
  room_type: 'ICU Room', cost_per_day: 10000, room_cost_so_far: 20000, reason: 'Critical condition', diagnosis: 'Heart failure',
  recommended_by: 'Dr Arjun Rao', admitted_by: 'Meera Shah', admission_qr: 'ADM-ABC123',
  patients: { id: 'p1', name: 'Rajesh Kumar', vela_id: 'VLA-8888', age: 45, gender: 'Male', blood_group: 'O+', allergies: 'Penicillin', risk_score: 45 },
  wards: { name: 'ICU' }, beds: { bed_number: 'ICU-01' },
}
const board = {
  status: 'success',
  summary: { total: 3, occupied: 1, empty: 1, unavailable: 1, occupancy: 33 },
  room_types: [{ name: 'General Ward', cost_per_day: 1200 }, { name: 'ICU Room', cost_per_day: 10000 }],
  recommendations: [{ rec_id: 'r1', patient_id: 'p2', patient_name: 'Priya Nair', ward_type: 'ICU', ward_id: 'w1', ward_name: 'ICU', bed_id: 'b2', bed_number: 'ICU-02', reason: 'Observation', priority: 'urgent', doctor: 'Doctor', bed_still_free: true }],
  wards: [{ id: 'w1', name: 'ICU', type: 'ICU', color: '#0F766E', staff: [], beds: [
    { id: 'b1', ward_id: 'w1', bed_number: 'ICU-01', status: 'occupied', admission },
    { id: 'b2', ward_id: 'w1', bed_number: 'ICU-02', status: 'empty', admission: null },
    { id: 'b3', ward_id: 'w1', bed_number: 'ICU-03', status: 'maintenance', admission: null },
  ] }],
}

const mockApi = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/wards/board')) return new Response(JSON.stringify(board))
  return new Response(JSON.stringify({ status: 'success' }))
})

afterEach(cleanup)

describe('WardBoard', () => {
  it('shows totals, the waiting request and a tile per bed with the patient name', async () => {
    mockApi()
    render(<WardBoard canAdmit />)
    expect(await screen.findByText('Rajesh Kumar')).toBeTruthy()                       // name on the occupied bed
    expect(screen.getByRole('button', { name: /Bed ICU-02, free/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Bed ICU-03, out of service/ })).toBeTruthy()
    expect(screen.getByText('33%')).toBeTruthy()
    expect(screen.getByText(/Waiting for you · 1/)).toBeTruthy()
    expect(screen.getByText('Priya Nair')).toBeTruthy()
  })

  it('opens the detail panel with who, why, when and cost, and hands discharge to the caller', async () => {
    mockApi()
    const onDischarge = vi.fn()
    render(<WardBoard canAdmit onDischarge={onDischarge} />)
    fireEvent.click(await screen.findByRole('button', { name: /Bed ICU-01, Rajesh Kumar/ }))
    expect(await screen.findByText('Why and who')).toBeTruthy()
    expect(screen.getByText('Critical condition')).toBeTruthy()
    expect(screen.getByText('Meera Shah')).toBeTruthy()                                 // admitted by
    expect(screen.getByText('Dr Arjun Rao')).toBeTruthy()                               // recommended by
    expect(screen.getByText(/₹20,000/)).toBeTruthy()                                    // 2 days of ICU
    fireEvent.click(screen.getByRole('button', { name: /Discharge Rajesh/ }))
    expect(onDischarge).toHaveBeenCalledWith(expect.objectContaining({ id: 'adm1' }))
  })

  it('offers the admit form on a free bed and an out-of-service switch', async () => {
    mockApi()
    render(<WardBoard canAdmit />)
    fireEvent.click(await screen.findByRole('button', { name: /Bed ICU-02, free/ }))
    expect(await screen.findByText('Admit a patient to this bed')).toBeTruthy()
    // This bed has a waiting request from the doctor, so the patient arrives pre-filled and Admit is ready.
    expect(screen.getAllByText('Priya Nair').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Admit to bed ICU-02/ }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: /Mark bed out of service/ })).toBeTruthy()
  })

  it('is read-only for the manager: no discharge or admit buttons', async () => {
    mockApi()
    render(<WardBoard />)
    fireEvent.click(await screen.findByRole('button', { name: /Bed ICU-01, Rajesh Kumar/ }))
    await waitFor(() => expect(screen.getByText('Why and who')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Discharge Rajesh/ })).toBeNull()
  })

  it('says so when the hospital has no wards', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...board, wards: [], recommendations: [], summary: { total: 0, occupied: 0, empty: 0, unavailable: 0, occupancy: 0 } })))
    render(<WardBoard canAdmit />)
    expect(await screen.findByText(/No wards yet/)).toBeTruthy()
  })
})
