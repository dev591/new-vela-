import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

/**
 * Dot + trailing ring cursor for the landing and sign-in pages only (never the
 * clinical app or the patient portal).
 *
 * - Hovering a link/button grows the ring; `data-cursor="Label"` shows a word
 *   inside it ("Scroll", "Open").
 * - `data-magnetic` elements lean toward the pointer and spring back.
 * - Touch screens and reduced-motion users keep the normal system cursor.
 */
export default function CinematicCursor() {
  const dot = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!fine || reduce || !dot.current || !ring.current) return

    document.documentElement.classList.add('has-cinematic-cursor')
    const dx = gsap.quickTo(dot.current, 'x', { duration: 0.08, ease: 'power3' })
    const dy = gsap.quickTo(dot.current, 'y', { duration: 0.08, ease: 'power3' })
    const rx = gsap.quickTo(ring.current, 'x', { duration: 0.45, ease: 'power3' })
    const ry = gsap.quickTo(ring.current, 'y', { duration: 0.45, ease: 'power3' })

    let magnet: HTMLElement | null = null

    const onMove = (e: PointerEvent) => {
      dx(e.clientX); dy(e.clientY); rx(e.clientX); ry(e.clientY)
      if (magnet) {
        const r = magnet.getBoundingClientRect()
        const mx = e.clientX - (r.left + r.width / 2)
        const my = e.clientY - (r.top + r.height / 2)
        gsap.to(magnet, { x: mx * 0.3, y: my * 0.35, duration: 0.4, ease: 'power3.out' })
      }
    }

    const onOver = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('a, button, [data-cursor], input, textarea, select, [role="button"]')
      const text = el?.closest<HTMLElement>('[data-cursor]')?.dataset.cursor || ''
      const isField = !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
      ring.current!.classList.toggle('is-hover', !!el && !isField)
      ring.current!.classList.toggle('is-label', !!text)
      dot.current!.classList.toggle('is-hidden', !!el && !isField)
      dot.current!.classList.toggle('is-field', isField)
      if (label.current) label.current.textContent = text

      const m = (e.target as HTMLElement).closest<HTMLElement>('[data-magnetic]')
      if (m !== magnet) {
        if (magnet) gsap.to(magnet, { x: 0, y: 0, duration: 0.7, ease: 'elastic.out(1, 0.4)' })
        magnet = m
      }
    }

    const onDown = () => gsap.to(ring.current, { scale: 0.82, duration: 0.15 })
    const onUp = () => gsap.to(ring.current, { scale: 1, duration: 0.35, ease: 'back.out(3)' })
    const onLeave = () => gsap.to([dot.current, ring.current], { opacity: 0, duration: 0.2 })
    const onEnter = () => gsap.to([dot.current, ring.current], { opacity: 1, duration: 0.2 })

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerover', onOver)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    document.addEventListener('pointerleave', onLeave)
    document.addEventListener('pointerenter', onEnter)
    return () => {
      document.documentElement.classList.remove('has-cinematic-cursor')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerover', onOver)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('pointerenter', onEnter)
    }
  }, [])

  return (
    <>
      <div ref={ring} className="vc-ring" aria-hidden="true"><span ref={label} className="vc-label" /></div>
      <div ref={dot} className="vc-dot" aria-hidden="true" />
    </>
  )
}
