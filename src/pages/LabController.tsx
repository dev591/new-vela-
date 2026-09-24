import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FlaskConical as Flask, CheckCircle2 as Check, BarChart3 as Chart, Settings,
  Clock, AlertTriangle, LogOut,
  User, Activity, Play, Send,
  RefreshCw, Beaker, FileText, QrCode, Plus, Trash2, Download, X, Layers
} from 'lucide-react';
import { io } from 'socket.io-client';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { API_URL, SOCKET_URL } from '../utils/config';
import { openGeneratedDocument } from '../utils/documents';

type TestStatus = 'payment_pending' | 'payment_confirmed' | 'accepted' | 'in_progress' | 'completed';

interface LabOrder {
  id: string;
  patient_id: string;
  doctor_name: string;
  test_type: string;
  test_category: string;
  department: string;
  sample_type?: string;
  price?: number;
  billing_mode?: 'patient' | 'admission';
  priority: 'urgent' | 'routine';
  status: TestStatus;
  payment_status: string;
  ordered_at: string;
  completed_at?: string;
  queue_position: number;
  notes: string;
  report?: {
    id: string;
    risk_score: number;
    atlas_analysis: string;
    atlas_confidence: string;
    document_id: string;
    submitted_at: string;
    abnormal_fields: string[];
  };
  patients: {
    name: string;
    vela_id: string;
    age: number;
    gender: string;
    blood_group: string;
    allergies: string[];
    atlas_analysis: string;
    atlas_confidence: string;
  };
}

interface TemplateField {
  name: string;
  unit: string;
  normal_min?: number;
  normal_max?: number;
  text_field?: boolean;
}

interface LabTemplate {
  id: string;
  test_type: string;
  department: string;
  sample_type?: string;
  price?: number;
  fields: TemplateField[];
  source: 'custom' | 'catalog';
}

const DEPARTMENT_LABEL: Record<string, string> = {
  pathology: 'Pathology',
  radiology: 'Radiology',
  cardiology: 'Cardiology',
  microbiology: 'Microbiology',
  histopathology: 'Histopathology',
};

// Patient text fields (allergies, conditions) are stored as free text; tolerate lists too.
const toList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean)
  : typeof v === 'string' ? v.split(/[,;]+/).map(x => x.trim()).filter(Boolean)
  : [];

export default function LabController() {
  const socket = useMemo(() => io(SOCKET_URL), []);
  const hospitalId = useMemo(() => localStorage.getItem('vela_hospital_id') || '', []);
  // An independent (non-hospital) lab logs in with its own network_lab_id
  // instead — see plan Phase 3/4. The queue/completed endpoints derive this
  // from the session token server-side (security-critical); it's passed as a
  // query param only for the template endpoints, which aren't patient data.
  const networkLabId = useMemo(() => localStorage.getItem('vela_network_lab_id') || '', []);

  // A department-scoped account only ever sees its own queue; an empty value
  // means this is an unscoped "super lab" login that can switch departments.
  const scopedDepartment = useMemo(() => localStorage.getItem('vela_lab_department') || '', []);
  const isSuperLab = !scopedDepartment;

  const [activeTab, setActiveTab] = useState<'queue' | 'completed' | 'stats' | 'settings'>('queue');
  const [departments, setDepartments] = useState<{ id: string; name: string; description: string }[]>([]);
  const [activeDepartment, setActiveDepartment] = useState<string>(scopedDepartment);

  const [queue, setQueue] = useState<LabOrder[]>([]);
  const [completed, setCompleted] = useState<LabOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<LabOrder | null>(null);
  const [filter, setFilter] = useState<'all' | 'payment_confirmed' | 'accepted' | 'in_progress'>('all');

  // Report entry
  const [template, setTemplate] = useState<{ fields: TemplateField[]; source: string; instructions: string } | null>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [labNotes, setLabNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Report formats (Settings)
  const [templates, setTemplates] = useState<LabTemplate[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDepartment, setDraftDepartment] = useState(scopedDepartment || 'pathology');
  const [draftPrice, setDraftPrice] = useState('');
  const [draftFields, setDraftFields] = useState<TemplateField[]>([
    { name: '', unit: '', normal_min: 0, normal_max: 0, text_field: false },
  ]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const deptQuery = useCallback(
    (extra = '') => {
      const params = new URLSearchParams();
      if (networkLabId) params.set('network_lab_id', networkLabId);
      if (hospitalId) params.set('hospital_id', hospitalId);
      // A scoped account's department is enforced server-side too — this is
      // only so the super-lab view can switch tabs.
      if (activeDepartment) params.set('department', activeDepartment);
      const qs = params.toString();
      return `${extra}${qs ? (extra.includes('?') ? '&' : '?') + qs : ''}`;
    },
    [hospitalId, activeDepartment, networkLabId]
  );

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}${deptQuery('/api/lab/orders')}`);
      const data = await res.json();
      if (data.status === 'success') setQueue(data.orders || []);
    } catch (err) {
      console.error('Queue fetch error:', err);
    }
  }, [deptQuery]);

  const fetchCompleted = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}${deptQuery('/api/lab/orders/completed')}`);
      const data = await res.json();
      if (data.status === 'success') setCompleted(data.orders || []);
    } catch (err) {
      console.error('Completed fetch error:', err);
    }
  }, [deptQuery]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}${deptQuery('/api/lab/templates')}`);
      const data = await res.json();
      if (data.status === 'success') setTemplates(data.templates || []);
    } catch (err) {
      console.error('Templates fetch error:', err);
    }
  }, [deptQuery]);

  useEffect(() => {
    fetch(`${API_URL}/api/lab/departments`)
      .then((r) => r.json())
      .then((d) => setDepartments(d.departments || []))
      .catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    fetchQueue();
    fetchCompleted();
  }, [fetchQueue, fetchCompleted]);

  useEffect(() => {
    if (activeTab === 'settings') fetchTemplates();
  }, [activeTab, fetchTemplates]);

  useEffect(() => {
    const onPaid = (data: any) => {
      // Only surface work this lab is actually responsible for.
      if (activeDepartment && data.department && data.department !== activeDepartment) return;
      // Paid, but the patient still has to be checked in at the counter — this
      // is a heads-up, not work. `onArrived` is what puts it in the queue.
      toast(`${data.patient_name} — paid, on their way`, { icon: '💳' });
    };
    const onArrived = (data: any) => {
      if (activeDepartment && data.department && data.department !== activeDepartment) return;
      toast.success(`${data.patient_name} has arrived — ${data.test_type}`);
      fetchQueue();
    };
    const onOrdered = (data: any) => {
      const depts: string[] = data.departments || [];
      if (activeDepartment && depts.length && !depts.includes(activeDepartment)) return;
      toast(`New order: ${(data.tests || []).join(', ')}`, {
        icon: '🔬',
        style: { background: '#fff', color: 'var(--text)', border: '0.5px solid rgba(0,0,0,0.1)', borderRadius: 14 },
      });
      fetchQueue();
    };
    const onQueue = () => fetchQueue();
    const onTemplates = () => { if (activeTab === 'settings') fetchTemplates(); };

    socket.on('payment_confirmed', onPaid);
    socket.on('lab_order_arrived', onArrived);
    socket.on('test_ordered', onOrdered);
    socket.on('queue_updated', onQueue);
    socket.on('lab_template_updated', onTemplates);
    socket.on('lab_catalog_updated', onTemplates);
    return () => {
      socket.off('payment_confirmed', onPaid);
      socket.off('lab_order_arrived', onArrived);
      socket.off('test_ordered', onOrdered);
      socket.off('queue_updated', onQueue);
      socket.off('lab_template_updated', onTemplates);
      socket.off('lab_catalog_updated', onTemplates);
    };
  }, [socket, activeDepartment, activeTab, fetchQueue, fetchTemplates]);

  const loadTemplate = async (order: LabOrder) => {
    try {
      const params = networkLabId ? `?network_lab_id=${networkLabId}` : hospitalId ? `?hospital_id=${hospitalId}` : '';
      const res = await fetch(`${API_URL}/api/lab/template/${encodeURIComponent(order.test_type)}${params}`);
      const data = await res.json();
      setTemplate(data);
      const initial: Record<string, any> = {};
      (data.fields || []).forEach((f: TemplateField) => {
        initial[f.name] = f.text_field ? '' : undefined;
      });
      setFormValues(initial);
      setLabNotes('');
    } catch {
      toast.error('Failed to load report format');
    }
  };

  useEffect(() => {
    if (selectedOrder?.status === 'in_progress') loadTemplate(selectedOrder);
    else setTemplate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder?.id, selectedOrder?.status]);

  const handleAction = async (action: 'accept' | 'start') => {
    if (!selectedOrder) return;
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${selectedOrder.id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') {
        toast.success(action === 'accept' ? 'Case accepted' : 'Diagnostic cycle started');
        setSelectedOrder({ ...selectedOrder, ...data.order });
        fetchQueue();
      } else {
        toast.error(data.message || `Could not ${action} test`);
      }
    } catch {
      toast.error(`Failed to ${action} test`);
    }
  };

  // "Next patient" — after filing a report, jump straight to the next queued
  // order instead of dumping the tech back at the bare list. Mirrors the
  // doctor's callNext()/next-patient flow so the loop is fill → submit → next.
  const goToNextOrder = (justSubmittedId: string) => {
    const remaining = queue.filter((o) => o.id !== justSubmittedId);
    const currentIndex = queue.findIndex((o) => o.id === justSubmittedId);
    const next =
      queue.slice(currentIndex + 1).find((o) => o.id !== justSubmittedId) ||
      remaining[0] ||
      null;
    setSelectedOrder(next);
    setTemplate(null);
    if (!next) toast('No more patients waiting in the queue', { icon: 'ℹ️' });
  };

  const submitReport = async () => {
    if (!selectedOrder || !template) return;

    const missing = template.fields.filter(
      (f) => formValues[f.name] === undefined || formValues[f.name] === ''
    );
    if (missing.length && !window.confirm(
      `${missing.length} field(s) are empty and will be omitted from the report. Submit anyway?`
    )) return;

    setIsSubmitting(true);
    const normalRanges: Record<string, any> = {};
    const units: Record<string, string> = {};
    template.fields.forEach((f) => {
      if (!f.text_field) normalRanges[f.name] = { min: f.normal_min, max: f.normal_max };
      if (f.unit) units[f.name] = f.unit;
    });

    const values = Object.fromEntries(
      Object.entries(formValues).filter(([, v]) => v !== undefined && v !== '')
    );

    try {
      const res = await fetch(`${API_URL}/api/lab/reports/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_order_id: selectedOrder.id,
          patient_id: selectedOrder.patient_id,
          test_type: selectedOrder.test_type,
          test_category: selectedOrder.test_category,
          department: selectedOrder.department,
          values,
          normal_ranges: normalRanges,
          units,
          lab_notes: labNotes,
          doctor_name: localStorage.getItem('vela_staff_name') || 'Lab Technician',
        }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        const flagged = (data.abnormal_fields || []).length;
        toast.success(
          flagged
            ? `Report filed — ${flagged} abnormal value${flagged > 1 ? 's' : ''} flagged`
            : 'Report filed — all values normal',
          { duration: 5000 }
        );
        goToNextOrder(selectedOrder.id);
        fetchQueue();
        fetchCompleted();
      } else {
        toast.error(data.message || 'Submission failed');
      }
    } catch {
      toast.error('Submission failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Report format editor ──
  const openEditor = () => {
    setDraftName('');
    setDraftDepartment(scopedDepartment || 'pathology');
    setDraftPrice('');
    setDraftFields([{ name: '', unit: '', normal_min: 0, normal_max: 0, text_field: false }]);
    setEditorOpen(true);
  };

  const updateDraftField = (index: number, patch: Partial<TemplateField>) => {
    setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const saveTemplate = async () => {
    const named = draftFields.filter((f) => f.name.trim());
    if (!draftName.trim()) return toast.error('Give the test a name');
    if (!named.length) return toast.error('Add at least one named field');

    setSavingTemplate(true);
    try {
      const res = await fetch(`${API_URL}/api/lab/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hospital_id: hospitalId,
          network_lab_id: networkLabId || undefined,
          test_type: draftName.trim(),
          department: draftDepartment,
          price: draftPrice ? parseFloat(draftPrice) : undefined,
          fields: named,
          created_by: localStorage.getItem('vela_staff_name') || 'Lab',
        }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        toast.success(`Format saved for ${draftName.trim()}`);
        setEditorOpen(false);
        fetchTemplates();
      } else {
        toast.error(data.message || 'Could not save format');
      }
    } catch {
      toast.error('Could not save format');
    } finally {
      setSavingTemplate(false);
    }
  };

  const deleteTemplate = async (t: LabTemplate) => {
    if (!window.confirm(`Delete the custom format for ${t.test_type}?`)) return;
    try {
      const res = await fetch(`${API_URL}/api/lab/templates/${t.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status === 'success') {
        toast.success('Format deleted');
        fetchTemplates();
      } else {
        toast.error(data.message || 'Could not delete');
      }
    } catch {
      toast.error('Could not delete');
    }
  };

  const filteredQueue = queue.filter((o) => (filter === 'all' ? true : o.status === filter));
  const departmentTitle = activeDepartment
    ? DEPARTMENT_LABEL[activeDepartment] || activeDepartment
    : 'All Departments';

  const stats = useMemo(() => {
    const abnormal = completed.filter((c) => (c.report?.abnormal_fields || []).length > 0).length;
    const highRisk = completed.filter((c) => (c.report?.risk_score || 0) > 70).length;
    return { pending: queue.length, done: completed.length, abnormal, highRisk };
  }, [queue, completed]);

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col font-sans">
      {/* NAVBAR */}
      <nav className="h-[56px] border-b border-black/10 flex items-center justify-between px-6 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <img src="/vela-icon.png" alt="Vela" style={{ height: 28, width: 'auto', objectFit: 'contain' }} />
            <span className="text-xl font-bold tracking-tight text-brand">VELA</span>
          </div>
          <div className="h-4 w-[1px] bg-black/10"></div>
          <span className="text-sm font-medium text-ink">Laboratory</span>
          <span className="px-2 py-0.5 rounded-full bg-brand/10 border border-brand/30 text-[10px] font-bold uppercase tracking-widest text-brand">
            {departmentTitle}
          </span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-ink-2">
            <Clock size={14} />
            <span className="text-xs font-mono">{new Date().toLocaleTimeString()}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Activity size={20} className="text-ink-2" />
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-brand text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {queue.length}
              </span>
            </div>
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-black/10 text-xs font-medium hover:bg-black/5 transition-colors">
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="w-[56px] border-r border-black/5 flex flex-col items-center py-6 gap-6 bg-canvas">
          {([
            ['queue', Flask],
            ['completed', Check],
            ['stats', Chart],
            ['settings', Settings],
          ] as const).map(([tab, Icon]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              title={tab}
              className={`p-2 rounded-xl transition-all ${activeTab === tab ? 'bg-brand text-white' : 'text-ink-3 hover:text-ink hover:bg-black/5'}`}
            >
              <Icon size={20} />
            </button>
          ))}
        </aside>

        <main className="flex-1 flex overflow-hidden">
          {/* ── QUEUE ── */}
          {activeTab === 'queue' && (
            <>
              <div className="w-[320px] border-r border-black/5 flex flex-col bg-canvas">
                <div className="p-6 pb-0">
                  <h2 className="text-2xl font-serif text-ink mb-1">Test Queue</h2>
                  <div className="text-[11px] font-mono text-brand uppercase tracking-widest mb-4">
                    {queue.length} Awaiting Processing
                  </div>

                  {/* Department switcher — only for unscoped supervisor accounts.
                      An independent network lab has no hospital departments to
                      switch between; its queue is already scoped to itself. */}
                  {isSuperLab && !networkLabId && departments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      <button
                        onClick={() => setActiveDepartment('')}
                        className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider border transition-all ${!activeDepartment ? 'bg-black/10 text-ink border-black/20' : 'bg-transparent text-ink-3 border-black/10 hover:border-black/15'}`}
                      >
                        All
                      </button>
                      {departments.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => setActiveDepartment(d.id)}
                          className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider border transition-all ${activeDepartment === d.id ? 'bg-black/10 text-ink border-black/20' : 'bg-transparent text-ink-3 border-black/10 hover:border-black/15'}`}
                        >
                          {d.name}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 mb-6">
                    {(['all', 'payment_confirmed', 'accepted', 'in_progress'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setFilter(t)}
                        className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${filter === t ? 'bg-brand text-white border-brand' : 'bg-transparent text-ink-3 border-black/10 hover:border-black/15'}`}
                      >
                        {t === 'in_progress' ? 'Running' : t === 'payment_confirmed' ? 'New' : t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2">
                  {filteredQueue.length === 0 && (
                    <div className="text-center py-16 text-ink-3 font-light italic text-sm px-4">
                      {queue.length === 0
                        ? `No tests waiting in ${departmentTitle.toLowerCase()}.`
                        : 'No tests match this filter.'}
                    </div>
                  )}
                  {filteredQueue.map((order) => (
                    <div
                      key={order.id}
                      onClick={() => setSelectedOrder(order)}
                      className={`p-4 rounded-xl border transition-all cursor-pointer group ${selectedOrder?.id === order.id ? 'bg-brand-tint border-brand/40' : 'bg-white border-black/5 hover:border-black/15'}`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-brand flex items-center justify-center text-white text-[10px] font-bold font-mono">
                            #{order.queue_position || '?'}
                          </div>
                          <span className="text-xs font-semibold">{order.patients?.name || 'Patient'}</span>
                        </div>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${order.priority === 'urgent' ? 'bg-danger/20 text-danger' : 'bg-black/5 text-ink-3'}`}>
                          {(order.priority || 'routine').toUpperCase()}
                        </span>
                      </div>

                      <div className="space-y-1 mb-3">
                        <div className="text-[13px] text-ink flex items-center gap-2">
                          <Beaker size={12} className="text-brand" />
                          {order.test_type}
                        </div>
                        <div className="text-[10px] font-mono text-brand/60">{order.patients?.vela_id}</div>
                        <div className="text-[11px] text-ink-3 flex items-center gap-2">
                          <span>Dr. {order.doctor_name}</span>
                          {order.billing_mode === 'admission' && (
                            <span className="text-[8px] font-bold uppercase tracking-wider text-brand-light bg-brand/10 border border-brand-soft/20 rounded px-1 py-0.5">
                              Inpatient
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-3 border-t border-black/5">
                        <div className="flex items-center gap-1.5">
                          <div className={`w-2 h-2 rounded-full ${order.status === 'in_progress' ? 'bg-brand animate-pulse' : order.status === 'accepted' ? 'bg-brand' : 'bg-warning'}`}></div>
                          <span className="text-[10px] font-medium text-ink-2 capitalize">
                            {order.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-ink-3">
                          {order.ordered_at ? `${formatDistanceToNow(new Date(order.ordered_at))} ago` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ACTION PANEL */}
              <div className="flex-1 bg-canvas overflow-y-auto p-12">
                {!selectedOrder ? (
                  <div className="h-full flex flex-col items-center justify-center text-ink-3 gap-4">
                    <Flask size={64} strokeWidth={1} />
                    <p className="text-lg font-light">Select a test from the queue to begin</p>
                  </div>
                ) : (
                  <div className="max-w-4xl mx-auto space-y-12">
                    {/* PATIENT HEADER */}
                    <div className="relative p-8 rounded-3xl overflow-hidden bg-gradient-to-br from-brand-dark/20 to-brand-dark/20 border border-black/10 ring-1 ring-black/5">
                      <div className="absolute top-0 right-0 p-8 text-ink-3">
                        <QrCode size={120} />
                      </div>
                      <div className="relative z-10 flex flex-col md:flex-row gap-8 items-start">
                        <div className="w-20 h-20 rounded-2xl bg-black/5 border border-black/15 flex items-center justify-center">
                          <User size={40} className="text-ink-2" />
                        </div>
                        <div className="space-y-4 flex-1">
                          <div>
                            <h1 className="text-4xl font-serif tracking-tight mb-2">{selectedOrder.patients?.name || 'Patient'}</h1>
                            <div className="flex flex-wrap gap-4 text-sm font-mono text-ink-3">
                              <span className="text-brand">{selectedOrder.patients?.vela_id}</span>
                              <span>{selectedOrder.patients?.age}Y • {selectedOrder.patients?.gender}</span>
                              <span>Blood: {selectedOrder.patients?.blood_group}</span>
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            {toList(selectedOrder.patients?.allergies).map((a: string) => (
                              <span key={a} className="px-3 py-1 bg-danger/10 text-danger border border-danger-soft/20 rounded-full text-xs font-medium">
                                {a}
                              </span>
                            ))}
                          </div>

                          {selectedOrder.patients?.atlas_analysis && (
                            <div className="p-4 bg-white border border-black/10 rounded-2xl space-y-2">
                              <div className="flex items-center gap-2 text-[10px] font-bold text-brand uppercase tracking-widest">
                                <Activity size={12} />
                                Atlas Clinical Insight
                              </div>
                              <p className="text-sm text-ink leading-relaxed italic">
                                "{selectedOrder.patients?.atlas_analysis}"
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* TEST DETAILS */}
                    <div className="space-y-8">
                      <div className="flex items-end justify-between border-b border-black/10 pb-6">
                        <div>
                          <div className="text-[12px] font-mono text-brand uppercase tracking-[0.2em] mb-2">
                            {DEPARTMENT_LABEL[selectedOrder.department] || selectedOrder.department}
                            {selectedOrder.sample_type ? ` • ${selectedOrder.sample_type}` : ''}
                          </div>
                          <h2 className="text-5xl font-serif leading-tight">{selectedOrder.test_type}</h2>
                        </div>
                        <div className="text-right space-y-2">
                          <div className="text-sm text-ink-3 font-mono">Ordered by Dr. {selectedOrder.doctor_name}</div>
                          <div className={`inline-flex px-4 py-1.5 rounded-full text-xs font-bold border ${selectedOrder.priority === 'urgent' ? 'bg-danger/20 text-danger border-danger-soft/30' : 'bg-white text-ink-3 border-black/10'}`}>
                            {(selectedOrder.priority || 'routine').toUpperCase()} PRIORITY
                          </div>
                          {selectedOrder.billing_mode === 'admission' && (
                            <div className="text-[10px] font-mono text-brand-light uppercase tracking-widest">
                              Billed to admission
                            </div>
                          )}
                          {queue.length > 1 && (
                            <button
                              onClick={() => goToNextOrder(selectedOrder.id)}
                              className="text-[10px] font-mono uppercase tracking-widest text-ink-3 hover:text-brand transition-colors"
                            >
                              Skip to next patient →
                            </button>
                          )}
                        </div>
                      </div>

                      {selectedOrder.notes && (
                        <div className="p-6 bg-white border border-black/5 rounded-2xl">
                          <h4 className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-3">Orders & Notes</h4>
                          <p className="text-ink leading-relaxed font-light">{selectedOrder.notes}</p>
                        </div>
                      )}

                      {/* LIFECYCLE ACTIONS */}
                      <div className="flex gap-4">
                        {selectedOrder.status === 'payment_confirmed' && (
                          <button
                            onClick={() => handleAction('accept')}
                            className="flex-1 group relative h-16 bg-brand text-white font-bold rounded-2xl overflow-hidden active:scale-[0.98] transition-all"
                          >
                            <div className="absolute inset-0 bg-black/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                            <div className="relative flex items-center justify-center gap-3">
                              <Check size={24} />
                              <span>Accept Case for Processing</span>
                            </div>
                          </button>
                        )}
                        {selectedOrder.status === 'accepted' && (
                          <button
                            onClick={() => handleAction('start')}
                            className="flex-1 group relative h-16 bg-brand text-white font-bold rounded-2xl overflow-hidden active:scale-[0.98] transition-all"
                          >
                            <div className="absolute inset-0 bg-black/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                            <div className="relative flex items-center justify-center gap-3">
                              <Play size={24} fill="currentColor" />
                              <span>Initiate Diagnostic Cycle</span>
                            </div>
                          </button>
                        )}
                      </div>

                      {/* REPORT FORM */}
                      {selectedOrder.status === 'in_progress' && (
                        <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="text-3xl font-serif">Diagnostic Results Entry</h3>
                              {template && (
                                <p className="text-[10px] font-mono uppercase tracking-widest text-ink-3 mt-2">
                                  {template.source === 'custom'
                                    ? 'Using this lab’s own saved format'
                                    : template.source === 'catalog'
                                    ? 'Standard format for this test'
                                    : 'Generic format — no saved layout for this test'}
                                </p>
                              )}
                            </div>
                            <div className="px-4 py-2 bg-brand/10 border border-brand-soft/20 rounded-xl flex items-center gap-3">
                              <div className="w-2 h-2 rounded-full bg-brand animate-ping"></div>
                              <span className="text-xs font-bold text-brand-light uppercase tracking-widest">Session Active</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
                            {(template?.fields ?? []).map((field) => {
                              const val = formValues[field.name];
                              const hasVal = val !== undefined && val !== '' && !Number.isNaN(val);
                              const min = field.normal_min ?? 0;
                              const max = field.normal_max ?? 0;
                              const isAbnormal = !field.text_field && hasVal && (val < min || val > max);
                              const width = max - min;
                              const deviation = !field.text_field && hasVal ? (val < min ? min - val : val - max) : 0;
                              const isCritical = isAbnormal && width > 0 && (deviation / width) * 100 > 50;

                              return (
                                <div key={field.name} className="space-y-4">
                                  <div className="flex justify-between items-end">
                                    <label className="text-sm font-medium text-ink-2">{field.name}</label>
                                    {!field.text_field && (
                                      <span className="text-[10px] font-mono text-ink-3">
                                        Normal: {min} - {max} {field.unit}
                                      </span>
                                    )}
                                  </div>

                                  <div className="relative group">
                                    <input
                                      type={field.text_field ? 'text' : 'number'}
                                      placeholder={field.text_field ? 'Details...' : '0.00'}
                                      value={val ?? ''}
                                      onChange={(e) =>
                                        setFormValues((prev) => ({
                                          ...prev,
                                          [field.name]: field.text_field
                                            ? e.target.value
                                            : e.target.value === ''
                                            ? undefined
                                            : parseFloat(e.target.value),
                                        }))
                                      }
                                      className={`w-full bg-white border rounded-xl px-4 py-4 text-xl outline-none transition-all focus:bg-black/5 focus:ring-1 ${isCritical ? 'border-danger-soft focus:ring-danger-soft shadow-[0_0_15px_-3px_rgba(239,68,68,0.3)]' : isAbnormal ? 'border-warning-soft focus:ring-warning-soft' : 'border-black/10 focus:ring-brand'}`}
                                    />
                                    {!field.text_field && hasVal && (
                                      <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                                        {isCritical ? (
                                          <div className="flex items-center gap-1.5 text-danger">
                                            <AlertTriangle size={16} />
                                            <span className="text-[10px] font-black uppercase tracking-tighter">Critical</span>
                                          </div>
                                        ) : isAbnormal ? (
                                          <div className="flex items-center gap-1.5 text-warning">
                                            <AlertTriangle size={16} />
                                            <span className="text-[10px] font-black uppercase tracking-tighter">Abnormal</span>
                                          </div>
                                        ) : (
                                          <Check size={18} className="text-brand" />
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}

                            <div className="md:col-span-2 space-y-4">
                              <label className="text-sm font-medium text-ink-2">Lab Technician Observations</label>
                              <textarea
                                rows={4}
                                value={labNotes}
                                onChange={(e) => setLabNotes(e.target.value)}
                                placeholder="Add any visual observations or equipment flags..."
                                className="w-full bg-white border border-black/10 rounded-2xl px-6 py-4 text-ink outline-none focus:bg-black/5 transition-all focus:ring-1 focus:ring-brand"
                              />
                            </div>
                          </div>

                          <div className="pt-8">
                            <button
                              disabled={isSubmitting}
                              onClick={submitReport}
                              className="w-full h-20 bg-brand text-white font-black rounded-3xl flex items-center justify-center gap-4 text-xl active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed group shadow-2xl shadow-brand/10"
                            >
                              {isSubmitting ? (
                                <>
                                  <RefreshCw size={24} className="animate-spin" />
                                  Filing Report...
                                </>
                              ) : (
                                <>
                                  <Send size={24} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                                  Commit Final Report
                                </>
                              )}
                            </button>
                            <p className="text-center text-ink-3 text-[10px] font-mono mt-4 uppercase tracking-[0.3em]">
                              Report is filed to the patient record on submission
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── COMPLETED ── */}
          {activeTab === 'completed' && (
            <div className="flex-1 p-12 bg-canvas overflow-y-auto">
              <div className="max-w-5xl mx-auto space-y-8">
                <div className="flex items-end justify-between">
                  <h2 className="text-4xl font-serif">Processed Cases</h2>
                  <span className="text-[11px] font-mono uppercase tracking-widest text-ink-3">
                    {departmentTitle}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  {completed.map((order) => {
                    const risk = order.report?.risk_score ?? 0;
                    const flagged = order.report?.abnormal_fields || [];
                    const riskLabel = risk > 70 ? 'High Risk' : risk > 30 ? 'Moderate' : 'Low Risk';
                    const riskColor = risk > 70 ? 'text-danger' : risk > 30 ? 'text-warning' : 'text-brand-light';
                    return (
                      <div key={order.id} className="bg-white border border-black/10 rounded-2xl p-6 hover:bg-white/[0.07] transition-all">
                        <div className="flex items-center justify-between gap-6">
                          <div className="flex items-center gap-6 min-w-0">
                            <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center text-brand shrink-0">
                              <FileText size={24} />
                            </div>
                            <div className="min-w-0">
                              <h4 className="text-lg font-medium truncate">{order.patients?.name || 'Patient'}</h4>
                              <div className="text-sm text-ink-3 truncate">
                                {order.test_type}
                                {order.completed_at && ` • ${formatDistanceToNow(new Date(order.completed_at))} ago`}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-8 shrink-0">
                            <div className="text-right">
                              <div className="text-[10px] font-mono text-ink-3 uppercase tracking-widest mb-1">Risk Profile</div>
                              <div className={`text-xl font-bold ${riskColor}`}>{riskLabel}</div>
                            </div>
                            {order.report?.document_id && (
                              <button
                                onClick={async () => {
                                  const r = await openGeneratedDocument(
                                    order.report!.document_id,
                                    `${order.test_type} - ${order.patients?.name || 'patient'}.pdf`
                                  );
                                  if (!r.ok) toast.error(r.message || 'Could not open report');
                                }}
                                title="Open report PDF"
                                className="p-3 rounded-full bg-white border border-black/10 hover:bg-brand hover:text-black transition-all"
                              >
                                <Download size={20} />
                              </button>
                            )}
                          </div>
                        </div>

                        {flagged.length > 0 && (
                          <div className="mt-4 pt-4 border-t border-black/5 flex flex-wrap gap-2">
                            {flagged.map((f) => (
                              <span key={f} className="px-2.5 py-1 rounded-full bg-warning/10 border border-warning-soft/20 text-warning text-[10px] font-bold uppercase tracking-wider">
                                {f}
                              </span>
                            ))}
                          </div>
                        )}

                        {order.report?.atlas_analysis && (
                          <p className="mt-4 text-sm text-ink-2 italic leading-relaxed">
                            "{order.report.atlas_analysis}"
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {completed.length === 0 && (
                    <div className="text-center py-20 text-ink-3 font-light italic">
                      No cases completed in this cycle yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── STATS ── */}
          {activeTab === 'stats' && (
            <div className="flex-1 p-12 bg-canvas overflow-y-auto">
              <div className="max-w-4xl mx-auto space-y-10">
                <h2 className="text-4xl font-serif">{departmentTitle} Overview</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    ['In Queue', stats.pending, 'text-brand'],
                    ['Completed', stats.done, 'text-brand-light'],
                    ['With Abnormalities', stats.abnormal, 'text-warning'],
                    ['High Risk', stats.highRisk, 'text-danger'],
                  ].map(([label, value, color]) => (
                    <div key={label as string} className="bg-white border border-black/10 rounded-2xl p-6">
                      <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3 mb-3">{label}</div>
                      <div className={`text-4xl font-bold ${color}`}>{value as number}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── SETTINGS / REPORT FORMATS ── */}
          {activeTab === 'settings' && (
            <div className="flex-1 p-12 bg-canvas overflow-y-auto">
              <div className="max-w-5xl mx-auto space-y-8">
                <div className="flex items-end justify-between gap-6">
                  <div>
                    <h2 className="text-4xl font-serif mb-2">Report Formats</h2>
                    <p className="text-ink-3 font-light max-w-xl">
                      Standard formats come built in. Add your own for tests this lab performs
                      that aren’t covered — a saved format is offered automatically the next
                      time that test is ordered.
                    </p>
                  </div>
                  <button
                    onClick={openEditor}
                    className="shrink-0 flex items-center gap-2 px-5 py-3 rounded-2xl bg-brand text-white font-bold text-sm active:scale-[0.98] transition-all"
                  >
                    <Plus size={18} />
                    New Format
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {templates.map((t) => (
                    <div key={t.id} className="bg-white border border-black/10 rounded-2xl p-6 space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="text-lg font-medium truncate">{t.test_type}</h4>
                            {t.source === 'custom' && (
                              <span className="text-[8px] font-bold uppercase tracking-wider text-brand bg-brand/10 border border-brand/30 rounded px-1.5 py-0.5 shrink-0">
                                Custom
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3">
                            {DEPARTMENT_LABEL[t.department] || t.department}
                            {t.price ? ` • ₹${t.price}` : ''}
                          </div>
                        </div>
                        {t.source === 'custom' && (
                          <button
                            onClick={() => deleteTemplate(t)}
                            title="Delete format"
                            className="text-danger/50 hover:text-danger transition-colors shrink-0"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {t.fields.slice(0, 8).map((f) => (
                          <span key={f.name} className="px-2 py-0.5 rounded bg-white border border-black/10 text-[10px] text-ink-2">
                            {f.name}
                          </span>
                        ))}
                        {t.fields.length > 8 && (
                          <span className="px-2 py-0.5 text-[10px] text-ink-3">+{t.fields.length - 8} more</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {templates.length === 0 && (
                    <div className="md:col-span-2 text-center py-20 text-ink-3 font-light italic">
                      Loading report formats…
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── FORMAT EDITOR MODAL ── */}
      {editorOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-canvas border border-black/10 rounded-3xl w-full max-w-3xl max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-canvas border-b border-black/10 px-8 py-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Layers size={20} className="text-brand" />
                <h3 className="text-2xl font-serif">New Report Format</h3>
              </div>
              <button onClick={() => setEditorOpen(false)} className="text-ink-3 hover:text-ink transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="p-8 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-1 space-y-2">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-ink-3">Test Name</label>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="e.g. Serum Ferritin"
                    className="w-full bg-white border border-black/10 rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-ink-3">Department</label>
                  <select
                    value={draftDepartment}
                    onChange={(e) => setDraftDepartment(e.target.value)}
                    disabled={!isSuperLab}
                    className="w-full bg-white border border-black/10 rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
                  >
                    {(departments.length ? departments : Object.keys(DEPARTMENT_LABEL).map((id) => ({ id, name: DEPARTMENT_LABEL[id] }))).map((d: any) => (
                      <option key={d.id} value={d.id} className="bg-canvas">{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-ink-3">Price (₹)</label>
                  <input
                    type="number"
                    value={draftPrice}
                    onChange={(e) => setDraftPrice(e.target.value)}
                    placeholder="500"
                    className="w-full bg-white border border-black/10 rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-ink-3">Fields</label>
                  <button
                    onClick={() => setDraftFields((p) => [...p, { name: '', unit: '', normal_min: 0, normal_max: 0, text_field: false }])}
                    className="flex items-center gap-1.5 text-[11px] font-bold text-brand hover:text-ink transition-colors"
                  >
                    <Plus size={14} /> Add field
                  </button>
                </div>

                <div className="space-y-3">
                  {draftFields.map((f, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        value={f.name}
                        onChange={(e) => updateDraftField(i, { name: e.target.value })}
                        placeholder="Parameter name"
                        className="col-span-4 bg-white border border-black/10 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-brand"
                      />
                      <input
                        value={f.unit}
                        onChange={(e) => updateDraftField(i, { unit: e.target.value })}
                        placeholder="Unit"
                        className="col-span-2 bg-white border border-black/10 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-brand"
                      />
                      <input
                        type="number"
                        value={f.text_field ? '' : f.normal_min ?? ''}
                        disabled={f.text_field}
                        onChange={(e) => updateDraftField(i, { normal_min: parseFloat(e.target.value) })}
                        placeholder="Min"
                        className="col-span-2 bg-white border border-black/10 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-brand disabled:opacity-30"
                      />
                      <input
                        type="number"
                        value={f.text_field ? '' : f.normal_max ?? ''}
                        disabled={f.text_field}
                        onChange={(e) => updateDraftField(i, { normal_max: parseFloat(e.target.value) })}
                        placeholder="Max"
                        className="col-span-2 bg-white border border-black/10 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-brand disabled:opacity-30"
                      />
                      <label className="col-span-1 flex items-center justify-center gap-1 text-[9px] font-mono uppercase text-ink-3 cursor-pointer" title="Free-text field (no numeric range)">
                        <input
                          type="checkbox"
                          checked={!!f.text_field}
                          onChange={(e) => updateDraftField(i, { text_field: e.target.checked })}
                          className="accent-brand"
                        />
                        Text
                      </label>
                      <button
                        onClick={() => setDraftFields((p) => p.filter((_, idx) => idx !== i))}
                        className="col-span-1 text-danger/40 hover:text-danger transition-colors flex justify-center"
                        title="Remove field"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-ink-3 font-mono">
                  Tick “Text” for observations like impressions or findings that have no numeric range.
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setEditorOpen(false)}
                  className="px-6 py-3 rounded-2xl border border-black/10 text-ink-2 hover:text-ink hover:bg-black/5 transition-all text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={saveTemplate}
                  disabled={savingTemplate}
                  className="flex-1 py-3 rounded-2xl bg-brand text-white font-bold active:scale-[0.99] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {savingTemplate ? <RefreshCw size={18} className="animate-spin" /> : <Check size={18} />}
                  Save Format
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
