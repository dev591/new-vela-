import { useEffect, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'

/**
 * The landing's protagonist in particle form: thousands of scattered points
 * (a patient's history in pieces) that a scroll-driven `progress` pulls into
 * one shape — an ECG trace on the landing, a ring on the sign-in page.
 *
 * `progress` is a ref, not a prop, so GSAP can scrub it every frame without a
 * React render. The cursor pushes nearby points away. The canvas stops
 * rendering when it scrolls off screen, and its pixel ratio is capped at 1.5
 * so a projector or a mid-range laptop doesn't stutter.
 */

type Shape = 'ecg' | 'ring'

interface Props {
  progress?: MutableRefObject<number>
  shape?: Shape
  count?: number
  color?: string
  className?: string
}

function ecgY(t: number): number {
  // One heartbeat per unit: baseline, P wave, sharp QRS, T wave.
  const x = ((t % 1) + 1) % 1
  if (x < 0.1) return Math.sin((x / 0.1) * Math.PI) * 0.12
  if (x < 0.18) return 0
  if (x < 0.21) return -((x - 0.18) / 0.03) * 0.25
  if (x < 0.25) return -0.25 + ((x - 0.21) / 0.04) * 1.55
  if (x < 0.29) return 1.3 - ((x - 0.25) / 0.04) * 1.75
  if (x < 0.32) return -0.45 + ((x - 0.29) / 0.03) * 0.45
  if (x < 0.45) return 0
  if (x < 0.62) return Math.sin(((x - 0.45) / 0.17) * Math.PI) * 0.28
  return 0
}

function targets(shape: Shape, count: number, width: number): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const t = i / count
    if (shape === 'ecg') {
      const x = (t - 0.5) * width
      out[i * 3] = x
      // Sits below the headline that appears with it.
      out[i * 3 + 1] = ecgY(t * 3.2 + 0.35) * 0.95 - 1.75 + (Math.random() - 0.5) * 0.03
      out[i * 3 + 2] = (Math.random() - 0.5) * 0.08
    } else {
      const a = t * Math.PI * 2
      const r = 2.1 + (Math.random() - 0.5) * 0.12
      out[i * 3] = Math.cos(a) * r
      out[i * 3 + 1] = Math.sin(a) * r
      out[i * 3 + 2] = (Math.random() - 0.5) * 0.15
    }
  }
  return out
}

export default function ParticleField({ progress, shape = 'ecg', count = 2600, color = '#2997FF', className }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' })
    } catch {
      return // no WebGL: the section's own background carries the scene
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.z = 6.5

    const scatter = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // A loose shell, denser near the centre, a little deeper than wide.
      const r = 2 + Math.pow(Math.random(), 0.6) * 4.5
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      scatter[i * 3] = r * Math.sin(ph) * Math.cos(th) * 1.4
      scatter[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.8
      scatter[i * 3 + 2] = r * Math.cos(ph) - 1
    }
    let target = targets(shape, count, 9)
    const pos = new Float32Array(scatter)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) seeds[i] = Math.random()

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uSize: { value: 48 * renderer.getPixelRatio() },
        uFocus: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uSize;
        uniform float uFocus;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = uSize * mix(0.4 + seed * 1.0, 0.6, uFocus);
          gl_PointSize = size / -mv.z;
          vAlpha = mix(0.4 + seed * 0.6, 1.0, uFocus);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float glow = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(uColor, glow * vAlpha);
        }
      `,
    })
    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // Pointer in world units on the z=0 plane.
    const mouse = new THREE.Vector2(999, 999)
    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z
      mouse.set(nx * halfH * camera.aspect, ny * halfH)
    }
    const onLeave = () => mouse.set(999, 999)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)

    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // Fit the ECG to the visible width.
      const halfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect
      if (shape === 'ecg') target = targets(shape, count, halfW * 1.8)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let visible = true
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting })
    io.observe(mount)

    const clock = new THREE.Clock()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (!visible) return
      const t = clock.getElapsedTime()
      const p = reduce ? 1 : Math.min(1, Math.max(0, progress ? progress.current : 0))
      const e = p * p * (3 - 2 * p) // smoothstep: the line "locks" near the end
      material.uniforms.uFocus.value = e
      const arr = geometry.attributes.position.array as Float32Array
      for (let i = 0; i < count; i++) {
        const k = i * 3
        const s = seeds[i]
        // Free particles drift; locked ones hold the shape and pulse gently.
        const drift = (1 - e) * 0.35
        const tx = scatter[k] + (target[k] - scatter[k]) * e + Math.sin(t * 0.3 + s * 40) * drift
        const ty = scatter[k + 1] + (target[k + 1] - scatter[k + 1]) * e + Math.cos(t * 0.25 + s * 30) * drift
        const tz = scatter[k + 2] + (target[k + 2] - scatter[k + 2]) * e
        let x = arr[k] + (tx - arr[k]) * 0.08
        let y = arr[k + 1] + (ty - arr[k + 1]) * 0.08
        const dx = x - mouse.x
        const dy = y - mouse.y
        const d2 = dx * dx + dy * dy
        if (d2 < 1.2) {
          const f = (1.2 - d2) * 0.06
          x += dx * f
          y += dy * f
        }
        arr[k] = x
        arr[k + 1] = y
        arr[k + 2] = arr[k + 2] + (tz - arr[k + 2]) * 0.08
      }
      geometry.attributes.position.needsUpdate = true
      points.rotation.y = (1 - e) * Math.sin(t * 0.08) * 0.35
      if (shape === 'ring') points.rotation.z = t * 0.05
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [shape, count, color, progress])

  return <div ref={mountRef} className={className} aria-hidden="true" />
}
