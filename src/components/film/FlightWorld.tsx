import { useEffect, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * The landing page's 3D world: a bright white studio the camera flies through.
 *
 * Everything is built in code (no model files) and laid out along one line,
 * the -Z axis, so the scroll timeline only has to move the camera forward:
 *
 *   z  10 … -42   debris: lab reports, prescriptions, X-ray films, pills
 *   z -46         the record: a polished slab the debris spirals into
 *   z -70         Atlas: a liquid blue orb that pulses when it speaks
 *   z -100        six role monoliths in a ring; the camera turns inside it
 *   z -128        the zero: a ring the camera flies through
 *   z -152        the Vela star, with papers in a tidy orbit
 *
 * The page never calls into this component. It only writes numbers into the
 * shared `flight` object (camera position, how far the vortex has run…), and
 * the render loop here reads them every frame. That keeps GSAP and three.js
 * decoupled: one animates numbers, the other draws them.
 */

export interface FlightState {
  pz: number // camera position along the flight line
  theta: number // where the camera looks, in degrees (180 = straight ahead)
  roll: number // camera bank, radians
  vortex: number // 0 loose debris → 1 everything pulled into the record
  slab: number // 0 → 1 the record appears
  flash: number // 0 → 1 shock ring when the record forms
  slabExit: number // 0 → 1 the record swings out of the camera's way
  orbIn: number // 0 → 1 Atlas orb appears
  orbAmp: number // how hard the orb is "speaking"
  starIn: number // 0 → 1 end star appears
}

export const initialFlight = (): FlightState => ({
  pz: 10, theta: 180, roll: 0, vortex: 0, slab: 0, flash: 0, slabExit: 0, orbIn: 0, orbAmp: 0.25, starIn: 0,
})

export const ROLE_TONES = ['#FFE9BF', '#CFE4FB', '#CDEFD6', '#C8ECEC', '#DDDDE6', '#0071E3']

interface Props {
  flight: MutableRefObject<FlightState>
  roles: readonly { role: string; chip: string; rows: readonly (readonly [string, string, boolean])[] }[]
  className?: string
}

const INK = '#1D1D1F'
const MUTED = '#6E6E73'
const BLUE = '#0071E3'
const RED = '#D70015'
const SERIF = '"Gambarino", Georgia, serif'
const SANS = '"General Sans", -apple-system, "Helvetica Neue", Arial, sans-serif'

// ── Textures, painted on 2D canvases ───────────────────────────────────

function canvasTexture(w: number, h: number, paint: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const repaint = () => { const c = canvas.getContext('2d')!; c.clearRect(0, 0, w, h); paint(c) }
  repaint()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return { tex, repaint: () => { repaint(); tex.needsUpdate = true } }
}

function rounded(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
  c.fillStyle = fill
  c.fill()
}

/** The paper documents a patient arrives with. Each returns a 512 × 724 page. */
const PAPERS: ((c: CanvasRenderingContext2D) => void)[] = [
  (c) => { // lab report with one flagged value
    paper(c, 'LAB REPORT', 'VELA Care · Haematology')
    const rows: [string, string, boolean][] = [['Haemoglobin', '13.4', false], ['Sodium', '138', false], ['Potassium', '2.8 ↓', true], ['Creatinine', '1.1', false], ['Glucose', '96', false], ['Calcium', '9.2', false]]
    rows.forEach(([k, v, flag], i) => {
      const y = 230 + i * 70
      if (flag) rounded(c, 36, y - 42, 440, 62, 12, '#FFEBEE')
      c.font = `${flag ? 600 : 400} 30px ${SANS}`
      c.fillStyle = flag ? RED : INK
      c.textAlign = 'left'; c.fillText(k, 56, y)
      c.textAlign = 'right'; c.fillText(v, 456, y)
    })
  },
  (c) => { // prescription
    paper(c, 'PRESCRIPTION', 'Dr. A. Rao · 22 Oct')
    c.font = `400 150px ${SERIF}`; c.fillStyle = BLUE; c.textAlign = 'left'; c.fillText('Rx', 50, 340)
    c.font = `600 32px ${SANS}`; c.fillStyle = INK; c.fillText('Furosemide 40 mg', 56, 430)
    c.font = `400 28px ${SANS}`; c.fillStyle = MUTED; c.fillText('Once daily · 14 days', 56, 474)
    c.strokeStyle = INK; c.lineWidth = 3; c.beginPath(); c.moveTo(280, 640)
    c.bezierCurveTo(310, 590, 330, 680, 360, 630); c.bezierCurveTo(385, 595, 410, 660, 456, 620); c.stroke()
  },
  (c) => { // handwritten ward note
    paper(c, 'WARD NOTE', 'Bed 4 · morning round')
    c.strokeStyle = '#DCE6F2'; c.lineWidth = 2
    for (let y = 250; y < 680; y += 62) { c.beginPath(); c.moveTo(48, y); c.lineTo(464, y); c.stroke() }
    c.font = `400 40px "Bradley Hand", "Segoe Print", cursive`; c.fillStyle = INK; c.textAlign = 'left'
    ;['c/o fatigue,', 'leg cramps x3d', 'K+ ??', 'review meds'].forEach((t, i) => c.fillText(t, 60, 238 + i * 62))
  },
  (c) => { // ECG strip
    paper(c, 'ECG', 'Lead II · 25 mm/s')
    c.strokeStyle = '#F6D5D8'; c.lineWidth = 1.5
    for (let x = 48; x <= 464; x += 26) { c.beginPath(); c.moveTo(x, 210); c.lineTo(x, 660); c.stroke() }
    for (let y = 210; y <= 660; y += 26) { c.beginPath(); c.moveTo(48, y); c.lineTo(464, y); c.stroke() }
    c.strokeStyle = INK; c.lineWidth = 3.5; c.lineJoin = 'round'
    ;[330, 540].forEach((base) => {
      c.beginPath(); c.moveTo(48, base)
      for (let b = 0; b < 3; b++) {
        const x = 48 + b * 139
        c.lineTo(x + 30, base); c.quadraticCurveTo(x + 42, base - 16, x + 54, base); c.lineTo(x + 66, base)
        c.lineTo(x + 72, base + 14); c.lineTo(x + 82, base - 96); c.lineTo(x + 92, base + 30); c.lineTo(x + 100, base)
        c.quadraticCurveTo(x + 118, base - 26, x + 134, base); c.lineTo(x + 139, base)
      }
      c.stroke()
    })
  },
  (c) => { // discharge summary: a wall of text
    paper(c, 'DISCHARGE SUMMARY', 'Previous admission')
    for (let i = 0; i < 11; i++) rounded(c, 56, 220 + i * 40, i % 4 === 3 ? 220 : 400 - (i % 3) * 36, 14, 7, '#D9DEE6')
  },
]

function paper(c: CanvasRenderingContext2D, title: string, sub: string) {
  c.fillStyle = '#FBFCFE'; c.fillRect(0, 0, 512, 724)
  c.strokeStyle = '#C9D3E1'; c.lineWidth = 6; c.strokeRect(3, 3, 506, 718)
  rounded(c, 36, 40, 56, 56, 14, BLUE)
  c.fillStyle = '#FFFFFF'; c.fillRect(60, 52, 8, 32); c.fillRect(48, 64, 32, 8) // medical cross
  c.textAlign = 'left'
  c.font = `600 28px ${SANS}`; c.fillStyle = INK; c.fillText(title, 108, 66)
  c.font = `400 22px ${SANS}`; c.fillStyle = MUTED; c.fillText(sub, 108, 96)
  c.fillStyle = '#E5E5EA'; c.fillRect(36, 130, 440, 3)
}

function paintFilm(c: CanvasRenderingContext2D) { // chest X-ray on pale blue acetate
  c.fillStyle = 'rgba(92, 150, 222, 0.72)'; c.fillRect(0, 0, 512, 640)
  c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineCap = 'round'
  c.lineWidth = 18; c.beginPath(); c.moveTo(256, 70); c.lineTo(256, 580); c.stroke() // spine
  c.lineWidth = 11
  for (let i = 0; i < 7; i++) {
    const y = 150 + i * 58
    const spread = 150 + Math.sin((i / 6) * Math.PI) * 50
    c.beginPath(); c.moveTo(256, y); c.quadraticCurveTo(256 - spread * 0.6, y - 46, 256 - spread, y + 26); c.stroke()
    c.beginPath(); c.moveTo(256, y); c.quadraticCurveTo(256 + spread * 0.6, y - 46, 256 + spread, y + 26); c.stroke()
  }
  c.lineWidth = 13; c.beginPath(); c.moveTo(110, 110); c.quadraticCurveTo(256, 60, 402, 110); c.stroke() // clavicles
}

function paintRecord(c: CanvasRenderingContext2D) { // the assembled record, 1400 × 900
  c.textAlign = 'left'
  c.font = `400 34px ${SANS}`; c.fillStyle = MUTED; c.fillText('Demo patient · VLA-8888', 70, 110)
  c.font = `400 104px ${SERIF}`; c.fillStyle = INK; c.fillText('Rajesh Kumar', 66, 220)
  c.textAlign = 'right'
  c.font = `400 190px ${SERIF}`; c.fillStyle = RED; c.fillText('82', 1330, 216)
  c.font = `400 30px ${SANS}`; c.fillStyle = MUTED; c.fillText('Risk score', 1330, 262)
  const tiles: [string, string, string, boolean][] = [
    ['Blood report', 'Lab · Tuesday', 'Potassium 2.8 mEq/L', true], ['Ward note', 'Morning round', 'Fatigue, cramps', false], ['Chest X-ray', 'Radiology', 'No acute findings', false],
    ['Furosemide 40 mg', 'Started 6 days ago', 'Once daily', false], ['Voice memo', '0:42', 'Transcribed', false], ['Allergy', 'At registration', 'Penicillin', true],
  ]
  tiles.forEach(([t, m, b, flag], i) => {
    const x = 66 + (i % 3) * 428
    const y = 320 + Math.floor(i / 3) * 270
    rounded(c, x, y, 404, 246, 34, '#FFFFFF')
    rounded(c, x + 30, y + 30, 64, 64, 18, flag ? '#FFEBEE' : '#E8F2FD')
    c.beginPath(); c.arc(x + 62, y + 62, 13, 0, Math.PI * 2); c.fillStyle = flag ? RED : BLUE; c.fill()
    c.textAlign = 'left'
    c.font = `600 34px ${SANS}`; c.fillStyle = INK; c.fillText(t, x + 114, y + 58)
    c.font = `400 28px ${SANS}`; c.fillStyle = MUTED; c.fillText(m, x + 114, y + 96)
    c.font = `${flag ? 600 : 400} 36px ${SANS}`; c.fillStyle = flag ? RED : '#515154'; c.fillText(b, x + 30, y + 190)
  })
}

function paintRole(c: CanvasRenderingContext2D, r: Props['roles'][number], onBlue: boolean) { // 700 × 1300
  c.textAlign = 'left'
  c.font = `400 ${r.role.length > 8 ? 112 : 150}px ${SERIF}`; c.fillStyle = onBlue ? '#FFFFFF' : INK; c.fillText(r.role, 56, 250)
  rounded(c, 44, 760, 612, 420, 44, '#FFFFFF')
  r.rows.forEach(([k, v, hot], i) => {
    const y = 784 + i * 126
    if (hot) rounded(c, 62, y, 576, 118, 30, '#E8F2FD')
    c.beginPath(); c.arc(104, y + 59, 11, 0, Math.PI * 2); c.fillStyle = hot ? BLUE : '#D2D2D7'; c.fill()
    c.font = `${hot ? 600 : 400} 40px ${SANS}`; c.fillStyle = hot ? INK : '#515154'; c.textAlign = 'left'; c.fillText(k, 136, y + 73)
    c.fillStyle = hot ? BLUE : MUTED; c.textAlign = 'right'; c.fillText(v, 610, y + 73)
  })
  c.font = `500 38px ${SANS}`; c.fillStyle = onBlue ? '#FFFFFF' : INK; c.textAlign = 'left'; c.fillText(r.chip, 56, 700)
}

// ── Small maths helpers ────────────────────────────────────────────────

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x) }
const backOut = (t: number) => { const x = Math.min(1, Math.max(0, t)) - 1; return 1 + 2.2 * x * x * x + 1.2 * x * x }
function seeded(seed: number) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) }

interface Piece {
  base: THREE.Vector3
  axis: THREE.Vector3
  spin: number
  phase: number
  size: number
  delay: number // when in the vortex this piece lets go
  write: (m: THREE.Matrix4) => void
}

export default function FlightWorld({ flight, roles, className }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    } catch {
      return // no WebGL: the page still reads as type on white
    }
    const phone = window.innerWidth < 768
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, phone ? 1.5 : 2))
    renderer.setClearColor(0xffffff, 0)
    renderer.toneMapping = THREE.NoToneMapping // white must stay pure white
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0xffffff, 13, 52) // distance fades to the white page
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.55

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120)
    scene.add(camera)
    const key = new THREE.DirectionalLight(0xffffff, 1.0) // travels with the camera
    key.position.set(3, 6, 4)
    camera.add(key)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))

    const disposables: { dispose: () => void }[] = [pmrem]
    const own = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x }
    const repaints: (() => void)[] = []
    const texture = (w: number, h: number, paint: (c: CanvasRenderingContext2D) => void) => {
      const t = canvasTexture(w, h, paint)
      repaints.push(t.repaint)
      return own(t.tex)
    }

    let portrait = false
    const side = () => (portrait ? 0 : 1)
    const rand = seeded(11)
    const pieces: Piece[] = []
    const dummy = new THREE.Object3D()

    // ── Debris: everything a patient arrives with ──
    const place = () => {
      for (;;) {
        const p = new THREE.Vector3((rand() * 2 - 1) * 10, (rand() * 2 - 1) * 5.6, 5 - rand() * 47)
        const inCorridor = Math.hypot(p.x / 2, p.y / 1.5) < 1 // keep the flight line clear
        // Keep the middle of the opening frame clear so the headline reads.
        const dist = 10 - p.z
        const behindTitle = p.z > -16 && Math.abs(p.x) / (dist * 0.66) < 0.62 && Math.abs(p.y) / (dist * 0.414) < 0.75
        if (!inCorridor && !behindTitle) return p
      }
    }
    const piece = (size: number, write: Piece['write']) => pieces.push({
      base: place(), axis: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      spin: 0.15 + rand() * 0.35, phase: rand() * 6.28, size, delay: rand() * 0.45, write,
    })

    const paperGeo = own(new THREE.BoxGeometry(1, 1.414, 0.012))
    const edge = own(new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.9 }))
    const paperMats = PAPERS.map((paint) => own(new THREE.MeshStandardMaterial({ map: texture(512, 724, paint), roughness: 0.85 })))
    // White paper on a white page needs a shadow to exist at all. Real shadow
    // maps would cost a second render, so each sheet carries a soft blurred card.
    const shadowTex = texture(256, 340, (c) => {
      c.shadowColor = 'rgba(24, 48, 92, 0.55)'
      c.shadowBlur = 44
      c.shadowOffsetX = 1000 // draw the card off-canvas; only its blur lands here
      c.fillStyle = '#000'
      c.fillRect(48 - 1000, 48, 160, 244)
    })
    const shadowGeo = own(new THREE.PlaneGeometry(1.6, 2.13))
    const shadowMat = own(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }))
    const shadowOffset = new THREE.Matrix4().makeTranslation(0.09, -0.12, -0.09)
    for (let i = 0; i < (phone ? 22 : 40); i++) {
      const mesh = new THREE.Mesh(paperGeo, [edge, edge, edge, edge, paperMats[i % paperMats.length], edge])
      const shade = new THREE.Mesh(shadowGeo, shadowMat)
      mesh.matrixAutoUpdate = shade.matrixAutoUpdate = false
      scene.add(shade, mesh)
      piece(1 + rand() * 0.7, (m) => { mesh.matrix.copy(m); shade.matrix.multiplyMatrices(m, shadowOffset) })
    }

    const filmGeo = own(new THREE.PlaneGeometry(1.3, 1.62))
    const filmMat = own(new THREE.MeshPhysicalMaterial({ map: texture(512, 640, paintFilm), transparent: true, side: THREE.DoubleSide, roughness: 0.08, clearcoat: 1, depthWrite: false }))
    for (let i = 0; i < (phone ? 5 : 9); i++) {
      const mesh = new THREE.Mesh(filmGeo, filmMat)
      mesh.matrixAutoUpdate = false
      scene.add(mesh)
      piece(1.1 + rand() * 0.8, (m) => mesh.matrix.copy(m))
    }

    const pillTex = texture(4, 64, (c) => { c.fillStyle = '#FFFFFF'; c.fillRect(0, 0, 4, 64); c.fillStyle = BLUE; c.fillRect(0, 0, 4, 32) })
    const pillCount = phone ? 26 : 54
    const pills = new THREE.InstancedMesh(own(new THREE.CapsuleGeometry(0.15, 0.36, 8, 20)), own(new THREE.MeshPhysicalMaterial({ map: pillTex, roughness: 0.18, clearcoat: 1 })), pillCount)
    scene.add(pills)
    for (let i = 0; i < pillCount; i++) piece(0.7 + rand() * 0.9, (m) => pills.setMatrixAt(i, m))

    const plus = new THREE.Shape()
    ;[[-0.1, 0.3], [0.1, 0.3], [0.1, 0.1], [0.3, 0.1], [0.3, -0.1], [0.1, -0.1], [0.1, -0.3], [-0.1, -0.3], [-0.1, -0.1], [-0.3, -0.1], [-0.3, 0.1], [-0.1, 0.1]]
      .forEach(([x, y], i) => (i ? plus.lineTo(x, y) : plus.moveTo(x, y)))
    const crossCount = phone ? 8 : 16
    const crosses = new THREE.InstancedMesh(
      own(new THREE.ExtrudeGeometry(plus, { depth: 0.14, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 4 })),
      own(new THREE.MeshPhysicalMaterial({ roughness: 0.2, clearcoat: 1 })), crossCount)
    scene.add(crosses)
    for (let i = 0; i < crossCount; i++) {
      crosses.setColorAt(i, new THREE.Color(i % 3 === 0 ? '#FFFFFF' : i % 3 === 1 ? BLUE : '#9CC8F7'))
      piece(0.8 + rand() * 1.2, (m) => crosses.setMatrixAt(i, m))
    }

    // Dust along the whole flight line: gives speed something to move against.
    const dustCount = phone ? 700 : 1500
    const dustPos = new Float32Array(dustCount * 3)
    for (let i = 0; i < dustCount; i++) { dustPos[i * 3] = (rand() * 2 - 1) * 15; dustPos[i * 3 + 1] = (rand() * 2 - 1) * 9; dustPos[i * 3 + 2] = 14 - rand() * 180 }
    const dustGeo = own(new THREE.BufferGeometry())
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    scene.add(new THREE.Points(dustGeo, own(new THREE.PointsMaterial({ color: 0x8fb4de, size: 0.06, transparent: true, opacity: 0.8 }))))

    // ── The record: a polished blue slab ──
    const RECORD = new THREE.Vector3(0, 0, -46)
    const slab = new THREE.Group()
    // Tinted, not see-through: real transmission over a white page just reads as white.
    const glass = own(new THREE.MeshPhysicalMaterial({ color: 0xbcd9f8, roughness: 0.12, clearcoat: 1 }))
    slab.add(new THREE.Mesh(own(new RoundedBoxGeometry(5.3, 3.5, 0.24, 6, 0.2)), glass))
    const face = new THREE.Mesh(own(new THREE.PlaneGeometry(5.1, 3.28)), own(new THREE.MeshBasicMaterial({ map: texture(1400, 900, paintRecord), transparent: true })))
    face.position.z = 0.13
    slab.add(face)
    scene.add(slab)
    const shock = new THREE.Mesh(own(new THREE.TorusGeometry(1, 0.012, 8, 120)), own(new THREE.MeshBasicMaterial({ color: BLUE, transparent: true })))
    scene.add(shock)

    // ── Atlas: a liquid orb and its sound rings ──
    const ORB = new THREE.Vector3(0, 0, -70)
    const orbMat = own(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAmp: { value: 0.25 } },
      vertexShader: /* glsl */ `
        uniform float uTime, uAmp;
        varying vec3 vWorld;
        varying vec3 vView;
        void main() {
          vec3 p = position;
          float wave = sin(p.x * 2.6 + uTime * 1.4) * sin(p.y * 3.1 + uTime * 1.1) * sin(p.z * 2.3 + uTime * 0.9)
                     + 0.5 * sin(p.y * 6.0 - uTime * 2.2) * sin(p.x * 5.0 + uTime * 1.7);
          p += normal * wave * 0.16 * uAmp;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          vec4 mv = viewMatrix * world;
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vView;
        void main() {
          vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          vec3 v = normalize(vView);
          vec3 nv = normalize(cross(dFdx(vView), dFdy(vView)));
          float fres = pow(1.0 - abs(dot(nv, v)), 2.2);
          vec3 deep = vec3(0.0, 0.36, 0.86);
          vec3 sky = vec3(0.56, 0.80, 1.0);
          vec3 col = mix(deep, sky, n.y * 0.5 + 0.5);
          col = mix(col, vec3(1.0), fres * 0.85);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }))
    const orb = new THREE.Mesh(own(new THREE.IcosahedronGeometry(1.5, phone ? 24 : 48)), orbMat)
    scene.add(orb)
    const waveGeo = own(new THREE.TorusGeometry(1.7, 0.012, 8, 120))
    const waves = [0, 1, 2].map(() => {
      const ring = new THREE.Mesh(waveGeo, own(new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0 })))
      scene.add(ring)
      return ring
    })

    // ── Six roles: monoliths in a ring, facing its centre ──
    const RING = new THREE.Vector3(0, 0, -100)
    const monolithGeo = own(new RoundedBoxGeometry(2.9, 5.4, 0.22, 5, 0.12))
    const monolithFace = own(new THREE.PlaneGeometry(2.7, 5.02))
    const monoliths = roles.map((r, i) => {
      const group = new THREE.Group()
      group.add(new THREE.Mesh(monolithGeo, own(new THREE.MeshPhysicalMaterial({ color: ROLE_TONES[i], roughness: 0.22, clearcoat: 1 }))))
      const label = new THREE.Mesh(monolithFace, own(new THREE.MeshBasicMaterial({ map: texture(700, 1300, (c) => paintRole(c, r, i === 5)), transparent: true })))
      label.position.z = 0.115
      group.add(label)
      const a = THREE.MathUtils.degToRad(210 + i * 60)
      group.position.set(RING.x + Math.sin(a) * 8.6, 0, RING.z + Math.cos(a) * 8.6)
      group.lookAt(RING)
      scene.add(group)
      return group
    })

    // ── The zero: a ring to fly through ──
    const zero = new THREE.Mesh(own(new THREE.TorusGeometry(3, 0.3, 48, 180)), own(new THREE.MeshPhysicalMaterial({ color: BLUE, roughness: 0.16, clearcoat: 1 })))
    zero.position.set(0, 0, -128)
    scene.add(zero)

    // ── The Vela star, with papers in a tidy orbit ──
    const STAR = new THREE.Vector3(0, 0, -152)
    const starShape = new THREE.Shape()
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2
      const x = Math.pow(Math.abs(Math.cos(a)), 2.6) * Math.sign(Math.cos(a)) * 1.5
      const y = Math.pow(Math.abs(Math.sin(a)), 2.6) * Math.sign(Math.sin(a)) * 1.9
      if (i) starShape.lineTo(x, y); else starShape.moveTo(x, y)
    }
    const starGeo = own(new THREE.ExtrudeGeometry(starShape, { depth: 0.3, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.1, bevelSegments: 6, curveSegments: 24 }))
    starGeo.center()
    const star = new THREE.Mesh(starGeo, own(new THREE.MeshPhysicalMaterial({ color: BLUE, roughness: 0.12, metalness: 0.25, clearcoat: 1 })))
    scene.add(star)
    const orbitCount = 22
    const orbiters = new THREE.InstancedMesh(own(new THREE.BoxGeometry(0.42, 0.6, 0.01)), own(new THREE.MeshStandardMaterial({ color: 0xbcd9f8, roughness: 0.7, side: THREE.DoubleSide })), orbitCount)
    scene.add(orbiters)

    // Fonts arrive after the first paint: redraw the textures that use them.
    document.fonts?.ready.then(() => repaints.forEach((r) => r())).catch(() => {})

    // ── Layout: where things sit depends on the frame's shape ──
    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      portrait = w / h < 0.85
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.fov = portrait ? 68 : 45
      camera.updateProjectionMatrix()
      RECORD.set(2.55 * side(), portrait ? -1.5 : -0.1, -46)
      ORB.set(-2.9 * side(), portrait ? 1.1 : 0, -70)
      orb.scale.setScalar(portrait ? 0.75 : 1)
      zero.scale.setScalar(portrait ? 0.72 : 1)
      STAR.set(3.6 * side(), portrait ? 3.2 : 0.2, -152)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    const pointer = new THREE.Vector2()
    const drift = new THREE.Vector2()
    const onMove = (e: PointerEvent) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    window.addEventListener('pointermove', onMove)

    const clock = new THREE.Clock()
    const q = new THREE.Quaternion()
    const v = new THREE.Vector3()
    const m = new THREE.Matrix4()
    const one = new THREE.Vector3()
    let raf = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.hidden) return
      const f = flight.current
      const t = clock.getElapsedTime()

      // Camera: forward along -Z, turning by theta, leaning with the pointer.
      drift.lerp(pointer, 0.05)
      camera.position.set(drift.x * 0.5, -drift.y * 0.3, f.pz)
      const th = THREE.MathUtils.degToRad(f.theta)
      v.set(Math.sin(th) * 10, 0, f.pz + Math.cos(th) * 10)
      camera.lookAt(v)
      camera.rotateZ(f.roll)

      // Debris: floats loose, then spirals into the record.
      for (const p of pieces) {
        const pull = smooth((f.vortex - p.delay) / (1 - p.delay))
        const keep = Math.pow(1 - pull, 1.6)
        const dx = p.base.x - RECORD.x
        const dy = p.base.y - RECORD.y
        const turn = pull * 5.5
        dummy.position.set(
          RECORD.x + (dx * Math.cos(turn) - dy * Math.sin(turn)) * keep,
          RECORD.y + (dx * Math.sin(turn) + dy * Math.cos(turn)) * keep + Math.sin(t * 0.5 + p.phase) * 0.18 * keep,
          RECORD.z + (p.base.z - RECORD.z) * Math.pow(1 - pull, 2.2),
        )
        q.setFromAxisAngle(p.axis, p.phase + t * p.spin + pull * 9)
        dummy.quaternion.copy(q)
        dummy.scale.setScalar(p.size * (1 - pull * pull * pull))
        dummy.updateMatrix()
        p.write(dummy.matrix)
      }
      pills.instanceMatrix.needsUpdate = true
      crosses.instanceMatrix.needsUpdate = true

      // The record forms with a spin and a shock ring, then swings aside.
      const s = backOut(f.slab)
      slab.visible = f.slab > 0.001 && f.slabExit < 0.999
      slab.position.set(RECORD.x + f.slabExit * 8 * side(), RECORD.y + f.slabExit * (portrait ? 9 : 0), RECORD.z)
      slab.rotation.set(Math.sin(t * 0.5) * 0.05, (1 - s) * Math.PI * 1.5 - 0.22 * side() + Math.sin(t * 0.4) * 0.06 - f.slabExit * 1.3, 0)
      slab.scale.setScalar(Math.max(0.0001, s) * (portrait ? 0.86 : 1))
      shock.visible = f.flash > 0.001 && f.flash < 0.999
      shock.position.copy(RECORD)
      shock.scale.setScalar(0.5 + f.flash * 9)
      ;(shock.material as THREE.MeshBasicMaterial).opacity = 1 - f.flash

      // Atlas.
      const o = backOut(f.orbIn)
      orb.visible = f.orbIn > 0.001 && f.pz > -84
      orb.position.set(ORB.x, ORB.y + Math.sin(t * 0.8) * 0.1, ORB.z)
      orb.scale.setScalar(Math.max(0.0001, o) * (portrait ? 0.75 : 1))
      orb.rotation.y = t * 0.25
      orbMat.uniforms.uTime.value = t
      orbMat.uniforms.uAmp.value = f.orbAmp
      waves.forEach((ring, i) => {
        const k = (t * 0.45 + i / 3) % 1
        ring.visible = orb.visible
        ring.position.copy(orb.position)
        ring.scale.setScalar((0.95 + k * 1.1) * o * (portrait ? 0.75 : 1))
        ;(ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * Math.min(1, f.orbAmp) * 0.7 * o
      })

      // Monoliths breathe slightly so the ring never looks frozen.
      monoliths.forEach((g, i) => { g.position.y = Math.sin(t * 0.6 + i * 1.1) * 0.12 })
      zero.rotation.set(Math.sin(t * 0.5) * 0.12, Math.sin(t * 0.37) * 0.16, 0)

      // The star and its orbit.
      const st = backOut(f.starIn)
      star.visible = orbiters.visible = f.starIn > 0.001
      star.position.copy(STAR)
      star.rotation.y = t * 0.6
      star.scale.setScalar(Math.max(0.0001, st) * (portrait ? 0.7 : 1))
      for (let i = 0; i < orbitCount; i++) {
        const a = (i / orbitCount) * Math.PI * 2 + t * 0.35
        const r = (portrait ? 2 : 2.4) * st
        dummy.position.set(STAR.x + Math.cos(a) * r, STAR.y + Math.sin(a) * r * 0.32, STAR.z + Math.sin(a) * r)
        dummy.rotation.set(0.2, -a + Math.PI / 2, 0.1)
        dummy.scale.copy(one.setScalar(Math.max(0.0001, st)))
        dummy.updateMatrix()
        orbiters.setMatrixAt(i, m.copy(dummy.matrix))
      }
      orbiters.instanceMatrix.needsUpdate = true

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      disposables.forEach((d) => d.dispose())
      scene.environment?.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [flight, roles])

  return <div ref={mountRef} className={className} aria-hidden="true" />
}
