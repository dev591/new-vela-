import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import mapboxgl from 'mapbox-gl';
import toast from 'react-hot-toast';
import { API_URL } from '../utils/config';
export default function VelaOwner() {
  const navigate = useNavigate();
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [showTC, setShowTC] = useState(false);
  const [showOnboarderInfo, setShowOnboarderInfo] = useState(false);
  const [onboarderName, setOnboarderName] = useState('');
  const [selectedPin, setSelectedPin] = useState<any>(null);
  const [viewingHospital, setViewingHospital] = useState<any>(null);
  const [newCredentials, setNewCredentials] = useState<any>(null);
  const [isOnboarding, setIsOnboarding] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<mapboxgl.Map | null>(null);
  const statsRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // Hospital search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<any>(null);

  // Provider Network — independent labs & solo doctors, onboarded directly
  // through Vela (never through a hospital manager, see plan decision #1).
  const [providerType, setProviderType] = useState<'lab' | 'doctor'>('lab');
  const [providerQuery, setProviderQuery] = useState('');
  const [providerResults, setProviderResults] = useState<any[]>([]);
  const [providerSearching, setProviderSearching] = useState(false);
  const [providerPin, setProviderPin] = useState<any>(null);
  const providerSearchTimeout = useRef<any>(null);
  const [contactName, setContactName] = useState('');
  const [labDepartments, setLabDepartments] = useState<string[]>([]);
  const [labDepartmentInput, setLabDepartmentInput] = useState('');
  const [doctorSpecialization, setDoctorSpecialization] = useState('');
  const [doctorFee, setDoctorFee] = useState('');
  const [doctorLicense, setDoctorLicense] = useState('');
  const [providerRegistering, setProviderRegistering] = useState(false);
  const [providerCredentials, setProviderCredentials] = useState<any>(null);
  const [networkLabs, setNetworkLabs] = useState<any[]>([]);
  const [networkDoctors, setNetworkDoctors] = useState<any[]>([]);
  const [verifyingDoctorId, setVerifyingDoctorId] = useState<string | null>(null);

  useEffect(() => {
    // The flag alone isn't a session: without a token every owner API call 401s.
    if (localStorage.getItem('vela_owner') === 'true' && localStorage.getItem('vela_token')) setAuthed(true);
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchStats();
    fetchHospitals();
  }, [authed]);

  useEffect(() => {
    if (!authed || !stats) return;
    const targets = [
      { ref: statsRefs.current[0], val: stats.total_hospitals },
      { ref: statsRefs.current[1], val: stats.total_staff },
      { ref: statsRefs.current[2], val: stats.total_patients_today },
      { ref: statsRefs.current[3], val: stats.total_atlas_queries_today },
    ];
    targets.forEach(({ ref, val }) => {
      if (!ref) return;
      gsap.fromTo(ref, { innerText: 0 }, { innerText: val, duration: 2, snap: { innerText: 1 }, ease: 'power1.out' });
    });
  }, [stats, authed]);

  useEffect(() => {
    if (!authed || !mapRef.current || mapInstance.current) return;
    const token = import.meta.env.VITE_MAPBOX_TOKEN || '';
    if (!token) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [78.9629, 20.5937],
      zoom: 4.5,
    });
    mapInstance.current = map;
    map.on('load', () => addHospitalMarkers(map));
  }, [authed, hospitals]);

  const addHospitalMarkers = (map: mapboxgl.Map) => {
    hospitals.forEach(h => {
      if (!h.latitude || !h.longitude) return;
      const el = document.createElement('div');
      el.style.cssText = 'width:32px;height:32px;background:var(--brand);border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--bg);font-size:13px;font-weight:900;cursor:pointer;box-shadow:0 0 12px rgba(0,113,227,0.6);';
      el.innerHTML = 'V';
      new mapboxgl.Marker({ element: el })
        .setLngLat([h.longitude, h.latitude])
        .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<div style="font-family:Geist,sans-serif;padding:4px"><strong>${h.name}</strong><br/><span style="font-size:11px;color:var(--text-secondary)">${h.city}, ${h.state}</span><br/><span style="font-size:10px;color:#0071E3">${h.staff_count} staff · ${h.active_staff} online</span></div>`))
        .addTo(map);
    });
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_URL}/api/owner/stats`);
      const data = await res.json();
      if (data.status === 'success') setStats(data);
    } catch {}
  };

  const fetchHospitals = async () => {
    try {
      const res = await fetch(`${API_URL}/api/owner/hospitals`);
      const data = await res.json();
      if (data.status === 'success') setHospitals(data.hospitals);
    } catch {}
  };

  // Search any hospital in the world — tries Mapbox then Nominatim fallback
  const searchHospitals = async (query: string) => {
    if (!query.trim() || query.length < 3) { setSearchResults([]); return; }
    setSearching(true);
    
    let results: any[] = [];
    
    // 1. Try Mapbox Geocoding (Premium, CORS-enabled, highly reliable)
    const token = import.meta.env.VITE_MAPBOX_TOKEN || '';
    if (token) {
      try {
        const mapboxRes = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=8&types=poi,address&access_token=${token}`
        );
        if (mapboxRes.ok) {
          const mapboxData = await mapboxRes.json();
          results = (mapboxData.features || []).map((f: any) => {
            const context = f.context || [];
            return {
              name: f.text,
              address: f.place_name,
              lat: f.center[1],
              lng: f.center[0],
              place_id: f.id,
              city: context.find((c: any) => c.id.startsWith('place'))?.text || '',
              state: context.find((c: any) => c.id.startsWith('region'))?.text || '',
              country: context.find((c: any) => c.id.startsWith('country'))?.text || '',
            };
          });
        }
      } catch (err) {
        console.warn('Mapbox search error:', err);
      }
    }
    
    // 2. If Mapbox returned nothing or failed, try Nominatim
    if (results.length === 0) {
      try {
        const nominatimRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1&extratags=1`,
          { headers: { 'Accept-Language': 'en', 'User-Agent': 'VelaHealth/1.0' } }
        );
        if (nominatimRes.ok) {
          const nominatimData = await nominatimRes.json();
          results = (nominatimData || []).map((r: any) => ({
            name: r.namedetails?.name || r.display_name.split(',')[0],
            address: r.display_name,
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            place_id: `osm_${r.osm_id}`,
            city: r.address?.city || r.address?.town || r.address?.village || r.address?.county || '',
            state: r.address?.state || '',
            country: r.address?.country || '',
            type: r.type || r.class || '',
          }));
        }
      } catch (err) {
        console.warn('Nominatim search error:', err);
      }
    }

    setSearchResults(results);
    setSearching(false);
  };

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    clearTimeout(searchTimeout.current);
    if (val.length < 2) { setSearchResults([]); return; }
    searchTimeout.current = setTimeout(() => searchHospitals(val), 500);
  };

  const handleSelectResult = (result: any) => {
    setSelectedPin(result);
    setSearchQuery(result.name);
    setSearchResults([]);
    // Fly map to selected hospital
    if (mapInstance.current) {
      mapInstance.current.flyTo({ center: [result.lng, result.lat], zoom: 14, duration: 1200 });
      new mapboxgl.Marker({ color: 'var(--brand)' })
        .setLngLat([result.lng, result.lat])
        .setPopup(new mapboxgl.Popup().setHTML(`<strong>${result.name}</strong><br/>${result.address}`))
        .addTo(mapInstance.current);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/owner/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (data.status === 'success') {
        localStorage.setItem('vela_auth', 'true');
        localStorage.setItem('vela_role', 'vela_owner');
        localStorage.setItem('vela_owner', 'true');
        if (data.token) localStorage.setItem('vela_token', data.token);
        setAuthed(true);
        toast.success(data.message);
      } else {
        toast.error(data.message);
      }
    } catch {
      toast.error('Backend not reachable');
    } finally {
      setLoading(false);
    }
  };

  const handleDirectOnboard = async () => {
    if (!selectedPin) return;
    setIsOnboarding(true);
    try {
      const res = await fetch(`${API_URL}/api/owner/onboard-hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: selectedPin.name,
          address: selectedPin.address,
          city: selectedPin.city,
          state: selectedPin.state,
          latitude: selectedPin.lat,
          longitude: selectedPin.lng,
          mapbox_place_id: selectedPin.place_id,
          manager_name: onboarderName,
          specializations: [], // Manager will fill this later
          total_beds: 100 // Default
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setNewCredentials(data);
        fetchHospitals();
        fetchStats();
      } else {
        toast.error(data.message || 'Onboarding failed');
      }
    } catch {
      toast.error('Connection failed');
    } finally {
      setIsOnboarding(false);
    }
  };

  const fetchProviders = async () => {
    try {
      const [labsRes, doctorsRes] = await Promise.all([
        fetch(`${API_URL}/api/network/labs`),
        fetch(`${API_URL}/api/network/doctors?verified_only=false`),
      ]);
      const labsData = await labsRes.json();
      const doctorsData = await doctorsRes.json();
      if (labsData.status === 'success') setNetworkLabs(labsData.labs || []);
      if (doctorsData.status === 'success') setNetworkDoctors(doctorsData.doctors || []);
    } catch {}
  };

  useEffect(() => {
    if (!authed) return;
    fetchProviders();
  }, [authed]);

  // Same Mapbox → Nominatim fallback as searchHospitals above, kept separate
  // so picking a lab/doctor location never disturbs the hospital map/pin flow.
  const searchProviderLocation = async (query: string) => {
    if (!query.trim() || query.length < 3) { setProviderResults([]); return; }
    setProviderSearching(true);
    let results: any[] = [];
    const token = import.meta.env.VITE_MAPBOX_TOKEN || '';
    if (token) {
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=8&types=poi,address&access_token=${token}`
        );
        if (res.ok) {
          const data = await res.json();
          results = (data.features || []).map((f: any) => ({
            name: f.text,
            address: f.place_name,
            lat: f.center[1],
            lng: f.center[0],
            place_id: f.id,
          }));
        }
      } catch (err) {
        console.warn('Mapbox search error:', err);
      }
    }
    if (results.length === 0) {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`,
          { headers: { 'Accept-Language': 'en', 'User-Agent': 'VelaHealth/1.0' } }
        );
        if (res.ok) {
          const data = await res.json();
          results = (data || []).map((r: any) => ({
            name: r.namedetails?.name || r.display_name.split(',')[0],
            address: r.display_name,
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            place_id: `osm_${r.osm_id}`,
          }));
        }
      } catch (err) {
        console.warn('Nominatim search error:', err);
      }
    }
    setProviderResults(results);
    setProviderSearching(false);
  };

  const handleProviderQueryChange = (val: string) => {
    setProviderQuery(val);
    clearTimeout(providerSearchTimeout.current);
    if (val.length < 2) { setProviderResults([]); return; }
    providerSearchTimeout.current = setTimeout(() => searchProviderLocation(val), 500);
  };

  const addLabDepartment = () => {
    const d = labDepartmentInput.trim().toLowerCase();
    if (!d || labDepartments.includes(d)) return;
    setLabDepartments([...labDepartments, d]);
    setLabDepartmentInput('');
  };

  const registerProvider = async () => {
    if (!providerPin) return toast.error('Search and select a location first');
    if (!contactName.trim()) return toast.error('Enter a contact name');

    setProviderRegistering(true);
    try {
      if (providerType === 'lab') {
        const res = await fetch(`${API_URL}/api/network/labs/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: providerPin.name,
            address: providerPin.address,
            place_id: providerPin.place_id,
            lat: providerPin.lat,
            lng: providerPin.lng,
            departments: labDepartments,
            contact_name: contactName.trim(),
          }),
        });
        const data = await res.json();
        if (data.status !== 'success') throw new Error(data.message || 'Registration failed');
        setProviderCredentials({ ...data, kind: 'lab' });
      } else {
        if (!doctorSpecialization.trim()) throw new Error('Enter a specialization');
        if (!doctorLicense.trim()) throw new Error('Enter a medical license number');
        const res = await fetch(`${API_URL}/api/network/doctors/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: contactName.trim(),
            specialization: doctorSpecialization.trim(),
            address: providerPin.address,
            place_id: providerPin.place_id,
            lat: providerPin.lat,
            lng: providerPin.lng,
            consultation_fee: doctorFee ? Number(doctorFee) : 0,
            license_number: doctorLicense.trim(),
          }),
        });
        const data = await res.json();
        if (data.status !== 'success') throw new Error(data.message || 'Registration failed');
        setProviderCredentials({ ...data, kind: 'doctor' });
      }
      setProviderPin(null);
      setProviderQuery('');
      setContactName('');
      setLabDepartments([]);
      setDoctorSpecialization('');
      setDoctorFee('');
      setDoctorLicense('');
      fetchProviders();
    } catch (err: any) {
      toast.error(err.message || 'Registration failed');
    } finally {
      setProviderRegistering(false);
    }
  };

  const verifyDoctor = async (doctorId: string) => {
    setVerifyingDoctorId(doctorId);
    try {
      const res = await fetch(`${API_URL}/api/network/doctors/${doctorId}/verify`, { method: 'PATCH' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Verification failed');
      toast.success('License verified — this doctor can now log in and receive patients');
      fetchProviders();
    } catch (err: any) {
      toast.error(err.message || 'Verification failed');
    } finally {
      setVerifyingDoctorId(null);
    }
  };

  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)' }}>
        <div style={{ width: 360, padding: 48, background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,113,227,0.2)', borderRadius: 20, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 24 }}>VELA COMMAND CENTER</div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 72, color: 'var(--brand)', lineHeight: 1, marginBottom: 8 }}>V</div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 28, color: 'var(--text)', marginBottom: 32 }}>Owner Access</h1>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required
              style={{ background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8, padding: '12px 16px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none' }} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
              style={{ background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8, padding: '12px 16px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none' }} />
            <button type="submit" disabled={loading}
              style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 8, padding: '14px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Authenticating...' : 'Authenticate'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
      {/* Success Credentials Modal */}
      {newCredentials && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 480, width: '100%', background: '#FFFFFF', border: '1px solid var(--brand)', borderRadius: 24, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--brand)', marginBottom: 8 }}>Hospital Active</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>Onboarding complete. Share these owner-generated credentials with the manager.</p>
            
            <div style={{ background: 'rgba(0,113,227,0.06)', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 16, padding: 28, marginBottom: 32, textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 16 }}>Manager Credentials</div>
              
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>MANAGER EMAIL</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{newCredentials.manager_email}</div>
              </div>
              
              <div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>INITIAL PASSWORD</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{newCredentials.manager_password}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button type="button" onClick={() => {
                localStorage.setItem('vela_manager_auth', 'true');
                localStorage.setItem('vela_hospital_id', newCredentials.hospital_id);
                localStorage.setItem('vela_hospital_name', newCredentials.hospital_name);
                localStorage.setItem('vela_manager_name', onboarderName || "Dev Chalana");
                localStorage.setItem('vela_manager_role', 'Medical Director');
                setNewCredentials(null);
                setOnboarderName('');
                setSelectedPin(null);
                navigate('/hospital-manager');
              }} 
                style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', color: 'var(--bg)', cursor: 'pointer', background: 'var(--success)', fontWeight: 700, fontSize: 14 }}>
                ✦ Direct Login to Dashboard
              </button>
              <button type="button" onClick={() => { setNewCredentials(null); setOnboarderName(''); setSelectedPin(null); }} 
                style={{ width: '100%', padding: '14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)', color: 'var(--text)', cursor: 'pointer', background: 'transparent', fontSize: 13 }}>
                Close & View Network
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Provider (Lab/Doctor) Credentials Modal */}
      {providerCredentials && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 480, width: '100%', background: '#FFFFFF', border: '1px solid var(--brand)', borderRadius: 24, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>{providerCredentials.kind === 'lab' ? '🔬' : '🩺'}</div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 36, color: 'var(--brand)', marginBottom: 8 }}>
              {providerCredentials.kind === 'lab' ? 'Lab Active' : 'Doctor Registered'}
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>
              {providerCredentials.message || 'Share these credentials with the provider.'}
            </p>
            <div style={{ background: 'rgba(0,113,227,0.06)', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 16, padding: 28, marginBottom: 32, textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 16 }}>Login Credentials</div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>EMAIL</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{providerCredentials.email}</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>INITIAL PASSWORD</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{providerCredentials.password}</div>
              </div>
            </div>
            {providerCredentials.kind === 'doctor' && (
              <p style={{ color: 'var(--warning)', fontSize: 12, marginBottom: 24 }}>
                Pending license verification — find this doctor in the list below and click "Verify License" before they can log in.
              </p>
            )}
            <button type="button" onClick={() => setProviderCredentials(null)}
              style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', color: '#FFFFFF', cursor: 'pointer', background: 'var(--brand)', fontWeight: 700, fontSize: 14 }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Terms & Conditions Modal */}
      {showTC && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 640, width: '100%', background: '#FFFFFF', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 24, padding: 48, maxHeight: '90vh', overflowY: 'auto' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--brand)', marginBottom: 16 }}>Network Terms</h1>
            <div style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, marginBottom: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <p>By onboarding this hospital to the Vela Network, you acknowledge that you are initiating a clinical synchronization process. Patient data is handled under HIPAA-aligned safeguards (role-based access, access audit logging, session timeouts); each hospital remains responsible for its own regulatory compliance.</p>
              <p>The Vela Command Center provides AI-driven diagnostics through the Atlas engine. Medical decisions must be validated by licensed professionals. Vela is an assistive intelligence layer, not a replacement for human clinical judgement.</p>
              <p>Hospitals on the network are granted access to real-time predictive analytics, bed management systems, and cross-facility clinical intelligence.</p>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={() => setShowTC(false)} style={{ flex: 1, padding: '14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)', color: 'var(--text)', cursor: 'pointer', background: 'transparent' }}>Cancel</button>
              <button type="button" onClick={() => { setShowTC(false); setShowOnboarderInfo(true); }} style={{ flex: 1, padding: '14px', borderRadius: 12, border: 'none', color: '#FFFFFF', cursor: 'pointer', background: 'var(--brand)', fontWeight: 700 }}>I Agree & Continue</button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarder Info Modal */}
      {showOnboarderInfo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 480, width: '100%', background: '#FFFFFF', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 24, padding: 48 }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 32, color: 'var(--text)', marginBottom: 8 }}>Internal Records</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32, fontSize: 14 }}>Please identify yourself as the onboarding official.</p>
            <div style={{ marginBottom: 32 }}>
              <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.2em', display: 'block', marginBottom: 8 }}>Your Full Name</label>
              <input 
                type="text" 
                value={onboarderName} 
                onChange={e => setOnboarderName(e.target.value)} 
                placeholder="Dev Chalana"
                style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 12, padding: '14px 20px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={() => setShowOnboarderInfo(false)} style={{ flex: 1, padding: '14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)', color: 'var(--text)', cursor: 'pointer', background: 'transparent' }}>Back</button>
              <button 
                type="button" 
                disabled={!onboarderName.trim() || isOnboarding}
                onClick={() => { setShowOnboarderInfo(false); handleDirectOnboard(); }} 
                style={{ flex: 1, padding: '14px', borderRadius: 12, border: 'none', color: '#FFFFFF', cursor: 'pointer', background: 'var(--brand)', fontWeight: 700, opacity: onboarderName.trim() && !isOnboarding ? 1 : 0.5 }}
              >
                {isOnboarding ? 'Onboarding...' : 'Onboard Hospital →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hospital Details Modal */}
      {viewingHospital && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 520, width: '100%', background: '#FFFFFF', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 24, padding: 48 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 36, color: 'var(--text)', marginBottom: 4 }}>{viewingHospital.name}</h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>ID: {viewingHospital.id}</p>
              </div>
              <button type="button" onClick={() => setViewingHospital(null)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 24 }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, marginBottom: 40 }}>
              <div>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.2em', display: 'block', marginBottom: 4 }}>Manager name</label>
                <div style={{ color: 'var(--text)', fontSize: 15 }}>{viewingHospital.manager_name}</div>
              </div>
              <div>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.2em', display: 'block', marginBottom: 4 }}>Total Beds</label>
                <div style={{ color: 'var(--text)', fontSize: 15 }}>{viewingHospital.total_beds}</div>
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.2em', display: 'block', marginBottom: 4 }}>Manager Email</label>
                <div style={{ color: 'var(--brand)', fontSize: 14, fontFamily: 'var(--font-sans)' }}>{viewingHospital.manager_email}</div>
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.2em', display: 'block', marginBottom: 4 }}>Manager password</label>
                <div style={{ color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-sans)', background: 'rgba(0,0,0,0.05)', padding: '12px 16px', borderRadius: 8, marginTop: 4 }}>{viewingHospital.manager_password}</div>
              </div>
            </div>

            <button type="button" onClick={() => {
              localStorage.setItem('vela_manager_auth', 'true');
              localStorage.setItem('vela_hospital_id', viewingHospital.id);
              localStorage.setItem('vela_hospital_name', viewingHospital.name);
              localStorage.setItem('vela_manager_name', viewingHospital.manager_name);
              localStorage.setItem('vela_manager_role', 'Chief Medical Officer');
              setViewingHospital(null);
              navigate(`/hospital-manager`);
            }} style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', color: '#FFFFFF', cursor: 'pointer', background: 'var(--brand)', fontWeight: 700, fontSize: 14 }}>
              ✦ Access Manager Dashboard (Direct Login)
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ padding: '24px 48px', borderBottom: '1px solid rgba(0,0,0,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 28, color: 'var(--brand)' }}>V</div>
          <div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--brand)', letterSpacing: '0.2em', textTransform: 'uppercase' }}>Vela Command Center</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)' }}>System Administrator · Owner</div>
          </div>
        </div>
        <button type="button" onClick={() => { setSelectedPin(null); setShowTC(true); }}
          style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 10, padding: '10px 24px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          + Onboard Hospital
        </button>
      </div>

      {/* Search Bar */}
      <div style={{ padding: '24px 48px 0', position: 'relative' }}>
        <div style={{ position: 'relative', maxWidth: 600 }}>
          <div style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontSize: 18, pointerEvents: 'none' }}>🔍</div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search any hospital worldwide... (e.g. Apollo Hospital, AIIMS Delhi, Max Healthcare)"
            style={{
              width: '100%', padding: '14px 16px 14px 48px',
              background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)',
              borderRadius: 12, color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 15,
              outline: 'none', boxSizing: 'border-box',
              transition: 'border-color 0.2s'
            }}
            onFocus={e => e.target.style.borderColor = 'var(--brand)'}
            onBlur={e => e.target.style.borderColor = 'rgba(0,0,0,0.10)'}
          />
          {searching && (
            <div style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, border: '2px solid var(--brand)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          )}
        </div>

        {/* Search Results Dropdown */}
        {searchResults.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 48, right: 48, maxWidth: 600, background: '#1a1a1a', border: '1px solid rgba(0,113,227,0.2)', borderRadius: 12, overflow: 'hidden', zIndex: 100, boxShadow: '0 8px 32px rgba(0,0,0,0.6)', marginTop: 4 }}>
            {searchResults.map((r, i) => (
              <div key={i}
                onClick={() => handleSelectResult(r)}
                style={{ padding: '14px 20px', cursor: 'pointer', borderBottom: i < searchResults.length - 1 ? '1px solid rgba(0,0,0,0.07)' : 'none', transition: 'background 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,113,227,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 14, color: 'var(--text)', marginBottom: 2 }}>{r.name}</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>{r.address}</div>
              </div>
            ))}
          </div>
        )}

        {/* Selected hospital — Onboard button */}
        {selectedPin && searchResults.length === 0 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, background: 'rgba(0,113,227,0.08)', border: '1px solid rgba(0,113,227,0.25)', borderRadius: 12, padding: '14px 20px', maxWidth: 600 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, color: 'var(--text)', marginBottom: 2 }}>{selectedPin.name}</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>{selectedPin.address}</div>
            </div>
            <button type="button"
              onClick={() => setShowTC(true)}
              style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 8, padding: '10px 20px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              ✦ Onboard on Vela
            </button>
            <button type="button" onClick={() => { setSelectedPin(null); setSearchQuery(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
          </div>
        )}
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, padding: '32px 48px 0' }}>
        {[
          { label: 'Total Hospitals', color: 'var(--success)', idx: 0 },
          { label: 'Staff on Network', color: '#0071E3', idx: 1 },
          { label: 'Patients Today', color: 'var(--text)', idx: 2 },
          { label: 'Atlas Queries Today', color: 'var(--brand)', idx: 3 },
        ].map(({ label, color, idx }) => (
          <div key={idx} style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, padding: 24 }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{label}</div>
            <span ref={el => { statsRefs.current[idx] = el; }} style={{ fontFamily: 'var(--font-sans)', fontSize: 48, color, lineHeight: 1 }}>0</span>
          </div>
        ))}
      </div>

      {/* Map */}
      <div style={{ margin: '32px 48px', borderRadius: 16, overflow: 'hidden', height: 400, border: '1px solid rgba(0,0,0,0.07)' }}>
        <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <div style={{ padding: '0 48px 48px' }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 32, marginBottom: 24, color: 'var(--brand)' }}>Vela Hospitals</h2>
        {hospitals.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, border: '1px dashed rgba(0,0,0,0.10)', borderRadius: 16, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', fontSize: 12 }}>
            No hospitals onboarded yet. Click "+ Onboard Hospital" to add the first one.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {hospitals.map(h => (
              <div key={h.id} style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, padding: 24, cursor: 'pointer', transition: 'all 0.3s' }} 
                onClick={() => setViewingHospital(h)}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,113,227,0.4)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(0,0,0,0.07)'}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{h.name}</div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>{h.city}, {h.state}</div>
                  </div>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', border: `3px solid ${h.health_score > 70 ? 'var(--success)' : 'var(--warning)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)', fontSize: 11, color: h.health_score > 70 ? 'var(--success)' : 'var(--warning)', fontWeight: 700 }}>
                    {h.health_score || 0}
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>{h.staff_count}</span> staff
                  </div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: h.active_staff > 0 ? 'var(--success)' : 'var(--text-secondary)', display: 'inline-block' }} />
                    <span style={{ color: h.active_staff > 0 ? 'var(--success)' : 'var(--text-secondary)', fontWeight: 600 }}>{h.active_staff}</span> online
                  </div>
                </div>

                <div style={{ background: 'rgba(0,113,227,0.04)', border: '1px solid rgba(0,113,227,0.15)', borderRadius: 12, padding: 16, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Manager ID</div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--brand)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(h.manager_email); toast.success('Email copied'); }}>
                      {h.manager_email} <span style={{ fontSize: 10 }}>📋</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Initial Pass</div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(h.manager_password); toast.success('Password copied'); }}>
                      {h.manager_password} <span style={{ fontSize: 10 }}>📋</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Provider Network — independent labs & solo doctors, "through us" onboarding */}
      <div style={{ padding: '0 48px 64px' }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 32, marginBottom: 8, color: 'var(--brand)' }}>Provider Network</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
          Independent diagnostic labs and solo doctors who aren't part of a hospital — they go through us directly.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 40 }}>
          {/* Registration form */}
          <div style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, padding: 24 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {(['lab', 'doctor'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setProviderType(t)}
                  style={{
                    flex: 1, padding: '10px', borderRadius: 10, cursor: 'pointer',
                    border: providerType === t ? '1px solid var(--brand)' : '1px solid rgba(0,0,0,0.10)',
                    background: providerType === t ? 'rgba(0,113,227,0.1)' : 'transparent',
                    color: providerType === t ? 'var(--brand)' : 'var(--text-secondary)',
                    fontFamily: 'var(--font-sans)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em',
                  }}
                >
                  {t === 'lab' ? 'Independent Lab' : 'Solo Doctor'}
                </button>
              ))}
            </div>

            <div style={{ position: 'relative', marginBottom: 12 }}>
              <input
                value={providerQuery}
                onChange={(e) => handleProviderQueryChange(e.target.value)}
                placeholder={providerType === 'lab' ? 'Search the lab\'s location…' : 'Search the clinic\'s location…'}
                style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 16px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box', fontSize: 13 }}
              />
              {providerResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, marginTop: 4, zIndex: 20, maxHeight: 220, overflowY: 'auto' }}>
                  {providerResults.map((r, i) => (
                    <div
                      key={i}
                      onClick={() => { setProviderPin(r); setProviderQuery(r.name); setProviderResults([]); }}
                      style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid rgba(0,0,0,0.05)' }}
                    >
                      <div style={{ color: 'var(--text)' }}>{r.name}</div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{r.address}</div>
                    </div>
                  ))}
                </div>
              )}
              {providerSearching && <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>Searching…</div>}
            </div>

            {providerPin && (
              <div style={{ fontSize: 11, color: 'var(--success)', marginBottom: 12 }}>✓ {providerPin.address}</div>
            )}

            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder={providerType === 'lab' ? 'Contact person\'s name' : 'Doctor\'s full name'}
              style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 16px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box', fontSize: 13, marginBottom: 12 }}
            />

            {providerType === 'lab' ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    value={labDepartmentInput}
                    onChange={(e) => setLabDepartmentInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabDepartment(); } }}
                    placeholder="Department it runs (e.g. pathology)"
                    style={{ flex: 1, background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '10px 14px', color: 'var(--text)', outline: 'none', fontSize: 12 }}
                  />
                  <button type="button" onClick={addLabDepartment} style={{ padding: '0 16px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.10)', background: 'transparent', color: 'var(--brand)', cursor: 'pointer' }}>Add</button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {labDepartments.map((d) => (
                    <span key={d} onClick={() => setLabDepartments(labDepartments.filter((x) => x !== d))}
                      style={{ fontFamily: 'var(--font-sans)', fontSize: 10, padding: '4px 10px', borderRadius: 999, background: 'rgba(0,113,227,0.1)', color: 'var(--brand)', cursor: 'pointer' }}>
                      {d} ✕
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <input
                  value={doctorSpecialization}
                  onChange={(e) => setDoctorSpecialization(e.target.value)}
                  placeholder="Specialization (e.g. General Physician)"
                  style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 16px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box', fontSize: 13, marginBottom: 12 }}
                />
                <input
                  value={doctorLicense}
                  onChange={(e) => setDoctorLicense(e.target.value)}
                  placeholder="Medical license number"
                  style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 16px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box', fontSize: 13, marginBottom: 12 }}
                />
                <input
                  value={doctorFee}
                  onChange={(e) => setDoctorFee(e.target.value)}
                  placeholder="Consultation fee (₹)"
                  inputMode="decimal"
                  style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 16px', color: 'var(--text)', outline: 'none', boxSizing: 'border-box', fontSize: 13, marginBottom: 12 }}
                />
              </>
            )}

            <button
              type="button"
              disabled={providerRegistering}
              onClick={registerProvider}
              style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', color: '#FFFFFF', cursor: 'pointer', background: 'var(--brand)', fontWeight: 700, fontSize: 13, opacity: providerRegistering ? 0.6 : 1 }}
            >
              {providerRegistering ? 'Registering…' : `Register ${providerType === 'lab' ? 'Lab' : 'Doctor'} →`}
            </button>
          </div>

          {/* Registered providers list */}
          <div style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, padding: 24, maxHeight: 480, overflowY: 'auto' }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>
              Labs ({networkLabs.length})
            </div>
            {networkLabs.length === 0 ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginBottom: 20 }}>No independent labs yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                {networkLabs.map((l) => (
                  <div key={l.id} style={{ padding: 12, borderRadius: 10, border: '1px solid rgba(0,0,0,0.07)' }}>
                    <div style={{ color: 'var(--text)', fontSize: 13 }}>{l.name}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{(l.departments || []).join(', ') || 'No departments set'}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>
              Solo Doctors ({networkDoctors.length})
            </div>
            {networkDoctors.length === 0 ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>No solo doctors yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {networkDoctors.map((d) => (
                  <div key={d.id} style={{ padding: 12, borderRadius: 10, border: '1px solid rgba(0,0,0,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ color: 'var(--text)', fontSize: 13 }}>Dr. {d.name}</div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{d.specialization} · License {d.license_number}</div>
                    </div>
                    {d.verified ? (
                      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--success)', textTransform: 'uppercase' }}>Verified</span>
                    ) : (
                      <button
                        type="button"
                        disabled={verifyingDoctorId === d.id}
                        onClick={() => verifyDoctor(d.id)}
                        style={{ fontFamily: 'var(--font-sans)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--warning)', color: 'var(--warning)', background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        {verifyingDoctorId === d.id ? 'Verifying…' : 'Verify License'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
