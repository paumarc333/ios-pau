import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '../lib/supabase'

// ── Constants ────────────────────────────────────────────
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY
const TZ             = 'Europe/Madrid'
const INSIGHT_KEY    = 'journal_monthly_insight'
const INSIGHT_TTL    = 30 * 24 * 3600 * 1000

// ── Types ────────────────────────────────────────────────
type JournalEntry = {
  id: string
  date: string
  mood_score: number
  notes: string | null
  atlas_reflection: string | null
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────
function madridTodayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

function madridDisplayDate(): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, day: 'numeric', month: 'short',
  }).format(new Date()).toUpperCase()
}

function madridCurrentTime(): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date())
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


function formatEntryDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

// ── iOSSlider ─────────────────────────────────────────────
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
  const [isDragging, setIsDragging] = useState(false)

  const displayValue = liveValue ?? score
  const pct          = displayValue === 0 ? 0 : (displayValue - 1) / 9
  const color        = displayValue === 0 ? 'rgba(255,255,255,0.25)' : getSliderColor(displayValue)
  const fillOpacity  = displayValue === 0 ? 0 : 0.15

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

  const thumbPos  = `calc(${MARGIN}px + ${pct} * (100% - ${THUMB + MARGIN * 2}px))`
  const fillWidth = `calc(${MARGIN}px + ${pct} * (100% - ${THUMB + MARGIN * 2}px) + ${THUMB / 2 + MARGIN}px)`
  const snapTrans = 'left 0.4s cubic-bezier(0.34,1.56,0.64,1), background 0.3s ease, box-shadow 0.3s ease'

  return (
    <div style={{ marginTop: 28 }}>
      <div
        ref={capsuleRef}
        style={{
          position: 'relative', height: 64, borderRadius: 32,
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
        {/* Fill */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: fillWidth,
          background: color, opacity: fillOpacity, borderRadius: 32,
          transition: isDragging
            ? 'background 0.3s ease'
            : 'width 0.4s cubic-bezier(0.34,1.56,0.64,1), background 0.3s ease',
        }} />

        {/* Thumb */}
        <div style={{
          position: 'absolute',
          left: thumbPos,
          top: '50%', transform: 'translateY(-50%)',
          width: THUMB, height: THUMB, borderRadius: '50%',
          background: color,
          boxShadow: `0 0 20px ${color}99`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', zIndex: 2,
          transition: isDragging ? 'background 0.3s ease, box-shadow 0.3s ease' : snapTrans,
        }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
            {Math.round(displayValue)}
          </span>
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

// ── Atlas Reflection Card ────────────────────────────────
function ReflectionCard({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        background: 'rgba(139,92,246,0.07)',
        border: '0.5px solid rgba(139,92,246,0.2)',
        borderRadius: 14, padding: 16, marginTop: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Sparkles size={10} color="#06B6D4" />
        <span style={{ fontSize: 10, color: '#06B6D4', letterSpacing: '1.5px' }}>ATLAS</span>
      </div>
      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
        {text}
      </div>
    </motion.div>
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
  const [monthlyInsight,         setMonthlyInsight]         = useState<string | null>(null)
  const [monthlyInsightLoading,  setMonthlyInsightLoading]  = useState(false)
  const [monthlyInsightVisible,  setMonthlyInsightVisible]  = useState(false)
  const [currentTime,            setCurrentTime]            = useState(madridCurrentTime())

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

  // Load cached monthly insight
  useEffect(() => {
    try {
      const raw = localStorage.getItem(INSIGHT_KEY)
      if (!raw) return
      const { ts, text } = JSON.parse(raw) as { ts: number; text: string }
      if (Date.now() - ts < INSIGHT_TTL) {
        setMonthlyInsight(text)
      }
    } catch { /* ignore */ }
  }, [])

  // ── Edit mode init ─────────────────────────────────────
  const startEdit = () => {
    if (!todayEntry) return
    setScore(todayEntry.mood_score)
    setNotes(todayEntry.notes ?? '')
    setEditMode(true)
  }

  // ── Save check-in ──────────────────────────────────────
  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setSaveError('')

    try {
      const today = madridTodayKey()

      // 1. Insert or update journal entry
      let entryId: string
      if (editMode && todayEntry) {
        const { data, error } = await supabase
          .from('journal_entries')
          .update({ mood_score: score, notes })
          .eq('id', todayEntry.id)
          .select('id')
          .single()
        if (error) throw error
        entryId = data.id
      } else {
        const { data, error } = await supabase
          .from('journal_entries')
          .insert([{ date: today, mood_score: score, notes }])
          .select('id')
          .single()
        if (error) throw error
        entryId = data.id
      }

      // 2. Get Atlas reflection
      let reflection = ''
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
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

      // 3. Save reflection to journal entry
      if (reflection) {
        await supabase
          .from('journal_entries')
          .update({ atlas_reflection: reflection })
          .eq('id', entryId)
      }

      // 4. Append to atlas_memory (category: emociones)
      const summary = `${today}: score ${score}/10. ${(notes || '').split(' ').slice(0, 20).join(' ')}`
      await supabase.from('atlas_memory').insert([{
        category: 'emociones',
        summary,
        raw_text: notes || `Check-in ${score}/10`,
      }])

      setEditMode(false)
      await loadData()
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── Monthly insight ────────────────────────────────────
  const runMonthlyInsight = async () => {
    if (monthlyInsightLoading || !ANTHROPIC_KEY) return
    setMonthlyInsightLoading(true)
    try {
      const allEntries = [...(todayEntry ? [todayEntry] : []), ...history].slice(0, 30)
      const dataStr = allEntries
        .map(e => `${e.date}: ${e.mood_score}/10${e.notes ? ` — ${e.notes}` : ''}`)
        .join('\n')

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 400,
          system: 'Eres Atlas. Directo, sin rodeos, sin introducciones. Responde solo el análisis.',
          messages: [{
            role: 'user',
            content: `Analiza estos datos emocionales del último mes. Dame 3 patrones que observas, qué días/situaciones me afectan más, y una recomendación concreta. Directo, sin rodeos. Máximo 150 palabras.\n\n${dataStr}`,
          }],
        }),
      })
      const d    = await res.json()
      const text = d.content?.[0]?.text ?? ''
      if (text) {
        setMonthlyInsight(text)
        setMonthlyInsightVisible(true)
        try { localStorage.setItem(INSIGHT_KEY, JSON.stringify({ ts: Date.now(), text })) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    finally { setMonthlyInsightLoading(false) }
  }

  // ── Derived ────────────────────────────────────────────
  const showForm = !todayEntry || editMode

  // ── Render ─────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', overflow: 'hidden', minHeight: '100vh', height: '100%' }}>

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

      {/* ── Header ── */}
      <div style={{ padding: '20px 20px 0', flexShrink: 0, position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 10, color: '#333', letterSpacing: '1.5px' }}>
            {madridDisplayDate()}
          </span>
        </div>
        <div style={{
          height: 1, marginTop: 12,
          background: 'linear-gradient(90deg, transparent, #8B5CF6, #06B6D4, #EC4899, transparent)',
        }} />
      </div>

      {/* ── Scroll area ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 0', position: 'relative', zIndex: 1 }}>

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
              <div style={{ marginTop: 40 }}>
                {/* Question */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 300, color: 'rgba(255,255,255,0.8)', letterSpacing: '-0.3px', lineHeight: 1.3 }}>
                    ¿Cómo ha ido el día?
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginTop: 6 }}>
                    {currentTime}
                  </div>
                </div>

                {/* Slider */}
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
                  <div style={{ fontSize: 11, color: '#EF4444', textAlign: 'center', marginTop: 8 }}>
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
                style={{ marginTop: 32 }}
              >
                {/* Read-only slider */}
                <NeonSlider score={todayEntry.mood_score} readOnly />

                {/* Notes */}
                {todayEntry.notes && (
                  <div style={{
                    marginTop: 20, fontSize: 14, color: 'rgba(255,255,255,0.55)',
                    lineHeight: 1.7, padding: '14px', borderRadius: 14,
                    background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.06)',
                  }}>
                    {todayEntry.notes}
                  </div>
                )}

                {/* Atlas reflection */}
                {todayEntry.atlas_reflection && (
                  <ReflectionCard text={todayEntry.atlas_reflection} />
                )}

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

            {/* ══ HISTORIAL ══ */}
            {history.length > 0 && (
              <div style={{ marginTop: 36 }}>
                <div style={{ fontSize: 9, color: '#252525', letterSpacing: '2.5px', marginBottom: 12 }}>
                  HISTORIAL
                </div>

                <div>
                  {history.map((entry, i) => {
                    const isExpanded = expandedId === entry.id
                    const eColor     = getScoreColor(entry.mood_score)
                    const eGradient  = getScoreGradient(entry.mood_score)

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
                            {/* Date */}
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', minWidth: 90, flexShrink: 0 }}>
                              {formatEntryDate(entry.date)}
                            </div>

                            {/* Score bar */}
                            <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                              <div style={{
                                width: `${entry.mood_score * 10}%`, height: '100%',
                                background: eGradient, borderRadius: 2,
                              }} />
                            </div>

                            {/* Score label */}
                            <div style={{ fontSize: 12, color: eColor, fontWeight: 500, minWidth: 32, textAlign: 'right' }}>
                              {entry.mood_score}/10
                            </div>

                            {/* Expand icon */}
                            <div style={{ flexShrink: 0 }}>
                              {isExpanded
                                ? <ChevronUp size={14} color="#333" />
                                : <ChevronDown size={14} color="#333" />}
                            </div>
                          </div>
                        </motion.div>

                        {/* Expanded detail */}
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
                                {entry.notes && (
                                  <div style={{
                                    fontSize: 13, color: 'rgba(255,255,255,0.5)',
                                    lineHeight: 1.65, marginBottom: 8,
                                    padding: '12px 14px', borderRadius: 12,
                                    background: 'rgba(255,255,255,0.04)',
                                    border: '0.5px solid rgba(255,255,255,0.05)',
                                  }}>
                                    {entry.notes}
                                  </div>
                                )}
                                {entry.atlas_reflection && (
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
                                      {entry.atlas_reflection}
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

            {/* ══ INSIGHT MENSUAL ══ */}
            <div style={{ marginTop: 36 }}>
              <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.04)', marginBottom: 8 }} />

              {/* Loading spinner */}
              {monthlyInsightLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                  <div style={{ position: 'relative', width: 56, height: 56 }}>
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
                      <Sparkles size={18} color="#fff" />
                    </div>
                  </div>
                </div>
              )}

              {/* Trigger button */}
              {!monthlyInsightLoading && (!monthlyInsight || !monthlyInsightVisible) && (
                <motion.button
                  whileTap={{ scale: 0.96 }}
                  onClick={() => monthlyInsight ? setMonthlyInsightVisible(true) : runMonthlyInsight()}
                  style={{
                    background: 'none', border: 'none',
                    cursor: 'pointer', display: 'block',
                    padding: '16px 0', margin: '0 auto',
                  }}
                >
                  <div style={{ position: 'relative', width: 56, height: 56 }}>
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
                      style={{
                        position: 'absolute', inset: 0, borderRadius: '50%',
                        background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)',
                      }}
                    />
                    <div style={{
                      position: 'absolute', inset: 2, borderRadius: '50%', background: '#080810',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Sparkles size={20} color="#fff" />
                    </div>
                  </div>
                </motion.button>
              )}

              {/* Insight result */}
              {!monthlyInsightLoading && monthlyInsight && monthlyInsightVisible && (
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
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
                        <Sparkles size={12} color="#fff" />
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>Insight mensual</div>
                  </div>

                  <div style={{
                    background: 'rgba(139,92,246,0.05)',
                    border: '0.5px solid rgba(139,92,246,0.15)',
                    borderRadius: 12, padding: 16,
                  }}>
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
            </div>

          </>
        )}
      </div>
    </div>
  )
}
