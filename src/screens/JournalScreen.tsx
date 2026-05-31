import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useSpring, useTransform } from 'framer-motion'
import { Sparkles, ChevronDown, ChevronUp, Lock } from 'lucide-react'
import { supabase } from '../lib/supabase'

// ── Constants ────────────────────────────────────────────
const CLAUDE_PROXY    = 'https://ubvlsebzzdltnfvofpva.supabase.co/functions/v1/claude-proxy'
const TZ              = 'Europe/Madrid'
const SUMMARY_CACHE   = 'journal_monthly_summary'   // localStorage mirror of { month, text }
const SEEN_CACHE      = 'journal_seen_month'         // localStorage mirror of seen month key

const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

// ── Types ────────────────────────────────────────────────
type JournalEntry = {
  id: string
  date: string
  mood: number
  thought1: string | null
  thought2: string | null
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────
function madridTodayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

function madridCurrentTime(): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date())
}

function toLocalKey(d: Date): string {
  return d.toLocaleDateString('en-CA')
}

function getScoreGradient(score: number): string {
  if (score <= 3) return 'linear-gradient(90deg, #EF4444, #F97316)'
  if (score <= 6) return 'linear-gradient(90deg, #F97316, #EAB308)'
  if (score <= 8) return 'linear-gradient(90deg, #06B6D4, #10B981)'
  return 'linear-gradient(90deg, #8B5CF6, #06B6D4)'
}

function getScoreColor(score: number): string {
  if (score <= 3) return '#EF4444'
  if (score <= 6) return '#F97316'
  if (score <= 8) return '#06B6D4'
  return '#8B5CF6'
}

function lerpHex(a: string, b: string, t: number): string {
  const p = (s: string) => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)]
  const [ar,ag,ab] = p(a); const [br,bg,bb] = p(b)
  return `rgb(${Math.round(ar+(br-ar)*t)},${Math.round(ag+(bg-ag)*t)},${Math.round(ab+(bb-ab)*t)})`
}

function getSliderColor(value: number): string {
  const stops: [number, string][] = [[1,'#EF4444'],[4,'#F59E0B'],[7,'#06B6D4'],[10,'#8B5CF6']]
  for (let i = 0; i < stops.length - 1; i++) {
    const [va, ca] = stops[i]; const [vb, cb] = stops[i+1]
    if (value <= vb) return lerpHex(ca, cb, (value - va) / (vb - va))
  }
  return stops[stops.length-1][1]
}

function getMoodWord(v: number): string {
  if (v <= 3) return 'agotado'
  if (v <= 6) return 'regular'
  if (v <= 8) return 'bien'
  return 'genial'
}

function getMoodWordRange(v: number): number {
  if (v <= 3) return 0
  if (v <= 6) return 1
  if (v <= 8) return 2
  return 3
}

function formatEntryDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

function msToCountdown(ms: number): { d: number; h: number; m: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  return { d, h, m }
}

// ── Monthly lock logic ───────────────────────────────────
// Boundary = day 1 of a month at 08:00 LOCAL time.
function firstOfMonth8(year: number, month0: number): Date {
  return new Date(year, month0, 1, 8, 0, 0, 0)
}

function monthKeyFor(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`
}

function monthLabelFromKey(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return `${MONTH_NAMES_ES[m - 1]} ${y}`
}

/**
 * Computes the monthly retrospective state relative to `now`.
 * - endedMonthKey: the month that ended at the most recent day-1-08:00 boundary.
 * - nextBoundary: the next day-1-08:00 (when the next month unlocks).
 */
function computeMonthlyState(now: Date): {
  endedMonthKey: string
  endedYear: number
  endedMonth0: number
  nextBoundary: Date
} {
  const y = now.getFullYear()
  const m = now.getMonth()
  const thisFirst8 = firstOfMonth8(y, m)
  const passedThis = now.getTime() >= thisFirst8.getTime()

  const lastBoundary = passedThis ? thisFirst8 : firstOfMonth8(y, m - 1)
  // Month that just ended = the month immediately before the boundary's month.
  const endedDate = new Date(lastBoundary.getFullYear(), lastBoundary.getMonth() - 1, 1)
  const endedYear   = endedDate.getFullYear()
  const endedMonth0 = endedDate.getMonth()

  const nextBoundary = passedThis ? firstOfMonth8(y, m + 1) : thisFirst8

  return {
    endedMonthKey: monthKeyFor(endedYear, endedMonth0),
    endedYear,
    endedMonth0,
    nextBoundary,
  }
}

// ── useTypewriter ─────────────────────────────────────────
function useTypewriter(text: string, msPerWord = 80) {
  const [displayed, setDisplayed] = useState<string[]>([])

  useEffect(() => {
    setDisplayed([])
    if (!text) return
    const words = text.split(' ')
    let i = 0
    const id = setInterval(() => {
      if (i >= words.length) { clearInterval(id); return }
      setDisplayed(prev => [...prev, words[i]])
      i++
    }, msPerWord)
    return () => clearInterval(id)
  }, [text, msPerWord])

  return displayed
}

// ── NeonSlider (floating, no card wrapper) ────────────────
const THUMB  = 52
const MARGIN = 6

function NeonSlider({
  score, onChange, readOnly = false,
}: {
  score: number
  onChange?: (v: number) => void
  readOnly?: boolean
}) {
  const capsuleRef               = useRef<HTMLDivElement>(null)
  const isDraggingRef            = useRef(false)
  const [liveValue,  setLiveValue]  = useState<number | null>(null)
  const [, setIsDragging]           = useState(false)
  const [, setPrevRange]            = useState<number>(-1)

  const displayValue = liveValue ?? score
  const pct          = displayValue === 0 ? 0 : (displayValue - 1) / 9
  const color        = displayValue === 0 ? 'rgba(255,255,255,0.25)' : getSliderColor(displayValue)
  const glowColor    = displayValue === 0 ? 'rgba(139,92,246,0.5)' : getSliderColor(displayValue)
  const fillOpacity  = displayValue === 0 ? 0 : 0.15
  const snappedInt   = Math.round(displayValue)
  const moodWord     = getMoodWord(snappedInt)
  const moodRange    = getMoodWordRange(snappedInt)

  // Spring for thumb position (0–1)
  const springPct = useSpring(pct, { stiffness: 400, damping: 28, mass: 0.8 })
  const thumbLeft = useTransform(
    springPct,
    p => `calc(${MARGIN}px + ${p} * (100% - ${THUMB + MARGIN * 2}px))`
  )
  const fillW = useTransform(
    springPct,
    p => `calc(${MARGIN}px + ${p} * (100% - ${THUMB + MARGIN * 2}px) + ${THUMB / 2 + MARGIN}px)`
  )

  useEffect(() => { springPct.set(pct) }, [pct, springPct])

  const calcValue = (clientX: number): number => {
    if (!capsuleRef.current) return score
    const rect   = capsuleRef.current.getBoundingClientRect()
    const usable = rect.width - THUMB - MARGIN * 2
    const p      = Math.max(0, Math.min(1, (clientX - rect.left - MARGIN - THUMB / 2) / usable))
    return 1 + p * 9
  }

  const onDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    setLiveValue(calcValue(e.clientX))
  }

  const onMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return
    setLiveValue(calcValue(e.clientX))
  }

  const onUp = () => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    setIsDragging(false)
    const snapped = Math.max(1, Math.min(10, Math.round(liveValue ?? score)))
    setLiveValue(null)
    onChange?.(snapped)
  }

  // Track range changes for mood word crossfade
  useEffect(() => {
    if (displayValue > 0) setPrevRange(moodRange)
  }, [moodRange, displayValue])

  const showMoodWord = displayValue > 0

  return (
    <div style={{ marginTop: 28 }}>
      {/* Mood word with crossfade */}
      <div style={{ height: 24, position: 'relative', marginBottom: 12 }}>
        <AnimatePresence mode="wait">
          {showMoodWord && (
            <motion.div
              key={moodRange}
              initial={{ opacity: 0, y: 4, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -4, filter: 'blur(4px)' }}
              transition={{ duration: 0.22 }}
              style={{
                position: 'absolute', width: '100%',
                textAlign: 'center', fontSize: 13,
                fontWeight: 500, letterSpacing: '0.5px',
                color: color,
                textTransform: 'uppercase',
              }}
            >
              {moodWord}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Slider + ambient indirect glow behind it */}
      <div style={{ position: 'relative' }}>
        {/* ── Ambient glow (soft blurred neon, like Body's calorie circle) ── */}
        <motion.div
          aria-hidden
          animate={{ opacity: displayValue === 0 ? 0.22 : [0.4, 0.55, 0.4] }}
          transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
          style={{
            position: 'absolute', inset: '-22px 8%', borderRadius: '50%',
            background: `radial-gradient(ellipse at center, ${glowColor} 0%, transparent 70%)`,
            filter: 'blur(38px)',
            pointerEvents: 'none', zIndex: 0,
          }}
        />

        <div
          ref={capsuleRef}
          style={{
            position: 'relative', zIndex: 1, height: 64, borderRadius: 32,
            background: 'rgba(255,255,255,0.06)',
            border: '0.5px solid rgba(255,255,255,0.1)',
            backdropFilter: 'blur(10px)',
            overflow: 'hidden',
            cursor: readOnly ? 'default' : 'grab',
            touchAction: 'none', userSelect: 'none',
          }}
          onPointerDown={readOnly ? undefined : onDown}
          onPointerMove={readOnly ? undefined : onMove}
          onPointerUp={readOnly   ? undefined : onUp}
          onPointerCancel={readOnly ? undefined : onUp}
        >
          {/* Fill with gradient */}
          <motion.div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: fillW,
            background: color, opacity: fillOpacity, borderRadius: 32,
          }} />

          {/* Thumb with spring motion */}
          <motion.div style={{
            position: 'absolute',
            left: thumbLeft,
            top: '50%',
            translateY: '-50%',
            width: THUMB, height: THUMB, borderRadius: '50%',
            background: color,
            pointerEvents: 'none', zIndex: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {/* Halo */}
            <motion.div
              animate={{
                boxShadow: [
                  `0 0 16px 4px ${color}55`,
                  `0 0 28px 10px ${color}33`,
                  `0 0 16px 4px ${color}55`,
                ],
              }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              style={{
                position: 'absolute', inset: -6, borderRadius: '50%',
                pointerEvents: 'none',
              }}
            />

            {/* Number with pop */}
            <AnimatePresence mode="wait">
              <motion.span
                key={snappedInt}
                initial={{ scale: 1.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                style={{ fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1, position: 'relative', zIndex: 1 }}
              >
                {snappedInt === 0 ? '' : snappedInt}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>

      {/* Scale labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>1</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>10</span>
      </div>
    </div>
  )
}

// ── Atlas Reflection (typewriter + connector + collapse) ──
function ReflectionCard({ text }: { text: string }) {
  const words = useTypewriter(text, 70)
  const [connectorDone, setConnectorDone] = useState(false)
  const [collapsed, setCollapsed]         = useState(false)

  return (
    <div style={{ position: 'relative', marginTop: 8 }}>
      {/* Animated connector */}
      <svg
        width="32" height="32"
        style={{ display: 'block', margin: '0 auto', overflow: 'visible' }}
        viewBox="0 0 2 32"
      >
        <motion.line
          x1="1" y1="0" x2="1" y2="32"
          stroke="url(#connectorGrad)"
          strokeWidth="1.5"
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          onAnimationComplete={() => setConnectorDone(true)}
        />
        <defs>
          <linearGradient id="connectorGrad" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.5" />
          </linearGradient>
        </defs>
      </svg>

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: connectorDone ? 1 : 0, y: connectorDone ? 0 : 6 }}
        transition={{ duration: 0.3 }}
        style={{
          background: 'rgba(139,92,246,0.07)',
          border: '0.5px solid rgba(139,92,246,0.25)',
          borderRadius: 14, padding: 16,
          boxShadow: '0 0 20px rgba(139,92,246,0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: collapsed ? 0 : 10 }}>
          <Sparkles size={10} color="#06B6D4" />
          <span style={{ fontSize: 10, color: '#06B6D4', letterSpacing: '1.5px' }}>ATLAS</span>
          {/* Collapse / hide toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Mostrar reflexión' : 'Ocultar reflexión'}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              padding: 2, display: 'flex', alignItems: 'center',
            }}
          >
            {collapsed
              ? <ChevronDown size={14} color="rgba(255,255,255,0.3)" />
              : <ChevronUp   size={14} color="rgba(255,255,255,0.3)" />}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.75 }}>
                {words.map((w, i) => (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0, filter: 'blur(3px)' }}
                    animate={{ opacity: 1, filter: 'blur(0px)' }}
                    transition={{ duration: 0.2 }}
                    style={{ marginRight: 4, display: 'inline-block' }}
                  >
                    {w}
                  </motion.span>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

// ── Mood Chart (weekly / monthly) ─────────────────────────
function MoodChart({ entries, todayEntry }: { entries: JournalEntry[]; todayEntry: JournalEntry | null }) {
  const [range, setRange] = useState<'week' | 'month'>('week')

  const today = madridTodayKey()
  const all = [...(todayEntry ? [todayEntry] : []), ...entries]

  const data: { date: string; mood: number }[] = (() => {
    const days = range === 'week' ? 7 : 30
    const result: { date: string; mood: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today + 'T00:00:00')
      d.setDate(d.getDate() - i)
      const ds = d.toLocaleDateString('en-CA')
      const entry = all.find(e => e.date === ds)
      result.push({ date: ds, mood: entry?.mood ?? 0 })
    }
    return result
  })()

  const maxMood = 10
  const BAR_H   = 80

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '0.5px solid rgba(255,255,255,0.08)',
        borderRadius: 18,
        borderTop: '1px solid rgba(139,92,246,0.35)',
        padding: '16px 16px 12px',
        marginTop: 28,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: '1.5px' }}>ÁNIMO</span>
        {/* Toggle */}
        <div style={{
          display: 'flex', borderRadius: 20, overflow: 'hidden',
          border: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)',
        }}>
          {(['week', 'month'] as const).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '4px 12px', fontSize: 10, border: 'none', cursor: 'pointer',
                fontFamily: 'Inter, sans-serif', letterSpacing: '0.5px',
                background: range === r ? 'rgba(139,92,246,0.25)' : 'transparent',
                color: range === r ? '#fff' : 'rgba(255,255,255,0.35)',
                transition: 'all 0.2s',
              }}
            >
              {r === 'week' ? '7D' : '30D'}
            </button>
          ))}
        </div>
      </div>

      {/* Bars */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: range === 'month' ? 2 : 4,
        height: BAR_H + 20, paddingBottom: 20, position: 'relative',
      }}>
        {data.map((d, i) => {
          const pct   = d.mood > 0 ? d.mood / maxMood : 0
          const color = d.mood > 0 ? getScoreColor(d.mood) : 'rgba(255,255,255,0.06)'
          const isToday = d.date === today
          const dayLbl = range === 'week'
            ? new Date(d.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'narrow' })
            : (i % 5 === 0 ? new Date(d.date + 'T00:00:00').getDate().toString() : '')

          return (
            <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: pct * BAR_H }}
                transition={{ duration: 0.5, delay: i * 0.02, ease: 'easeOut' }}
                style={{
                  width: '100%', borderRadius: 4,
                  background: d.mood > 0
                    ? `linear-gradient(180deg, ${color}, ${color}88)`
                    : color,
                  boxShadow: isToday && d.mood > 0 ? `0 0 8px ${color}66` : 'none',
                  border: isToday ? `0.5px solid ${color}` : 'none',
                  minHeight: pct > 0 ? 4 : 2,
                  alignSelf: 'flex-end',
                }}
              />
              {dayLbl && (
                <span style={{
                  fontSize: 9, color: isToday ? '#fff' : 'rgba(255,255,255,0.2)',
                  fontWeight: isToday ? 600 : 400,
                }}>
                  {dayLbl}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </motion.div>
  )
}

// ── FlipCard ──────────────────────────────────────────────
function FlipCard({ value, label }: { value: number; label: string }) {
  const str     = String(value).padStart(2, '0')
  const prevRef = useRef(str)
  const [flip, setFlip] = useState(false)

  useEffect(() => {
    if (prevRef.current !== str) {
      setFlip(true)
      const id = setTimeout(() => {
        setFlip(false)
        prevRef.current = str
      }, 350)
      return () => clearTimeout(id)
    }
  }, [str])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{
        position: 'relative', width: 56, height: 64,
        perspective: '200px',
      }}>
        {/* Static back (new value) */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 10,
          background: 'rgba(139,92,246,0.12)',
          border: '0.5px solid rgba(139,92,246,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 26, fontWeight: 700, color: '#fff',
          fontVariantNumeric: 'tabular-nums',
          backdropFilter: 'blur(10px)',
        }}>
          {str}
        </div>
        {/* Animated flap (old value) */}
        <AnimatePresence>
          {flip && (
            <motion.div
              key={prevRef.current}
              initial={{ rotateX: 0 }}
              animate={{ rotateX: -90 }}
              exit={{}}
              transition={{ duration: 0.18, ease: 'easeIn' }}
              style={{
                position: 'absolute', inset: 0, borderRadius: 10,
                background: 'rgba(139,92,246,0.18)',
                border: '0.5px solid rgba(139,92,246,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 26, fontWeight: 700, color: '#fff',
                fontVariantNumeric: 'tabular-nums',
                transformOrigin: 'center bottom',
                backfaceVisibility: 'hidden',
                zIndex: 2,
              }}
            >
              {prevRef.current}
            </motion.div>
          )}
        </AnimatePresence>
        {/* Crease line */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '50%',
          height: '0.5px', background: 'rgba(0,0,0,0.3)', zIndex: 3,
          pointerEvents: 'none',
        }} />
      </div>
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '1.5px' }}>{label}</span>
    </div>
  )
}

// ── Monthly retrospective (lock + countdown + unlock) ─────
function MonthlyInsight({
  seenMonth, loading, onOpen,
}: {
  seenMonth: string | null
  loading: boolean
  onOpen: (endedYear: number, endedMonth0: number, endedMonthKey: string) => void
}) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const { endedMonthKey, endedYear, endedMonth0, nextBoundary } = computeMonthlyState(now)
  const unlocked  = endedMonthKey !== seenMonth
  const endedName = monthLabelFromKey(endedMonthKey)
  const { d, h, m } = msToCountdown(nextBoundary.getTime() - now.getTime())
  const nextOpenLabel = `${nextBoundary.getDate()} de ${MONTH_NAMES_ES[nextBoundary.getMonth()]}`

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.04)', marginBottom: 20 }} />

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <div style={{ position: 'relative', width: 22, height: 22, flexShrink: 0 }}>
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
            style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)',
            }}
          />
          <div style={{
            position: 'absolute', inset: 1.5, borderRadius: '50%', background: '#080810',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={10} color="#fff" />
          </div>
        </div>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>
          Retrospectiva mensual
        </span>
      </div>

      {/* ── LOADING ── */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
          <div style={{ position: 'relative', width: 48, height: 48 }}>
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)',
              }}
            />
            <div style={{
              position: 'absolute', inset: 2, borderRadius: '50%', background: '#080810',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Sparkles size={16} color="#fff" />
            </div>
          </div>
        </div>
      )}

      {/* ── UNLOCKED: glowing button, one shot ── */}
      {!loading && unlocked && (
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => onOpen(endedYear, endedMonth0, endedMonthKey)}
          animate={{
            boxShadow: [
              '0 0 18px rgba(139,92,246,0.35), 0 0 36px rgba(6,182,212,0.15)',
              '0 0 28px rgba(139,92,246,0.6), 0 0 56px rgba(6,182,212,0.3)',
              '0 0 18px rgba(139,92,246,0.35), 0 0 36px rgba(6,182,212,0.15)',
            ],
          }}
          transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }}
          style={{
            width: '100%', borderRadius: 14, padding: '15px 0',
            background: 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(6,182,212,0.2))',
            border: '0.5px solid rgba(139,92,246,0.6)',
            color: '#fff', fontSize: 14, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif', fontWeight: 500,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          <Sparkles size={15} color="#fff" />
          Abrir retrospectiva de {endedName}
        </motion.button>
      )}

      {/* ── LOCKED: lock icon + flip countdown ── */}
      {!loading && !unlocked && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            width: '100%', borderRadius: 14, padding: '12px 0', marginBottom: 18,
            background: 'rgba(255,255,255,0.03)',
            border: '0.5px solid rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.35)', fontSize: 12,
            fontFamily: 'Inter, sans-serif', cursor: 'default',
          }}>
            <Lock size={13} color="rgba(255,255,255,0.3)" />
            Se desbloquea el {nextOpenLabel} · 08:00
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
            <FlipCard value={d} label="DÍAS" />
            <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginBottom: 16 }}>:</div>
            <FlipCard value={h} label="HORAS" />
            <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginBottom: 16 }}>:</div>
            <FlipCard value={m} label="MIN" />
          </div>
        </>
      )}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────
export default function JournalScreen() {
  const [todayEntry,             setTodayEntry]             = useState<JournalEntry | null>(null)
  const [history,                setHistory]                = useState<JournalEntry[]>([])
  const [loading,                setLoading]                = useState(true)
  const [editMode,               setEditMode]               = useState(false)
  const [score,                  setScore]                  = useState(0)
  const [notes,                  setNotes]                  = useState('')
  const [saving,                 setSaving]                 = useState(false)
  const [saveError,              setSaveError]              = useState('')
  const [expandedId,             setExpandedId]             = useState<string | null>(null)
  const [notesFocused,           setNotesFocused]           = useState(false)
  const [currentTime,            setCurrentTime]            = useState(madridCurrentTime())

  // Monthly retrospective state
  const [monthlyInsight,         setMonthlyInsight]         = useState<string | null>(null)
  const [monthlyInsightMonth,    setMonthlyInsightMonth]    = useState<string | null>(null)
  const [monthlyInsightLoading,  setMonthlyInsightLoading]  = useState(false)
  const [monthlyInsightVisible,  setMonthlyInsightVisible]  = useState(false)
  const [seenMonth,              setSeenMonth]              = useState<string | null>(null)

  // Update clock every minute
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(madridCurrentTime()), 60_000)
    return () => clearInterval(id)
  }, [])

  // ── Load data ──────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    const today = madridTodayKey()

    const [{ data: todayData }, { data: histData }] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('*')
        .eq('date', today)
        .maybeSingle(),
      supabase
        .from('journal_entries')
        .select('*')
        .neq('date', today)
        .order('date', { ascending: false })
        .limit(30),
    ])

    setTodayEntry(todayData as JournalEntry | null)
    setHistory((histData as JournalEntry[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ── Load persisted retrospective state (localStorage mirror + Supabase truth) ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SUMMARY_CACHE)
      if (raw) {
        const { month, text } = JSON.parse(raw) as { month: string; text: string }
        if (text) { setMonthlyInsight(text); setMonthlyInsightMonth(month); setMonthlyInsightVisible(true) }
      }
      const sm = localStorage.getItem(SEEN_CACHE)
      if (sm) setSeenMonth(sm)
    } catch { /* ignore */ }

    supabase
      .from('user_settings')
      .select('key, value')
      .in('key', ['journal_seen_month', 'journal_monthly_summary'])
      .then(({ data }) => {
        if (!data) return
        data.forEach(row => {
          if (row.key === 'journal_seen_month' && row.value) {
            setSeenMonth(row.value)
            try { localStorage.setItem(SEEN_CACHE, row.value) } catch { /* ignore */ }
          }
          if (row.key === 'journal_monthly_summary' && row.value) {
            try {
              const { month, text } = JSON.parse(row.value) as { month: string; text: string }
              if (text) { setMonthlyInsight(text); setMonthlyInsightMonth(month); setMonthlyInsightVisible(true) }
            } catch { /* ignore */ }
          }
        })
      })
  }, [])

  // ── Edit mode init ─────────────────────────────────────
  const startEdit = () => {
    if (!todayEntry) return
    setScore(todayEntry.mood)
    setNotes(todayEntry.thought1 ?? '')
    setEditMode(true)
  }

  // ── Save check-in ──────────────────────────────────────
  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setSaveError('')

    try {
      const today = madridTodayKey()

      let entryId: string
      if (editMode && todayEntry) {
        const { data, error } = await supabase
          .from('journal_entries')
          .update({ mood: score, thought1: notes })
          .eq('id', todayEntry.id)
          .select('id')
          .single()
        if (error) throw error
        entryId = data.id
      } else {
        const { data, error } = await supabase
          .from('journal_entries')
          .insert([{ date: today, mood: score, thought1: notes }])
          .select('id')
          .single()
        if (error) throw error
        entryId = data.id
      }

      // Atlas reflection
      let reflection = ''
      try {
        const res = await fetch(CLAUDE_PROXY, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 200,
            system: 'Eres Atlas. Respondes de forma directa, empática y sin filtros. Máximo 60 palabras.',
            messages: [{
              role: 'user',
              content: `Mi puntuación de hoy es ${score}/10. ${notes || 'Sin notas adicionales.'}. Dame una reflexión breve y honesta sobre mi día.`,
            }],
          }),
        })
        const d = await res.json()
        reflection = d.content?.[0]?.text ?? ''
      } catch { /* continue without reflection */ }

      if (reflection) {
        await supabase
          .from('journal_entries')
          .update({ thought2: reflection })
          .eq('id', entryId)
      }

      // Atlas memory
      const summary = `${today}: score ${score}/10. ${(notes || '').split(' ').slice(0, 20).join(' ')}`
      await supabase.from('atlas_memory').insert([{
        category: 'emociones',
        summary,
        raw_text: notes || `Check-in ${score}/10`,
      }])

      setEditMode(false)
      await loadData()
    } catch (e: unknown) {
      const err = e as Record<string, unknown>
      console.error('[Journal] Save error:', JSON.stringify(e, null, 2))
      const parts = [
        err.message  != null ? `message: ${err.message}`   : null,
        err.code     != null ? `code: ${err.code}`         : null,
        err.details  != null ? `details: ${err.details}`   : null,
        err.hint     != null ? `hint: ${err.hint}`         : null,
      ].filter(Boolean)
      setSaveError(
        parts.length > 0
          ? parts.join(' | ')
          : (e instanceof Error ? e.message : `Error desconocido: ${JSON.stringify(e)}`)
      )
    } finally {
      setSaving(false)
    }
  }

  // ── Monthly retrospective: deep cross-data analysis ─────
  const runMonthlyInsight = useCallback(async (ey: number, em0: number, key: string) => {
    if (monthlyInsightLoading) return
    setMonthlyInsightLoading(true)
    try {
      const start = new Date(ey, em0, 1)
      const end   = new Date(ey, em0 + 1, 1)
      const startKey = toLocalKey(start)
      const endKey   = toLocalKey(end)
      const startISO = start.toISOString()
      const endISO   = end.toISOString()
      const endedName = monthLabelFromKey(key)

      const [journalRes, mealsRes, progressRes, tasksRes, settingsRes] = await Promise.all([
        supabase.from('journal_entries').select('*')
          .gte('date', startKey).lt('date', endKey).order('date', { ascending: true }),
        supabase.from('meals').select('created_at, name, calories, protein, carbs, fat')
          .gte('created_at', startISO).lt('created_at', endISO),
        supabase.from('progress_entries').select('*')
          .gte('date', startKey).lt('date', endKey).order('date', { ascending: true }),
        supabase.from('tasks').select('title, status, priority, postponed_count, created_at')
          .gte('created_at', startISO).lt('created_at', endISO),
        supabase.from('user_settings').select('key, value')
          .in('key', ['goal_calories', 'goal_protein', 'goal_carbs', 'goal_fat']),
      ])

      // ── Settings / goals ──
      const settingsMap: Record<string, number> = {}
      ;(settingsRes.data ?? []).forEach(r => {
        const v = parseInt(r.value, 10); if (!isNaN(v)) settingsMap[r.key] = v
      })
      const goalCal = settingsMap.goal_calories || 2200

      // ── Journal ──
      const jrows = (journalRes.data ?? []) as Array<Record<string, unknown>>
      const journalStr = jrows.length
        ? jrows.map(e => {
            const parts = [`ánimo ${e.mood}/10`]
            if (e.energy != null)       parts.push(`energía ${e.energy}/10`)
            if (e.productivity != null) parts.push(`prod ${e.productivity}/10`)
            if (e.overall != null)      parts.push(`global ${e.overall}/10`)
            const note = String(e.thought1 ?? '').trim()
            return `${e.date}: ${parts.join(', ')}${note ? ` — "${note}"` : ''}`
          }).join('\n')
        : 'Sin entradas de journal este mes.'

      // ── Body: daily calorie totals + progress entries ──
      const meals = (mealsRes.data ?? []) as Array<Record<string, number | string>>
      const byDay: Record<string, { cal: number; p: number; c: number; f: number }> = {}
      meals.forEach(mr => {
        const k = toLocalKey(new Date(mr.created_at as string))
        const o = (byDay[k] ??= { cal: 0, p: 0, c: 0, f: 0 })
        o.cal += Number(mr.calories ?? 0)
        o.p   += Number(mr.protein  ?? 0)
        o.c   += Number(mr.carbs    ?? 0)
        o.f   += Number(mr.fat      ?? 0)
      })
      const calDays = Object.entries(byDay).sort()
      const daysOnTarget = calDays.filter(([, o]) => o.cal >= goalCal * 0.9 && o.cal <= goalCal * 1.1).length
      const mealDaysStr = calDays.length
        ? calDays.map(([d, o]) => `${d}: ${o.cal} kcal (P${o.p}/C${o.c}/G${o.f})`).join('\n') +
          `\n→ Objetivo ${goalCal} kcal · días en rango (±10%): ${daysOnTarget}/${calDays.length}`
        : `Sin comidas registradas. Objetivo: ${goalCal} kcal.`

      const progress = (progressRes.data ?? []) as Array<Record<string, unknown>>
      const progStr = progress.length
        ? progress.map(p => {
            const meas = (p.measurements ?? {}) as Record<string, number>
            const w    = meas.body_weight
            const prs  = ((p.prs ?? []) as Array<{ name: string; weight?: number; reps?: number }>)
              .filter(x => x.weight || x.reps)
              .map(x => `${x.name} ${x.weight ?? ''}kg${x.reps ? `x${x.reps}` : ''}`).join(', ')
            return `${p.date}: ${w ? `${w}kg` : 'sin peso'}${prs ? ` | PRs: ${prs}` : ''}`
          }).join('\n')
        : 'Sin entradas de progreso (entrenos/medidas) este mes.'

      // ── Feed: tasks done vs postponed ──
      const tasks = (tasksRes.data ?? []) as Array<Record<string, number | string>>
      const done       = tasks.filter(t => t.status === 'done').length
      const postponed  = tasks.filter(t => t.status === 'postponed' || Number(t.postponed_count) > 0).length
      const discarded  = tasks.filter(t => t.status === 'discarded').length
      const pending    = tasks.filter(t => t.status === 'pending').length
      const totalPost  = tasks.reduce((s, t) => s + Number(t.postponed_count ?? 0), 0)
      const tasksStr = tasks.length
        ? `Total ${tasks.length} tareas: hechas ${done}, pospuestas ${postponed}, descartadas ${discarded}, pendientes ${pending}. Posposiciones totales: ${totalPost}.`
        : 'Sin tareas registradas este mes.'

      const prompt =
`Haz una RETROSPECTIVA PROFUNDA del mes de ${endedName} cruzando TODOS los datos. Nada de frases genéricas, motivacionales ni de relleno. Quiero conclusiones que solo se puedan sacar mirando estos datos concretos.

Estructura tu respuesta en 3 bloques:
1. PATRONES NO OBVIOS: correlaciones entre ánimo/energía/productividad y los entrenamientos, la alimentación o las tareas. Cita ejemplos concretos CON FECHAS.
2. QUÉ FUNCIONÓ Y QUÉ NO: respáldalo con los números.
3. APRENDIZAJES ACCIONABLES para el mes que viene: concretos y derivados de lo que pasó este mes.

Máximo ~280 palabras. Directo.

=== JOURNAL (ánimo/energía/productividad/global + notas) ===
${journalStr}

=== CUERPO (calorías diarias vs objetivo, entrenos/PRs/medidas) ===
${mealDaysStr}

PROGRESO:
${progStr}

=== TAREAS (Feed) ===
${tasksStr}`

      const res = await fetch(CLAUDE_PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 800,
          system: 'Eres Atlas, un coach personal analítico y directo. Sin rodeos, sin frases motivacionales vacías. Responde solo el análisis.',
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const d    = await res.json()
      const text = d.content?.[0]?.text ?? ''

      if (text) {
        setMonthlyInsight(text)
        setMonthlyInsightMonth(key)
        setMonthlyInsightVisible(true)
        setSeenMonth(key)  // mark this month as seen → re-locks, countdown to next month

        const cache = JSON.stringify({ month: key, text })
        try {
          localStorage.setItem(SUMMARY_CACHE, cache)
          localStorage.setItem(SEEN_CACHE, key)
        } catch { /* ignore */ }

        await Promise.all([
          supabase.from('user_settings').upsert({ key: 'journal_seen_month', value: key }, { onConflict: 'key' }),
          supabase.from('user_settings').upsert({ key: 'journal_monthly_summary', value: cache }, { onConflict: 'key' }),
        ])
      }
    } catch (e) {
      console.error('[Journal] Monthly insight error:', e)
    } finally {
      setMonthlyInsightLoading(false)
    }
  }, [monthlyInsightLoading])

  // ── Derived ────────────────────────────────────────────
  const showForm  = !todayEntry || editMode
  const today     = madridTodayKey()
  const showReflection = todayEntry?.thought2 && todayEntry.date === today

  // ── Render ─────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', overflow: 'hidden', height: '100%' }}>

      {/* ── Depth orbs ── */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute', width: 350, height: 350, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 65%)',
          top: -150, left: '50%', transform: 'translateX(-50%)',
          filter: 'blur(70px)',
        }} />
        <div style={{
          position: 'absolute', width: 280, height: 280, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 65%)',
          bottom: 100, right: -80,
          filter: 'blur(60px)',
        }} />
      </div>

      {/* ── Single scroll container (height:100% + overflowY:auto) ── */}
      <div style={{ position: 'relative', zIndex: 1, height: '100%', overflowY: 'auto', padding: '24px 20px 40px' }}>

        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
            {[80, 48, 120].map((h, i) => (
              <motion.div key={i}
                animate={{ opacity: [0.3, 0.6, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.6, delay: i * 0.2 }}
                style={{ height: h, borderRadius: 14, background: 'rgba(255,255,255,0.03)' }}
              />
            ))}
          </div>
        )}

        {!loading && (
          <>
            {/* ══ CHECK-IN SECTION ══ */}

            {showForm && (
              <div style={{ marginTop: 16 }}>
                {/* Question */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 300, color: 'rgba(255,255,255,0.8)', letterSpacing: '-0.3px', lineHeight: 1.3 }}>
                    ¿Cómo ha ido el día?
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginTop: 6 }}>
                    {currentTime}
                  </div>
                </div>

                {/* Slider — floating, no extra card wrapper */}
                <NeonSlider score={score} onChange={setScore} />

                {/* Notes textarea */}
                <div style={{ marginTop: 24 }}>
                  <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    onFocus={() => setNotesFocused(true)}
                    onBlur={() => setNotesFocused(false)}
                    placeholder="¿Qué vale la pena recordar de hoy?"
                    rows={4}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: 'rgba(255,255,255,0.04)',
                      border: `0.5px solid ${notesFocused ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: 14, padding: 14,
                      color: '#fff', fontSize: 14, lineHeight: 1.6,
                      fontFamily: 'Inter, sans-serif',
                      outline: 'none', resize: 'none', minHeight: 100,
                      transition: 'border-color 0.2s',
                    }}
                  />
                </div>

                <motion.button
                  whileTap={score === 0 ? {} : { scale: 0.98 }}
                  onClick={score === 0 ? undefined : handleSave}
                  disabled={saving || score === 0}
                  style={{
                    width: '100%', borderRadius: 14, padding: '14px 0',
                    background: '#080810',
                    border: '0.5px solid rgba(139,92,246,0.4)',
                    cursor: (saving || score === 0) ? 'default' : 'pointer',
                    fontSize: 14, color: '#fff', fontFamily: 'Inter, sans-serif',
                    fontWeight: 400, letterSpacing: '0.3px',
                    opacity: saving ? 0.7 : score === 0 ? 0.3 : 1,
                    marginTop: 16,
                    transition: 'opacity 0.3s ease',
                    pointerEvents: score === 0 ? 'none' : 'auto',
                  }}
                >
                  {saving ? 'Guardando...' : 'Guardar'}
                </motion.button>

                {saveError && (
                  <div style={{
                    marginTop: 12, padding: '10px 14px', borderRadius: 10,
                    background: 'rgba(239,68,68,0.1)', border: '0.5px solid rgba(239,68,68,0.4)',
                    fontSize: 12, color: '#EF4444', lineHeight: 1.6,
                    wordBreak: 'break-all',
                  }}>
                    {saveError}
                  </div>
                )}

                {editMode && (
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setEditMode(false)}
                    style={{
                      width: '100%', marginTop: 8, padding: '10px 0',
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 12, color: '#444', fontFamily: 'Inter, sans-serif',
                    }}
                  >
                    Cancelar
                  </motion.button>
                )}
              </div>
            )}

            {/* ══ SAVED VIEW ══ */}
            {!showForm && todayEntry && (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                style={{ marginTop: 16 }}
              >
                {/* Read-only slider */}
                <NeonSlider score={todayEntry.mood} readOnly />

                {/* Notes */}
                {todayEntry.thought1 && (
                  <div style={{
                    marginTop: 20, fontSize: 14, color: 'rgba(255,255,255,0.55)',
                    lineHeight: 1.7, padding: '14px', borderRadius: 14,
                    background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.06)',
                  }}>
                    {todayEntry.thought1}
                  </div>
                )}

                {/* Atlas reflection — only today's entry */}
                <AnimatePresence>
                  {showReflection && (
                    <ReflectionCard text={todayEntry.thought2!} />
                  )}
                </AnimatePresence>

                {/* Edit button */}
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={startEdit}
                  style={{
                    marginTop: 16, padding: '8px 20px', borderRadius: 10,
                    background: 'rgba(255,255,255,0.04)', border: '0.5px solid #1e1e1e',
                    color: '#555', fontSize: 12, fontFamily: 'Inter, sans-serif',
                    cursor: 'pointer',
                  }}
                >
                  Editar
                </motion.button>
              </motion.div>
            )}

            {/* ══ GRÁFICA SEMANAL/MENSUAL ══ */}
            {(history.length > 0 || todayEntry) && (
              <MoodChart entries={history} todayEntry={todayEntry} />
            )}

            {/* ══ HISTORIAL ══ */}
            {history.length > 0 && (
              <div style={{ marginTop: 28 }}>
                <div style={{ fontSize: 9, color: '#252525', letterSpacing: '2.5px', marginBottom: 12 }}>
                  HISTORIAL
                </div>

                <div>
                  {history.map((entry, i) => {
                    const isExpanded = expandedId === entry.id
                    const eColor     = getScoreColor(entry.mood)
                    const eGradient  = getScoreGradient(entry.mood)

                    return (
                      <div key={entry.id}>
                        {i > 0 && (
                          <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.04)' }} />
                        )}
                        <motion.div
                          whileTap={{ opacity: 0.7 }}
                          onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                          style={{ padding: '12px 0', cursor: 'pointer' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', minWidth: 90, flexShrink: 0 }}>
                              {formatEntryDate(entry.date)}
                            </div>
                            <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                              <div style={{
                                width: `${entry.mood * 10}%`, height: '100%',
                                background: eGradient, borderRadius: 2,
                              }} />
                            </div>
                            <div style={{ fontSize: 12, color: eColor, fontWeight: 500, minWidth: 32, textAlign: 'right' }}>
                              {entry.mood}/10
                            </div>
                            <div style={{ flexShrink: 0 }}>
                              {isExpanded
                                ? <ChevronUp size={14} color="#333" />
                                : <ChevronDown size={14} color="#333" />}
                            </div>
                          </div>
                        </motion.div>

                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: 0.2, ease: 'easeOut' }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div style={{ paddingBottom: 14 }}>
                                {entry.thought1 && (
                                  <div style={{
                                    fontSize: 13, color: 'rgba(255,255,255,0.5)',
                                    lineHeight: 1.65, marginBottom: 8,
                                    padding: '12px 14px', borderRadius: 12,
                                    background: 'rgba(255,255,255,0.04)',
                                    border: '0.5px solid rgba(255,255,255,0.05)',
                                  }}>
                                    {entry.thought1}
                                  </div>
                                )}
                                {/* Historial: reflection shown for past entries too */}
                                {entry.thought2 && (
                                  <div style={{
                                    background: 'rgba(139,92,246,0.07)',
                                    border: '0.5px solid rgba(139,92,246,0.2)',
                                    borderRadius: 12, padding: 12,
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                                      <Sparkles size={9} color="#06B6D4" />
                                      <span style={{ fontSize: 9, color: '#06B6D4', letterSpacing: '1px' }}>ATLAS</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.65 }}>
                                      {entry.thought2}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ══ RETROSPECTIVA MENSUAL (candado + contador) ══ */}
            <MonthlyInsight
              seenMonth={seenMonth}
              loading={monthlyInsightLoading}
              onOpen={runMonthlyInsight}
            />

            {/* Resultado de la retrospectiva */}
            <AnimatePresence>
              {!monthlyInsightLoading && monthlyInsight && monthlyInsightVisible && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }} transition={{ duration: 0.3 }}
                  style={{ marginTop: 16 }}
                >
                  <div style={{
                    background: 'rgba(139,92,246,0.05)',
                    border: '0.5px solid rgba(139,92,246,0.15)',
                    borderRadius: 14, padding: 16,
                  }}>
                    <div style={{ fontSize: 9, color: '#06B6D4', letterSpacing: '1.5px', marginBottom: 10 }}>
                      ATLAS · RETROSPECTIVA{monthlyInsightMonth ? ` · ${monthLabelFromKey(monthlyInsightMonth).toUpperCase()}` : ''}
                    </div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
                      {monthlyInsight}
                    </div>
                    <div style={{ marginTop: 14, paddingTop: 10, borderTop: '0.5px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => setMonthlyInsightVisible(false)}
                        style={{
                          background: 'none', border: '0.5px solid rgba(255,255,255,0.1)',
                          borderRadius: 8, padding: '5px 12px', fontSize: 11,
                          color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                          fontFamily: 'Inter, sans-serif',
                        }}
                      >
                        Cerrar
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

          </>
        )}
      </div>
    </div>
  )
}
