import { useEffect, useRef } from 'react'
import Lenis from 'lenis'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/**
 * Lenis smooth scroll, driven by GSAP's ticker so the scroll position and the
 * scrubbed film timeline can never drift apart. Landing page only: the
 * clinical app keeps native scrolling.
 *
 * Returns a ref to the Lenis instance (null with reduced motion) so the film
 * player can move the playhead.
 */
export default function useLenis() {
  const ref = useRef<Lenis | null>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({ duration: 1.1, easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)) })
    ref.current = lenis
    lenis.on('scroll', ScrollTrigger.update)
    const raf = (time: number) => lenis.raf(time * 1000)
    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)
    // The film hides the page scrollbar; its player bar is the scrollbar.
    document.documentElement.classList.add('film-mode')

    return () => {
      document.documentElement.classList.remove('film-mode')
      gsap.ticker.remove(raf)
      lenis.destroy()
      ref.current = null
    }
  }, [])

  return ref
}
