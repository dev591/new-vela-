// Public page for judges: where every piece of demo data comes from, with the files to download.
// Everything on it is synthetic. The three PDFs live in public/samples and are served as-is.
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Download, FileText } from 'lucide-react'

const FILES = [
  {
    file: 'Rajesh_Kumar_Blood_Report_Mar_2024.pdf',
    title: 'Blood report the patient uploads',
    what: 'A two-page Complete Blood Count for the demo patient (Hb 9.2, RBC 3.8, WBC 11,400). This is the file Atlas reads when it answers about his blood values.',
    where: 'Sign in as the patient, open My records, press “Select File / Photo” and choose this file. Then ask Atlas about his haemoglobin.',
  },
  {
    file: 'Rajesh_Kumar_Blood_Report_Followup_Mar_2024.pdf',
    title: 'Follow-up blood report (two weeks later)',
    what: 'The same patient two weeks later (Hb 7.8). Uploading both lets Atlas and the doctor see the trend.',
    where: 'Same place. Upload it after the first one and ask “how has his haemoglobin changed?”',
  },
  {
    file: 'VELA_Blood_CBC_Lab_Report_sample.pdf',
    title: 'Lab report VELA generates',
    what: 'What the VELA lab produces after a doctor orders a Blood CBC: values checked against reference ranges and flagged. The lab screen builds this PDF itself; nothing is copied from elsewhere.',
    where: 'Created when the lab files a Blood CBC result. The patient and doctor download the same PDF from their records.',
  },
]

const ROWS: [string, string][] = [
  ['Rajesh Kumar (VLA-8888)', 'Synthetic demo patient, seeded in the database. The invented name, age and history are not a real person.'],
  ['Anita, and two others (VLA-9001 to 9003)', 'Synthetic patients with several reports each, for the virtual consultation. Added by seed_demo_patients.py.'],
  ['Reception, doctor and lab accounts', 'Throwaway demo staff at the demo hospital, VELA Care. They exist only for judging.'],
  ['Phone numbers and IDs', 'Invented. No real contact details anywhere.'],
]

export default function DataSources() {
  const navigate = useNavigate()
  return (
    <main className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] px-5 py-10">
      <div className="mx-auto max-w-[760px]">
        <button type="button" onClick={() => navigate(-1)}
          className="inline-flex items-center gap-2 h-10 -ml-3 px-3 rounded-full text-[14px] text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/5 mb-6">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="text-[13px] font-semibold text-[#0071E3] mb-3">For judges</div>
        <h1 className="text-[clamp(2rem,5vw,3rem)] font-semibold tracking-[-0.04em] leading-[1.05] mb-3">Where the data comes from.</h1>
        <p className="text-[17px] text-[#515154] mb-10">
          Everything in this demo is synthetic. Download the files below to see exactly what the app reads and what it produces.
        </p>

        <h2 className="text-[22px] font-semibold tracking-[-0.02em] mb-4">Files to download</h2>
        <ul className="space-y-3 mb-12">
          {FILES.map(f => (
            <li key={f.file} className="rounded-2xl bg-white border border-black/[0.06] p-5">
              <div className="flex items-start gap-3">
                <span className="grid place-items-center w-10 h-10 rounded-xl bg-[#E8F2FD] text-[#0071E3] shrink-0"><FileText size={20} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[17px] font-semibold">{f.title}</div>
                  <div className="text-[13px] text-[#6E6E73] break-all mb-2">{f.file}</div>
                  <p className="text-[15px] text-[#3A3A3C] mb-2">{f.what}</p>
                  <p className="text-[14px] text-[#515154]"><strong>Where it is used:</strong> {f.where}</p>
                </div>
              </div>
              <a href={`/samples/${f.file}`} download={f.file}
                className="mt-4 inline-flex items-center gap-2 h-11 px-5 rounded-full bg-[#0071E3] hover:bg-[#0058B0] text-white text-[15px] font-semibold">
                <Download size={16} /> Download PDF
              </a>
            </li>
          ))}
        </ul>

        <h2 className="text-[22px] font-semibold tracking-[-0.02em] mb-4">The test a doctor orders</h2>
        <div className="rounded-2xl bg-white border border-black/[0.06] p-5 mb-12 text-[15px] text-[#3A3A3C] space-y-2">
          <p><strong>Blood CBC</strong>, pathology department, ₹350. Fields: Hemoglobin, WBC, Platelets, RBC, Hematocrit, MCV.</p>
          <p>The doctor opens the patient, presses Space and says <em>“Order a CBC test for him.”</em> Atlas creates one order and says where it went.</p>
          <p>One test means one order: asking again says it is already ordered and creates nothing new. The lab sees it once, fills in the values, and VELA turns them into the PDF above.</p>
        </div>

        <h2 className="text-[22px] font-semibold tracking-[-0.02em] mb-4">People and records</h2>
        <dl className="rounded-2xl bg-white border border-black/[0.06] divide-y divide-black/5 mb-12">
          {ROWS.map(([k, v]) => (
            <div key={k} className="p-5 sm:grid sm:grid-cols-[220px_1fr] sm:gap-4">
              <dt className="text-[15px] font-semibold mb-1 sm:mb-0">{k}</dt>
              <dd className="text-[15px] text-[#515154]">{v}</dd>
            </div>
          ))}
        </dl>

        <h2 className="text-[22px] font-semibold tracking-[-0.02em] mb-4">Voice</h2>
        <p className="text-[15px] text-[#3A3A3C] mb-12">
          Speech in and out is Gnani Prisma (speech to text) and Timbre (text to speech). The language you speak is what the kiosk answers in.
        </p>

        <button type="button" onClick={() => navigate('/login')}
          className="h-12 px-6 rounded-full bg-[#1D1D1F] text-white text-[15px] font-semibold">Back to sign in</button>
      </div>
    </main>
  )
}
