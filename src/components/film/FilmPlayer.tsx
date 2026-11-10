import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'

/**
 * The film's player bar: play / pause, a timecode, and one segment per
 * chapter. It replaces the page scrollbar, so the landing reads as a video you
 * can also scrub by scrolling.
 *
 * The parent calls `update(seconds)` on every scroll frame. That writes
 * straight to the DOM (bar widths, timecode text); React state changes only
 * when the chapter changes, so scrolling never re-renders the page.
 */

export interface Chapter { name: string; start: number; end: number }
export interface FilmPlayerHandle { update: (seconds: number) => void }

interface Props {
  chapters: Chapter[]
  total: number
  playing: boolean
  onToggle: () => void
  onSeek: (seconds: number) => void
}

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const FilmPlayer = forwardRef<FilmPlayerHandle, Props>(function FilmPlayer({ chapters, total, playing, onToggle, onSeek }, ref) {
  const fills = useRef<(HTMLSpanElement | null)[]>([])
  const time = useRef<HTMLSpanElement>(null)
  const [active, setActive] = useState(0)
  const [ended, setEnded] = useState(false)

  useImperativeHandle(ref, () => ({
    update(seconds: number) {
      if (time.current) time.current.textContent = clock(seconds)
      let now = 0
      chapters.forEach((c, i) => {
        const p = Math.min(1, Math.max(0, (seconds - c.start) / (c.end - c.start)))
        const el = fills.current[i]
        if (el) el.style.transform = `scaleX(${p})`
        if (seconds >= c.start) now = i
      })
      setActive(now)
      setEnded(seconds >= total - 0.05)
    },
  }), [chapters, total])

  const Icon = ended ? RotateCcw : playing ? Pause : Play
  const label = ended ? 'Replay the film' : playing ? 'Pause the film' : 'Play the film'

  return (
    <div className="film-player" role="group" aria-label="Film controls">
      <button type="button" className="film-play" onClick={onToggle} aria-label={label} data-cursor={ended ? 'Replay' : playing ? 'Pause' : 'Play'}>
        <Icon size={18} fill={ended ? 'none' : 'currentColor'} strokeWidth={ended ? 2.4 : 0} />
      </button>

      <div className="film-time" aria-hidden="true">
        <span ref={time}>00:00</span><span className="film-time-total"> / {clock(total)}</span>
      </div>

      <div className="film-chapters">
        {chapters.map((c, i) => (
          <button key={c.name} type="button" className="film-seg" style={{ flexGrow: c.end - c.start }}
            onClick={() => onSeek(c.start)} aria-label={`Jump to chapter: ${c.name}`} aria-current={i === active ? 'true' : undefined}>
            <span className="film-seg-bar"><span ref={(el) => { fills.current[i] = el }} className="film-seg-fill" /></span>
          </button>
        ))}
      </div>

      <div className="film-now" aria-live="polite">{chapters[active].name}</div>
    </div>
  )
})

export default FilmPlayer
