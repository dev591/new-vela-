import { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Search, Activity, Users, Plus, X, 
  Map as MapIcon, BarChart, Clock, 
  ChevronRight, Database, Brain, ArrowUpRight, 
  Stethoscope as _Stethoscope, Bed, Maximize2 as Maximize,
  Calendar
} from 'lucide-react';
import { io } from 'socket.io-client';
import { API_URL, SOCKET_URL } from '../utils/config';
import toast from 'react-hot-toast';
import VelaOnboardingWizard from '../components/VelaOnboardingWizard';
import { 
  ReactFlow, 
  Background, 
  Controls, 
  useNodesState, 
  useEdgesState, 
  Panel,
  Handle,
  Position
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { 
  AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell 
} from 'recharts';

// Removed top-level socket initialization to prevent execution crashes

// --- CUSTOM NODES ---

const WardNode = ({ data }: { data: any }) => {
  const bgColor = data.color || 'var(--text)';
  const beds = data.beds || [];
  const occupied = beds.filter((b: any) => b.status === 'occupied').length;
  const total = beds.length;
  const percentage = total > 0 ? (occupied / total) * 100 : 0;

  return (
    <div className="group relative bg-white border border-line rounded-2xl shadow-sm overflow-hidden min-w-[280px]">
      <div className="h-2 w-full" style={{ backgroundColor: bgColor }}></div>
      <div className="p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink leading-tight">{data.name}</h3>
            <span className="text-[11px] font-medium text-ink-2 uppercase tracking-wider">{data.type}</span>
          </div>
          <div className="p-2 bg-canvas rounded-lg group-hover:bg-surface-2 transition-colors">
            <Maximize size={14} className="text-ink-3" />
          </div>
        </div>

        {/* Staff in Ward */}
        {data.staff && data.staff.length > 0 && (
          <div className="flex items-center gap-1 mb-4">
            <Users size={12} className="text-ink-3" />
            <div className="flex -space-x-2 overflow-hidden">
              {data.staff.map((s: any) => (
                <div key={s.id} title={`${s.name} (${s.role})`} className="inline-block h-6 w-6 rounded-full ring-2 ring-white bg-brand-tint text-brand-dark flex items-center justify-center text-[10px] font-bold uppercase">
                  {s.name.charAt(0)}
                </div>
              ))}
            </div>
            <span className="text-[10px] font-semibold text-ink-2 ml-1">Assigned</span>
          </div>
        )}

        {/* Occupancy Bar */}
        <div className="space-y-2 mb-4">
          <div className="flex justify-between text-[11px] font-medium text-ink-2">
            <span>Occupancy</span>
            <span>{occupied}/{total} Beds</span>
          </div>
          <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden">
            <div 
              className="h-full rounded-full transition-all duration-700" 
              style={{ 
                width: `${percentage}%`,
                backgroundColor: percentage > 80 ? 'var(--danger)' : percentage > 50 ? 'var(--warning)' : 'var(--success)'
              }}
            ></div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {beds.slice(0, 4).map((bed: any) => (
            <div key={bed.id} className="flex items-center gap-2 p-1.5 bg-canvas rounded-md border border-line">
              <div className={`w-2 h-2 rounded-full ${bed.status === 'occupied' ? 'bg-brand' : 'bg-line-strong'}`}></div>
              <span className="text-[10px] font-medium text-ink">{bed.bed_number}</span>
            </div>
          ))}
          {total > 4 && (
            <div className="col-span-2 text-center py-1 text-[10px] text-ink-2 font-medium">
              + {total - 4} more beds
            </div>
          )}
        </div>
      </div>
      
      <Handle type="target" position={Position.Top} className="!bg-line-strong !w-2 !h-2 border-none" />
      <Handle type="source" position={Position.Bottom} className="!bg-line-strong !w-2 !h-2 border-none" />
    </div>
  );
};

const nodeTypes = {
  wardNode: WardNode,
};

// --- COMPONENTS ---

export default function HospitalManager() {
  const [isAuthed, setIsAuthed] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const socket = useMemo(() => io(SOCKET_URL), []);
  const [activeTab, setActiveTab] = useState<'overview' | 'map' | 'staff' | 'analytics' | 'config' | 'staff_mgmt' | 'command'>('overview');
  const [hospitalId, setHospitalId] = useState(localStorage.getItem('vela_hospital_id') || '');
  const [hospitalName, setHospitalName] = useState(localStorage.getItem('vela_hospital_name') || '');
  const [managerName, setManagerName] = useState(localStorage.getItem('vela_manager_name') || '');
  const [managerRole, setManagerRole] = useState(localStorage.getItem('vela_manager_role') || 'Medical Director');
  const [wards, setWards] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<any>({ doctors: [], receptionists: [], lab_controllers: [] });
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [addStaffForm, setAddStaffForm] = useState({ name: '', role: 'doctor', specialization: '', ward_id: '' });
  const [addingStaff, setAddingStaff] = useState(false);
  const [newStaffCreds, setNewStaffCreds] = useState<any>(null);
  const [commandData, setCommandData] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchResult, setSearchResult] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [showAddWardModal, setShowAddWardModal] = useState(false);
  const [newWard, setNewWard] = useState({ name: '', type: 'General', color: 'var(--brand-light)', floor_number: 1 });

  useEffect(() => {
    if (localStorage.getItem('vela_manager_auth') === 'true') {
      setIsAuthed(true);
      setHospitalId(localStorage.getItem('vela_hospital_id') || '');
      setHospitalName(localStorage.getItem('vela_hospital_name') || '');
      setManagerName(localStorage.getItem('vela_manager_name') || '');
      setManagerRole(localStorage.getItem('vela_manager_role') || 'Medical Director');
    }
  }, []);

  useEffect(() => {
    if (staff.length) {
      console.log("[Manager] Loaded active staff:", staff.length);
    }
  }, [staff]);

  const handleManagerLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);

    // DEMO BYPASS
    if (loginEmail === "admin@vela.health" && loginPassword === "demo123") {
      localStorage.setItem('vela_manager_auth', 'true');
      localStorage.setItem('vela_manager_email', loginEmail);
      localStorage.setItem('vela_hospital_id', 'VLA-DEMO');
      localStorage.setItem('vela_hospital_name', 'Vela Demo Hospital');
      localStorage.setItem('vela_manager_name', 'Demo Administrator');
      localStorage.setItem('vela_manager_role', 'Systems Lead');
      setIsAuthed(true);
      setHospitalId('VLA-DEMO');
      setHospitalName('Vela Demo Hospital');
      setManagerName('Demo Administrator');
      setManagerRole('Systems Lead');
      setLoginLoading(false);
      toast.success('Entering Demo Environment');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/manager/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });
      const data = await res.json();
      if (data.status === 'success') {
        localStorage.setItem('vela_manager_auth', 'true');
        localStorage.setItem('vela_hospital_id', data.hospital_id);
        localStorage.setItem('vela_hospital_name', data.hospital_name);
        localStorage.setItem('vela_manager_name', data.manager_name);
        localStorage.setItem('vela_manager_role', data.role);
        setHospitalId(data.hospital_id);
        setHospitalName(data.hospital_name);
        setManagerName(data.manager_name);
        setManagerRole(data.role);
        setIsAuthed(true);
        if (data.walkthrough_done === false) {
          setShowWizard(true);
        }
        toast.success(`Welcome, ${data.manager_name}`);
      } else {
        toast.error(data.message);
      }
    } catch {
      toast.error('Connection failed');
    } finally {
      setLoginLoading(false);
    }
  };

  
  // React Flow State
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, , onEdgesChange] = useEdgesState<any>([]);

  const fetchData = useCallback(async () => {
    let ovRes, wardRes, staffRes;
    try {
      ovRes = await fetch(`${API_URL}/api/hospital/overview?hospital_id=${hospitalId}`);
      wardRes = await fetch(`${API_URL}/api/wards?hospital_id=${hospitalId}`);
      staffRes = await fetch(`${API_URL}/api/staff/list?hospital_id=${hospitalId}`);

      const ov = await ovRes.json();
      const wrd = await wardRes.json();
      const stf = await staffRes.json();

      if (ov?.data) setOverview(ov.data);
      if (wrd?.wards) {
        setWards(wrd.wards);
        // Setup Nodes
        const flowNodes = wrd.wards.map((w: any, idx: number) => ({
          id: String(w.id),
          type: 'wardNode',
          position: { x: w.x || 100, y: w.y || (idx * 250) + 50 },
          data: { ...w },
          draggable: true,
        }));
        setNodes(flowNodes);
      }
      if (stf?.staff) setStaff(stf.staff);
      
      setLoading(false);
    } catch (err) {
      console.error("Fetch error:", err);
      // Fallback Demo Data if API fails (useful for local UI work)
      if (hospitalId === 'VLA-DEMO' || !ovRes || !ovRes.ok) {
        setOverview({
          total_patients: 124,
          active_inpatients: 42,
          total_beds: 100,
          admissions_today: 8,
          appointments_today: 15,
          utilization_trend: [
            { t: '10/04', v: 30 }, { t: '11/04', v: 45 }, { t: '12/04', v: 40 }, 
            { t: '13/04', v: 55 }, { t: '14/04', v: 50 }, { t: '15/04', v: 65 }
          ],
          risk_profile: [
            { name: 'Critical', value: 5, color: 'var(--danger)' },
            { name: 'Stable', value: 85, color: 'var(--success)' },
            { name: 'Monitoring', value: 34, color: 'var(--brand-light)' }
          ]
        });
        setStaff([
          { id: '1', name: 'Dr. Demo', role: 'Chief Medical Officer', available: true },
          { id: '2', name: 'Nurse Demo', role: 'Ward Manager', available: false }
        ]);
        setWards([
          { id: 'w1', name: 'Demo ICU', type: 'Intensive Care', x: 100, y: 100 },
          { id: 'w2', name: 'Demo Ward A', type: 'General', x: 400, y: 150 }
        ]);
        setNodes([
          { id: 'w1', type: 'wardNode', position: { x: 100, y: 100 }, data: { name: 'Demo ICU', type: 'Intensive Care' } },
          { id: 'w2', type: 'wardNode', position: { x: 400, y: 150 }, data: { name: 'Demo Ward A', type: 'General' } }
        ]);
      }
      setLoading(false);
    }
  }, [hospitalId, setNodes]);

  useEffect(() => {
    fetchData();

    socket.on('patient_admitted', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'admission',
        message: `${data.patient_name} admitted to ${data.ward_name} (Bed ${data.bed_number})`,
        time: 'Just now',
        status: 'urgent'
      }, ...prev]);
      fetchData();
    });

    socket.on('patient_discharged', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'discharge',
        message: `${data.patient_name} discharged from Bed ${data.bed_number}`,
        time: 'Just now',
        status: 'stable'
      }, ...prev]);
      fetchData();
    });

    socket.on('bed_status_changed', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'status',
        message: `Bed ${data.bed_id} status changed to ${data.status}`,
        time: 'Just now',
        status: 'info'
      }, ...prev]);
      fetchData();
    });

    socket.on('atlas_analysis_updated', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'ai',
        message: `Atlas AI updated analysis for patient ID ${data.patient_id.substring(0,8)}...`,
        time: 'Just now',
        status: 'ai'
      }, ...prev]);
      fetchData();
    });

    socket.on('queue_updated', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'arrival',
        message: `${data.patient_name} has arrived for appointment`,
        time: 'Just now',
        status: 'stable'
      }, ...prev]);
      fetchData();
    });

    socket.on('lab_update', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'lab',
        message: `Lab Status: ${data.patient_name} - ${data.status.toUpperCase()}`,
        time: 'Just now',
        status: 'info'
      }, ...prev]);
      fetchData();
    });

    socket.on('report_submitted', (data) => {
      setActivity(prev => [{
        id: Date.now(),
        type: 'report',
        message: `NEW REPORT: Diagnostic complete for ${data.patient_name}`,
        time: 'Just now',
        status: 'ai'
      }, ...prev]);
      fetchData();
    });

    return () => {
      socket.off('patient_admitted');
      socket.off('patient_discharged');
      socket.off('bed_status_changed');
      socket.off('atlas_analysis_updated');
      socket.off('queue_updated');
      socket.off('lab_update');
      socket.off('report_submitted');
    };
  }, [fetchData]);

  useEffect(() => {
    if (activeTab === 'staff_mgmt' && hospitalId) {
      fetch(`${API_URL}/api/manager/staff/${hospitalId}`)
        .then(r => r.json())
        .then(d => { if (d.status === 'success') setStaffList(d); })
        .catch(console.error);
    }
    if (activeTab === 'command' && hospitalId) {
      fetch(`${API_URL}/api/manager/command-center/${hospitalId}`)
        .then(r => r.json())
        .then(d => { if (d.status === 'success') setCommandData(d); })
        .catch(console.error);
    }
  }, [activeTab, hospitalId]);

  const onNodeDragStop = async (_event: any, node: any) => {
    try {
      await fetch(`${API_URL}/api/wards/${node.id}/position`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: node.position.x, y: node.position.y })
      });
    } catch (err) {
      console.error("Failed to save position:", err);
    }
  };

  const handleGlobalSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResult([]);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/patients/search?q=${query}`);
      const data = await res.json();
      setSearchResult(data.patients || []);
    } catch (err) {
      console.error("Search error:", err);
    }
  };

  const handleAddWard = async () => {
    if (!newWard.name) return;
    try {
      const res = await fetch(`${API_URL}/api/wards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newWard, hospital_id: hospitalId })
      });
      const data = await res.json();
      if (data.status === 'success') {
        toast.success(`Ward ${data.ward.name} created`);
        setShowAddWardModal(false);
        setNewWard({ name: '', type: 'General', color: 'var(--brand-light)', floor_number: 1 });
        fetchData();
      }
    } catch (err) {
      toast.error('Failed to create ward');
    }
  };

  if (loading) return (
    <div className="h-screen w-full flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-brand-soft border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-medium text-ink-2 animate-pulse">Synchronizing Hospital Core...</p>
      </div>
    </div>
  );

  if (!isAuthed) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)' }}>
        <div style={{ width: 400, padding: 48, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(200,184,154,0.15)', borderRadius: 24, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 24 }}>VELA HOSPITAL OS</div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 64, color: 'var(--brand)', lineHeight: 1, marginBottom: 12 }}>V</div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 28, color: 'var(--white)', marginBottom: 8 }}>Manager Portal</h1>
          <p style={{ color: 'rgba(250,250,249,0.4)', fontSize: 13, marginBottom: 32 }}>Enter your hospital credentials to begin synchronization.</p>
          <form onSubmit={handleManagerLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ textAlign: 'left' }}>
              <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'rgba(250,250,249,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Manager ID / Email</label>
              <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="manager@hospital.vela.health" required
                style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '12px 16px', color: 'var(--white)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ textAlign: 'left' }}>
              <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'rgba(250,250,249,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Access Password</label>
              <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="••••••••" required
                style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '12px 16px', color: 'var(--white)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <button type="submit" disabled={loginLoading}
              style={{ background: 'var(--brand)', color: 'var(--text)', border: 'none', borderRadius: 10, padding: '14px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginTop: 12, transition: 'all 0.2s', opacity: loginLoading ? 0.7 : 1 }}>
              {loginLoading ? 'Synchronizing...' : 'Initialize Session'}
            </button>
          </form>
          <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <p style={{ color: 'rgba(250,250,249,0.3)', fontSize: 11 }}>Secure biometric encrypted session. Unauthorized access is strictly logged by Atlas Engine.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-canvas font-sans text-ink selection:bg-brand-tint overflow-hidden">
      {showWizard && (
        <VelaOnboardingWizard 
          initialData={{ id: hospitalId, name: hospitalName }}
          onboarderName={managerName || hospitalName}
          onClose={async () => { 
            setShowWizard(false); 
            try {
              await fetch(`${API_URL}/api/manager/complete-walkthrough`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hospital_id: hospitalId })
              });
            } catch (err) {
              console.error("Failed to save walkthrough state:", err);
            }
            fetchData(); 
          }}
          isManagerSetup={true}
        />
      )}
      
      {/* ── LEFT SIDEBAR: COMMAND CENTER ── */}
      <div className="w-[320px] flex flex-col border-r border-line bg-white shadow-[1px_0_0_0_rgba(0,0,0,0.02)]">
        {/* Profile / Header */}
        <div className="p-6 border-b border-line">
          <div className="flex items-center gap-3 mb-6">
            <img src="/vela-icon.png" alt="Vela" style={{ height: 32, width: 'auto', objectFit: 'contain' }} />
            <div>
              <h1 className="text-base font-bold text-ink tracking-tight">VELA COMMAND</h1>
              <p className="text-[10px] font-bold text-brand uppercase tracking-widest flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-success rounded-full"></span> SYSTEM LIVE
              </p>
            </div>
          </div>

          {/* Global Search Interface */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" size={16} />
            <input 
              type="text"
              placeholder="Search patients, wards, staff..."
              className="w-full pl-10 pr-4 py-2.5 bg-canvas border border-line rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-soft/20 focus:border-brand-soft transition-all"
              onFocus={() => setShowSearchModal(true)}
              onChange={(e) => handleGlobalSearch(e.target.value)}
              value={searchQuery}
            />
          </div>
        </div>

        {/* Real-time Activity Feed */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 flex items-center justify-between border-b border-line">
            <span className="text-[11px] font-bold text-ink-3 uppercase tracking-widest">Global Activity</span>
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-brand bg-brand-tint px-2 py-0.5 rounded-full">
              <Clock size={10} /> Real-time
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 scrollbar-none">
            {activity.length === 0 ? (
              <div className="h-32 flex flex-col items-center justify-center text-ink-3">
                <Activity size={24} className="mb-2 opacity-20" />
                <p className="text-[11px] font-medium">No system events yet</p>
              </div>
            ) : (
              activity.map((item) => (
                <div key={item.id} className="group relative flex gap-3 p-3 bg-white border border-line rounded-xl hover:shadow-md hover:border-line transition-all duration-300">
                  <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                    item.status === 'urgent' ? 'bg-danger' : 
                    item.status === 'ai' ? 'bg-brand' : 
                    item.status === 'stable' ? 'bg-success' : 'bg-brand'
                  } shadow-sm animate-pulse`}></div>
                  <div>
                    <p className="text-[12px] font-medium text-ink leading-snug">{item.message}</p>
                    <span className="text-[10px] text-ink-3 font-medium">{item.time}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Bottom Status */}
        <div className="p-4 bg-canvas/50 border-t border-line">
          <div className="flex items-center justify-between mb-3 px-2">
            <div className="flex items-center gap-2">
              <Brain size={16} className="text-brand" />
              <span className="text-xs font-semibold text-ink">Atlas Analysis Engine</span>
            </div>
            <div className="text-[10px] font-bold text-brand bg-brand-tint px-1.5 py-0.5 rounded uppercase">V2.4 LATEST</div>
          </div>
          <p className="text-[10px] text-ink-2 leading-relaxed px-1">
            Processing live diagnostic data. Atlas is cross-referencing document trends for active cases.
          </p>
        </div>
      </div>

      {/* ── RIGHT MAIN: MODULE DISPLAY ── */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        
        {/* Top Tab Bar */}
        <header className="h-[72px] bg-white border-b border-line flex items-center justify-between px-8 z-10 shadow-sm shadow-line-strong/5">
          <nav className="flex items-center gap-1">
            {/* Tabs List Filtered */}
            {[
              { id: 'overview', icon: BarChart, label: 'Performance' },
              { id: 'map', icon: MapIcon, label: 'Ward Map' },
              { id: 'staff_mgmt', icon: Users, label: 'Personnel' },
              { id: 'command', icon: Activity, label: 'Command Center' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 ${
                  activeTab === tab.id 
                  ? 'bg-brand-tint text-brand border border-brand-soft shadow-sm shadow-brand-soft/50' 
                  : 'text-ink-2 hover:bg-canvas hover:text-ink'
                }`}
              >
                <tab.icon size={18} strokeWidth={activeTab === tab.id ? 2.5 : 2} />
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
              <span className="text-xs font-bold text-ink tracking-tight">{managerName || 'Manager'}</span>
              <span className="text-[10px] font-bold text-ink-3 tracking-widest uppercase italic">{managerRole || 'Hospital Director'}</span>
            </div>
            <div className="w-10 h-10 rounded-full border-2 border-line p-0.5 cursor-pointer hover:border-brand-soft transition-colors">
              <div className="w-full h-full rounded-full bg-surface-2 flex items-center justify-center text-ink-2 font-bold overflow-hidden">
                <img src={`https://ui-avatars.com/api/?name=${encodeURIComponent(managerName || 'Manager')}&background=f1f5f9&color=64748b`} alt="Director" />
              </div>
            </div>
          </div>
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto bg-canvas/50 p-8 scroll-smooth">
          
          {activeTab === 'overview' && overview && (
            <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
              {/* Stats Grid */}
              <div className="grid grid-cols-4 gap-6">
                {[
                  { label: 'Total Patients', value: overview.total_patients, icon: Users, color: 'text-brand', bg: 'bg-brand-tint' },
                  { label: 'Active Inpatients', value: overview.active_inpatients, icon: Bed, color: 'text-brand', bg: 'bg-brand-tint', total: overview.total_beds },
                  { label: 'Daily Admissions', value: overview.admissions_today, icon: ArrowUpRight, color: 'text-brand', bg: 'bg-brand-tint/50' },
                  { label: 'Appointments Today', value: overview.appointments_today, icon: Calendar, color: 'text-success', bg: 'bg-success-tint' },
                ].map((stat: any, i) => (
                  <div key={i} className="bg-white p-6 rounded-2xl border border-line shadow-sm hover:shadow-md transition-shadow group">
                    <div className="flex items-center justify-between mb-4">
                      <div className={`p-3 rounded-xl ${stat.bg} ${stat.color} transition-transform group-hover:scale-110`}>
                        <stat.icon size={22} />
                      </div>
                    </div>
                    <div>
                      <h4 className="text-[11px] font-bold text-ink-2 uppercase tracking-widest mb-1">{stat.label}</h4>
                      <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-black text-ink leading-none">{stat.value}</span>
                        {stat.total && <span className="text-ink-3 font-bold text-sm">/ {stat.total}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

                {/* Charts Grid */}
                <div className="grid grid-cols-3 gap-8">
                  {/* Occupancy Chart */}
                  <div className="col-span-2 bg-white rounded-3xl border border-line p-8 shadow-sm">
                  <div className="flex items-center justify-between mb-10">
                    <div>
                      <h3 className="text-lg font-bold text-ink leading-none mb-2">Facility Utilization</h3>
                      <p className="text-xs font-semibold text-ink-3">Total ward occupancy for the last 14 days</p>
                    </div>
                    <div className="p-2 border border-line rounded-xl">
                      <select className="bg-transparent text-[11px] font-bold text-ink-2 focus:outline-none pr-4">
                        <option>LAST 14 DAYS</option>
                      </select>
                    </div>
                  </div>
                  <div className="h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={overview.utilization_trend || []}>
                        <defs>
                          <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--brand-light)" stopOpacity={0.1}/>
                            <stop offset="95%" stopColor="var(--brand-light)" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--bg-secondary)" />
                        <XAxis 
                          dataKey="t" 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: 'var(--text-tertiary)', fontSize: 10, fontWeight: 700}} 
                          dy={10}
                        />
                        <YAxis 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: 'var(--text-tertiary)', fontSize: 10, fontWeight: 700}} 
                        />
                        <Tooltip 
                          contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontSize: '12px', fontWeight: 'bold' }}
                        />
                        <Area type="monotone" dataKey="v" stroke="var(--brand-light)" strokeWidth={3} fillOpacity={1} fill="url(#colorVal)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Risk Distribution */}
                <div className="bg-white rounded-3xl border border-line p-8 shadow-sm">
                  <h3 className="text-sm font-bold text-ink mb-6">Risk Profile Stratification</h3>
                  <div className="h-[240px] w-full flex items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={overview.risk_profile || []}
                          innerRadius={60}
                          outerRadius={90}
                          paddingAngle={8}
                          dataKey="value"
                        >
                          {(overview.risk_profile || []).map((entry: any, index: number) => (
                            <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-3 mt-6">
                    {(overview.risk_profile || []).map((row: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 bg-canvas rounded-xl">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full`} style={{ backgroundColor: row.color }}></div>
                          <span className="text-[10px] font-bold text-ink-2 uppercase tracking-tight">{row.name}</span>
                        </div>
                        <span className="text-[11px] font-black text-ink">
                          {overview.total_patients > 0 ? Math.round((row.value / overview.total_patients) * 100) : 0}%
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        )}

          {activeTab === 'map' && (
            <div className="h-full w-full bg-white rounded-3xl border border-line shadow-sm overflow-hidden relative">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                nodeTypes={nodeTypes}
                fitView
                className="bg-canvas/50"
              >
                <Background color="var(--border-strong)" gap={20} size={1} />
                <Controls className="!bg-white !border-line !shadow-lg rounded-xl overflow-hidden" />
                <Panel position="top-left" className="bg-white/80 backdrop-blur-md p-4 m-4 rounded-2xl border border-white shadow-xl shadow-line/50">
                  <div className="flex items-center gap-4">
                    <div>
                      <h4 className="text-sm font-bold text-ink">Hospital Layout Explorer</h4>
                      <p className="text-[10px] font-semibold text-ink-2">Drag wards to customize your administrative view</p>
                    </div>
                    <div className="h-10 w-[1px] bg-surface-2"></div>
                    <button 
                      onClick={() => setShowAddWardModal(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-brand text-white rounded-xl text-xs font-bold hover:bg-brand-dark transition-all shadow-lg shadow-brand-soft"
                    >
                      <Plus size={14} /> NEW WARD
                    </button>
                  </div>
                </Panel>
              </ReactFlow>
            </div>
          )}


          {/* ── STAFF MANAGEMENT TAB ── */}
          {activeTab === 'staff_mgmt' && (
            <div style={{ maxWidth: 900, margin: '0 auto' }}>
              {/* Add Staff Modal */}
              {showAddStaff && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
                  <div style={{ background: 'white', borderRadius: 20, padding: 40, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                    <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 24, color: 'var(--text)', marginBottom: 24 }}>Add Staff Member</h3>
                    {newStaffCreds ? (
                      <div>
                        <div style={{ background: 'var(--success-light)', border: '1px solid var(--color-success-soft)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Staff Login Created</div>
                          <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{newStaffCreds.name} — {newStaffCreds.role}</div>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>{newStaffCreds.email}</div>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>{newStaffCreds.password}</div>
                        </div>
                        <button type="button" onClick={() => { setShowAddStaff(false); setNewStaffCreds(null); setAddStaffForm({ name: '', role: 'doctor', specialization: '', ward_id: '' }); if (hospitalId) fetch(`${API_URL}/api/manager/staff/${hospitalId}`).then(r => r.json()).then(d => { if (d.status === 'success') setStaffList(d); }); }}
                          style={{ width: '100%', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 10, padding: '12px', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Done</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                          <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Role</label>
                          <select value={addStaffForm.role} onChange={e => setAddStaffForm(f => ({ ...f, role: e.target.value }))}
                            style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)', outline: 'none', background: 'white' }}>
                            <option value="doctor">Doctor</option>
                            <option value="receptionist">Receptionist</option>
                            <option value="lab_controller">Lab Controller</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Full Name</label>
                          <input value={addStaffForm.name} onChange={e => setAddStaffForm(f => ({ ...f, name: e.target.value }))} placeholder="Dr. Priya Sharma"
                            style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }} />
                        </div>
                        {addStaffForm.role === 'doctor' && (
                          <div>
                            <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Specialization</label>
                            <input value={addStaffForm.specialization} onChange={e => setAddStaffForm(f => ({ ...f, specialization: e.target.value }))} placeholder="Cardiology"
                              style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }} />
                          </div>
                        )}

                        <div>
                          <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Assign Ward area</label>
                          <select 
                            value={addStaffForm.ward_id} 
                            onChange={e => setAddStaffForm(f => ({ ...f, ward_id: e.target.value }))}
                            style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)', outline: 'none', background: 'white' }}
                          >
                            <option value="">Floating / Unassigned</option>
                            {wards.map(w => (
                              <option key={w.id} value={w.id}>{w.name} ({w.type})</option>
                            ))}
                          </select>
                          {addStaffForm.role === 'lab_controller' && !wards.some(w => w.type?.toLowerCase().includes('lab')) && (
                            <p style={{ marginTop: 6, fontSize: 11, color: 'var(--danger)', fontFamily: 'var(--font-sans)' }}>⚠️ No Lab area detected. Add a Lab Ward first to hire controllers.</p>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                          <button type="button" onClick={() => setShowAddStaff(false)}
                            style={{ flex: 1, background: 'var(--bg-secondary)', border: 'none', borderRadius: 10, padding: '12px', fontFamily: 'var(--font-sans)', fontSize: 14, cursor: 'pointer', color: 'var(--text-secondary)' }}>Cancel</button>
                          <button 
                            type="button" 
                            disabled={addingStaff || !addStaffForm.name.trim() || (addStaffForm.role === 'lab_controller' && !wards.some(w => w.type?.toLowerCase().includes('lab')))} 
                            onClick={async () => {
                            setAddingStaff(true);
                            try {
                              const payload = {
                                ...addStaffForm,
                                hospital_id: hospitalId,
                                ward_id: addStaffForm.ward_id || null
                              };
                              const res = await fetch(`${API_URL}/api/manager/add-staff`, { 
                                method: 'POST', 
                                headers: { 'Content-Type': 'application/json' }, 
                                body: JSON.stringify(payload) 
                              });
                              const data = await res.json();
                              if (data.status === 'success') {
                                setNewStaffCreds(data);
                                toast.success('Staff member added successfully');
                                // Refresh list
                                if (hospitalId) {
                                  fetch(`${API_URL}/api/manager/staff/${hospitalId}`).then(r => r.json()).then(d => { if (d.status === 'success') setStaffList(d); });
                                }
                              } else {
                                toast.error(data.message || 'Failed to add staff');
                              }
                            } catch (err) {
                              toast.error('Connection failed');
                            } finally { setAddingStaff(false); }
                          }}
                            style={{ flex: 1, background: addingStaff || !addStaffForm.name.trim() ? 'var(--text-tertiary)' : 'var(--accent)', color: 'white', border: 'none', borderRadius: 10, padding: '12px', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                            {addingStaff ? 'Adding...' : 'Add to Team'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
                <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 32, color: 'var(--text)' }}>Your Team</h2>
                <button type="button" onClick={() => setShowAddStaff(true)}
                  style={{ background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 24px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                  + Add Staff Member
                </button>
              </div>

              {(['doctors', 'receptionists', 'lab_controllers'] as const).map(group => {
                const members = staffList[group] || [];
                const label = group === 'doctors' ? 'Doctors' : group === 'receptionists' ? 'Receptionists' : 'Lab Controllers';
                return (
                  <div key={group} style={{ marginBottom: 32 }}>
                    <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 12 }}>{label} ({members.length})</h3>
                    {members.length === 0 ? (
                      <div style={{ padding: '20px', border: '1px dashed var(--border)', borderRadius: 12, textAlign: 'center', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', fontSize: 13 }}>No {label.toLowerCase()} added yet.</div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                        {members.map((s: any) => (
                          <div key={s.id} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)', fontSize: 18, fontWeight: 700 }}>
                                {s.name.charAt(0)}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>{s.name}</div>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  {s.specialization && <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)' }}>{s.specialization}</div>}
                                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: 4 }}>{s.ward_name || 'Floating'}</div>
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.online ? 'var(--success)' : 'var(--text-tertiary)' }} />
                                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: s.online ? 'var(--success)' : 'var(--text-tertiary)' }}>{s.online ? 'Online' : 'Offline'}</span>
                              </div>
                            </div>
                            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-secondary)' }}>{s.email}</div>
                              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Password shown once, at creation — not recoverable afterward.</div>
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" onClick={() => { navigator.clipboard.writeText(s.email); }}
                                style={{ flex: 1, background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: '6px', fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', cursor: 'pointer', textTransform: 'uppercase' }}>Copy Email</button>
                              <button type="button" onClick={async () => { if (confirm(`Remove ${s.name}?`)) { await fetch(`${API_URL}/api/manager/staff/${s.id}`, { method: 'DELETE' }); if (hospitalId) fetch(`${API_URL}/api/manager/staff/${hospitalId}`).then(r => r.json()).then(d => { if (d.status === 'success') setStaffList(d); }); } }}
                                style={{ flex: 1, background: 'var(--danger-light)', border: 'none', borderRadius: 6, padding: '6px 10px', fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--danger)', cursor: 'pointer', textTransform: 'uppercase' }}>Remove</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── COMMAND CENTER TAB ── */}
          {activeTab === 'command' && (
            <div style={{ maxWidth: 900, margin: '0 auto' }}>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 32, color: 'var(--text)', marginBottom: 24 }}>Command Center</h2>

              {/* Staff Online */}
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 24, marginBottom: 20 }}>
                <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 16 }}>Staff Online Now</h3>
                {!commandData || commandData.staff_online.length === 0 ? (
                  <p style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-tertiary)' }}>No staff currently online.</p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {commandData.staff_online.map((s: any) => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--success-light)', border: '1px solid var(--color-success-soft)', borderRadius: 100, padding: '6px 14px' }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} />
                        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--success)', fontWeight: 500 }}>{s.name}</span>
                        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--success)' }}>{s.role}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Patient Flow */}
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 24, marginBottom: 20 }}>
                <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 16 }}>Patient Flow</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
                  {[
                    { label: 'Waiting', value: commandData?.patients_waiting ?? 0, color: 'var(--brand-light)' },
                    { label: 'Consulting', value: commandData?.patients_in_consultation ?? 0, color: '#8B5CF6' },
                    { label: 'In Lab', value: commandData?.patients_in_lab ?? 0, color: 'var(--warning)' },
                    { label: 'In Ward', value: commandData?.patients_in_ward ?? 0, color: 'var(--accent)' },
                    { label: 'Discharged', value: commandData?.discharged_today ?? 0, color: 'var(--success)' },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ textAlign: 'center', padding: 16, background: 'var(--bg)', borderRadius: 12 }}>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 36, color, lineHeight: 1, marginBottom: 4 }}>{value}</div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Atlas Stats */}
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 24 }}>
                <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 16 }}>Atlas AI Today</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                  {[
                    { label: 'Total Queries', value: commandData?.atlas_queries_today ?? 0, color: 'var(--brand)' },
                    { label: 'Critical Alerts', value: commandData?.critical_alerts_today ?? 0, color: 'var(--danger)' },
                    { label: 'Avg Response', value: '2.3s', color: 'var(--success)' },
                    { label: 'Reports Analyzed', value: 0, color: 'var(--brand-light)' },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ textAlign: 'center', padding: 16, background: 'var(--bg)', borderRadius: 12 }}>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 32, color, lineHeight: 1, marginBottom: 4 }}>{value}</div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* ── SEARCH RESULTS MODAL ── */}
      {showSearchModal && (
        <div className="fixed inset-0 z-[100] bg-night/40 backdrop-blur-sm p-8 flex items-start justify-center pt-[15vh]">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-line overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-6 border-b border-line flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-brand-tint text-brand rounded-lg">
                  <Search size={20} />
                </div>
                <div>
                  <h2 className="text-lg font-black text-ink leading-none mb-1">Global Patient Intelligence</h2>
                  <p className="text-xs font-semibold text-ink-3">Search by Name, VELA ID, or Medical Condition</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowSearchModal(false); setSearchQuery(''); setSearchResult([]); }}
                className="p-2 text-ink-3 hover:text-ink hover:bg-canvas rounded-xl transition-all"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4">
              <input 
                autoFocus
                type="text"
                placeholder="Type to search..."
                className="w-full px-6 py-4 bg-canvas border-none rounded-2xl text-lg font-medium focus:ring-0 placeholder:text-ink-3"
                value={searchQuery}
                onChange={(e) => handleGlobalSearch(e.target.value)}
              />
            </div>

            <div className="max-h-[500px] overflow-y-auto p-4 space-y-3">
              {searchResult.length > 0 ? (
                searchResult.map((p) => (
                  <div key={p.id} className="group p-4 bg-white border border-line rounded-2xl hover:border-brand-soft hover:shadow-md transition-all duration-300 flex items-center justify-between relative">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-2xl bg-brand-tint flex items-center justify-center font-bold text-brand uppercase">
                        {p.name.charAt(0)}
                      </div>
                      <div>
                        <h4 className="text-base font-bold text-ink mb-0.5">{p.name}</h4>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] font-bold text-brand bg-brand-tint px-2 py-0.5 rounded uppercase tracking-wider">{p.vela_id}</span>
                          <span className="text-[10px] font-medium text-ink-3">Age: {p.age}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <div className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Atlas Score</div>
                        <div className={`text-base font-black ${
                          p.risk_score > 70 ? 'text-danger' : p.risk_score > 40 ? 'text-warning' : 'text-success'
                        }`}>
                          {p.risk_score}/100
                        </div>
                      </div>
                      <button className="p-3 bg-night text-white rounded-xl hover:scale-105 transition-transform">
                        <ChevronRight size={18} />
                      </button>
                    </div>

                    {/* Quick AI Snapshot Hover */}
                    {p.atlas_analysis && (
                      <div className="absolute top-1/2 -translate-y-1/2 right-[105%] w-64 p-4 bg-night text-white rounded-2xl shadow-2xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                        <div className="flex items-center gap-2 mb-2">
                          <Brain size={14} className="text-brand-light" />
                          <span className="text-[10px] font-bold tracking-widest uppercase">Atlas Snapshot</span>
                        </div>
                        <p className="text-[11px] font-medium leading-relaxed italic line-clamp-4">"{p.atlas_analysis}"</p>
                      </div>
                    )}
                  </div>
                ))
              ) : searchQuery.length >= 2 ? (
                <div className="h-40 flex flex-col items-center justify-center text-ink-3">
                  <Search size={32} className="mb-2 opacity-20" />
                  <p className="text-sm font-bold">No patients found matches "{searchQuery}"</p>
                </div>
              ) : (
                <div className="h-40 flex flex-col items-center justify-center text-ink-3">
                  <Database size={32} className="mb-2 opacity-20" />
                  <p className="text-[11px] font-bold uppercase tracking-widest">Type to begin indexing database</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showAddWardModal && (
        <div className="fixed inset-0 bg-night/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="p-8 border-b border-line flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-ink">Configure New Ward</h3>
                <p className="text-xs font-semibold text-ink-2">Initialize a clinical department in the hospital OS</p>
              </div>
              <button 
                onClick={() => setShowAddWardModal(false)}
                className="p-2 hover:bg-surface-2 rounded-xl text-ink-3 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div>
                <label className="text-[10px] font-bold text-ink-3 uppercase tracking-widest block mb-1.5">Ward Designation</label>
                <input 
                  type="text" 
                  placeholder="e.g. ICU, General, Pediatric" 
                  value={newWard.name}
                  onChange={e => setNewWard({ ...newWard, name: e.target.value })}
                  className="w-full px-4 py-3 bg-canvas border border-line rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-soft/20"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-ink-3 uppercase tracking-widest block mb-1.5">Department Type</label>
                  <select 
                    value={newWard.type}
                    onChange={e => setNewWard({ ...newWard, type: e.target.value })}
                    className="w-full px-4 py-3 bg-canvas border border-line rounded-xl text-sm focus:outline-none"
                  >
                    <option>General</option>
                    <option>ICU</option>
                    <option>ER</option>
                    <option>OPD</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-ink-3 uppercase tracking-widest block mb-1.5">Floor Level</label>
                  <input 
                    type="number" 
                    value={newWard.floor_number}
                    onChange={e => setNewWard({ ...newWard, floor_number: parseInt(e.target.value) })}
                    className="w-full px-4 py-3 bg-canvas border border-line rounded-xl text-sm"
                  />
                </div>
              </div>

              <button 
                onClick={handleAddWard}
                className="w-full py-4 bg-brand text-white rounded-2xl text-sm font-bold shadow-xl shadow-brand-soft hover:bg-brand-dark transition-all active:scale-[0.98]"
              >
                INITIALIZE WARD
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
