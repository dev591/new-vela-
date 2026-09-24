import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * VitalsField — the signature 3D scene behind the landing page.
 * ~14k particles morph between three clinical forms:
 *   0: DNA double helix   (genomics)
 *   1: beating human heart (cardiology — pulses on a heartbeat envelope)
 *   2: neural sphere       (intelligence)
 * plus a glowing ECG trace sweeping underneath.
 *
 * Drive it with `shapeRef.current = 0 | 1 | 2` from scroll position.
 */

const COUNT = 14000

function makeSprite(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.6)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  return tex
}

function helixShape(): { pos: Float32Array; col: Float32Array } {
  const pos = new Float32Array(COUNT * 3)
  const col = new Float32Array(COUNT * 3)
  const cA = new THREE.Color('#3EE6C1') // teal strand
  const cB = new THREE.Color('#7DD3FC') // sky strand
  const cR = new THREE.Color('#C8B89A') // gold rungs
  const turns = 4.5, height = 26, radius = 4.6
  for (let i = 0; i < COUNT; i++) {
    const k = i / COUNT
    const group = i % 10 // 0-3 strand A, 4-7 strand B, 8-9 rungs
    const t = k * Math.PI * 2 * turns
    const y = (k - 0.5) * height
    let x: number, z: number, yy = y
    let c: THREE.Color
    if (group < 4) {
      x = Math.cos(t) * radius; z = Math.sin(t) * radius; c = cA
    } else if (group < 8) {
      x = Math.cos(t + Math.PI) * radius; z = Math.sin(t + Math.PI) * radius; c = cB
    } else {
      // rungs: bridge between strands at quantized heights
      const q = Math.floor(k * 46) / 46
      const tq = q * Math.PI * 2 * turns
      const f = Math.random()
      x = Math.cos(tq) * radius * (1 - 2 * f)
      z = Math.sin(tq) * radius * (1 - 2 * f)
      yy = (q - 0.5) * height
      c = cR
    }
    const j = 0.12
    pos[i * 3] = x + (Math.random() - 0.5) * j
    pos[i * 3 + 1] = yy + (Math.random() - 0.5) * j
    pos[i * 3 + 2] = z + (Math.random() - 0.5) * j
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  return { pos, col }
}

function heartShape(): { pos: Float32Array; col: Float32Array } {
  const pos = new Float32Array(COUNT * 3)
  const col = new Float32Array(COUNT * 3)
  const cCore = new THREE.Color('#FF4D5E')
  const cEdge = new THREE.Color('#FF9E7A')
  const cSpark = new THREE.Color('#FFD9A0')
  const S = 0.62
  for (let i = 0; i < COUNT; i++) {
    const t = Math.random() * Math.PI * 2
    // classic heart curve
    const hx = 16 * Math.pow(Math.sin(t), 3)
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    // fill the interior, bias towards the surface for definition
    const f = Math.pow(Math.random(), 0.35)
    const x = hx * f * S
    const y = hy * f * S
    // thickness tapers toward the tip and edges
    const depth = 3.4 * f * (0.35 + 0.65 * Math.max(0, (hy + 17) / 30))
    const z = (Math.random() - 0.5) * depth
    pos[i * 3] = x
    pos[i * 3 + 1] = y + 0.8
    pos[i * 3 + 2] = z
    const mix = Math.min(1, f + Math.abs(z) / 3)
    const c = cCore.clone().lerp(cEdge, mix)
    if (i % 37 === 0) c.copy(cSpark)
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  return { pos, col }
}

function neuralShape(): { pos: Float32Array; col: Float32Array } {
  const pos = new Float32Array(COUNT * 3)
  const col = new Float32Array(COUNT * 3)
  const cGold = new THREE.Color('#C8B89A')
  const cWhite = new THREE.Color('#F5F2EA')
  const cTeal = new THREE.Color('#3EE6C1')
  const R = 9.2
  const GA = Math.PI * (3 - Math.sqrt(5)) // golden angle
  for (let i = 0; i < COUNT; i++) {
    // three concentric fibonacci shells for a "brain lobe" depth feel
    const shell = i % 3
    const r = R * (shell === 0 ? 1 : shell === 1 ? 0.72 : 0.45)
    const k = i / COUNT
    const y = 1 - k * 2
    const rad = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = GA * i
    const noise = 1 + (Math.random() - 0.5) * 0.14
    pos[i * 3] = Math.cos(theta) * rad * r * noise
    pos[i * 3 + 1] = y * r * noise
    pos[i * 3 + 2] = Math.sin(theta) * rad * r * noise
    const c = shell === 0 ? cGold : shell === 1 ? cWhite : cTeal
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  return { pos, col }
}

function ecgPoints(): THREE.Vector3[] {
  // one heartbeat complex (P-QRS-T), repeated across the width
  const beat = [
    [0, 0], [0.08, 0.06], [0.16, 0], [0.22, 0], [0.26, -0.08],
    [0.3, 0.55], [0.34, -0.28], [0.38, 0], [0.5, 0], [0.58, 0.14],
    [0.66, 0], [1, 0],
  ]
  const pts: THREE.Vector3[] = []
  const beats = 6, width = 60
  for (let b = 0; b < beats; b++) {
    for (const [x, y] of beat) {
      pts.push(new THREE.Vector3(((b + x) / beats - 0.5) * width, y * 7 - 10.5, -6))
    }
  }
  return pts
}

export default function VitalsField({ shapeRef }: { shapeRef: React.MutableRefObject<number> }) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x050807, 0.016)
    const camera = new THREE.PerspectiveCamera(48, mount.clientWidth / mount.clientHeight, 0.1, 200)
    camera.position.set(0, 0, 30)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const shapes = [helixShape(), heartShape(), neuralShape()]
    const geometry = new THREE.BufferGeometry()
    const livePos = new Float32Array(shapes[0].pos)
    const liveCol = new Float32Array(shapes[0].col)
    geometry.setAttribute('position', new THREE.BufferAttribute(livePos, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(liveCol, 3))

    const material = new THREE.PointsMaterial({
      size: 0.16,
      map: makeSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // ambient dust for depth
    const dustGeo = new THREE.BufferGeometry()
    const dustN = 900
    const dustPos = new Float32Array(dustN * 3)
    for (let i = 0; i < dustN * 3; i++) dustPos[i] = (Math.random() - 0.5) * 90
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      size: 0.09, map: material.map, color: 0xc8b89a, transparent: true,
      opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    scene.add(dust)

    // ECG trace, revealed by animating drawRange
    const ecgGeo = new THREE.BufferGeometry().setFromPoints(ecgPoints())
    const ecgTotal = ecgGeo.getAttribute('position').count
    const ecg = new THREE.Line(ecgGeo, new THREE.LineBasicMaterial({
      color: 0x3ee6c1, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
    }))
    scene.add(ecg)

    // morph state
    let currentShape = 0
    let fromPos = new Float32Array(shapes[0].pos)
    let fromCol = new Float32Array(shapes[0].col)
    let morphT = 1

    const mouse = { x: 0, y: 0 }
    const onMouse = (e: MouseEvent) => {
      mouse.x = (e.clientX / window.innerWidth - 0.5) * 2
      mouse.y = (e.clientY / window.innerHeight - 0.5) * 2
    }
    window.addEventListener('mousemove', onMouse)

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    const clock = new THREE.Clock()
    let raf = 0
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()

      // shape switch requested from scroll
      const want = Math.max(0, Math.min(2, shapeRef.current | 0))
      if (want !== currentShape) {
        fromPos = new Float32Array(livePos)
        fromCol = new Float32Array(liveCol)
        currentShape = want
        morphT = 0
      }
      if (morphT < 1) morphT = Math.min(1, morphT + 0.016)
      const m = ease(morphT)
      const target = shapes[currentShape]

      // heartbeat envelope — double thump, only meaningful on the heart
      const bt = (t * 1.25) % 1
      const thump = Math.pow(Math.max(0, Math.sin(bt * Math.PI * 2)), 12)
        + 0.55 * Math.pow(Math.max(0, Math.sin((bt - 0.18) * Math.PI * 2)), 12)
      const beatScale = currentShape === 1 ? 1 + thump * 0.055 : 1

      const breathe = 1 + Math.sin(t * 0.5) * 0.012
      const s = beatScale * breathe
      for (let i = 0; i < COUNT * 3; i += 3) {
        const wob = Math.sin(t * 0.8 + i) * 0.03
        livePos[i] = (fromPos[i] + (target.pos[i] - fromPos[i]) * m) * s + wob
        livePos[i + 1] = (fromPos[i + 1] + (target.pos[i + 1] - fromPos[i + 1]) * m) * s
        livePos[i + 2] = (fromPos[i + 2] + (target.pos[i + 2] - fromPos[i + 2]) * m) * s + wob
        liveCol[i] = fromCol[i] + (target.col[i] - fromCol[i]) * m
        liveCol[i + 1] = fromCol[i + 1] + (target.col[i + 1] - fromCol[i + 1]) * m
        liveCol[i + 2] = fromCol[i + 2] + (target.col[i + 2] - fromCol[i + 2]) * m
      }
      geometry.attributes.position.needsUpdate = true
      geometry.attributes.color.needsUpdate = true

      points.rotation.y = t * 0.12
      dust.rotation.y = -t * 0.015

      // ECG sweep
      const sweep = (t * 0.22) % 1.15
      ecgGeo.setDrawRange(0, Math.floor(Math.min(1, sweep) * ecgTotal))

      // camera parallax
      camera.position.x += (mouse.x * 3.2 - camera.position.x) * 0.03
      camera.position.y += (-mouse.y * 2.0 - camera.position.y) * 0.03
      camera.lookAt(0, 0, 0)

      renderer.render(scene, camera)
    }

    if (reduced) {
      // static frame for reduced-motion users
      renderer.render(scene, camera)
    } else {
      animate()
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('resize', onResize)
      geometry.dispose(); material.dispose(); material.map?.dispose()
      dustGeo.dispose(); (dust.material as THREE.Material).dispose()
      ecgGeo.dispose(); (ecg.material as THREE.Material).dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [shapeRef])

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}
