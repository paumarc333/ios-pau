import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Check, Clock, Trash2, Calendar } from 'lucide-react'
import { supabase } from '../lib/supabase'

// ── Types ────────────────────────────────────────────────
type TaskType = 'task' | 'event' | 'reminder'
type Priority = 'red' | 'orange' | 'green'
type TaskStatus = 'pending' | 'done' | 'postponed' | 'discarded'

type Task = {
  id: string
  title: string
  type: TaskType
  priority: Priority
  status: TaskStatus
  scheduled_at: string | null
  postponed_count: number
  notes: string | null
  source: string | null
}

type PostponeOption = {
  label: string
  getValue: () => string | null
}

type MonthCell = { key: string | null; dayNum: number; isCurrentMonth: boolean }

// ── Constants ────────────────────────────────────────────
const TZ = 'Europe/Madrid'

const PRIORITY_COLOR: Record<Priority, string> = {
  red: '#EF4444',
  orange: '#F59E0B',
  green: '#10B981',
}

const PRIORITY_RANK: Record<Priority, number> = { red: 3, orange: 2, green: 1 }

const TYPE_LABEL: Record<TaskType, string> = {
  task: 'TAREA',
  event: 'EVENTO',
  reminder: 'RECORDATORIO',
}

const CAL_HEADERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

const MONTH_NAMES_ES = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
]

// ── Madrid timezone helpers ──────────────────────────────

// YYYY-MM-DD of any Date in Europe/Madrid
function toMadridKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
}

// Today's YYYY-MM-DD in Madrid
function madridTodayKey(): string {
  return toMadridKey(new Date())
}

// Add N calendar days to a YYYY-MM-DD key (no timezone artifacts)
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d + n)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Stored UTC ISO string → Madrid calendar date key
function dateKey(isoStr: string): string {
  return toMadridKey(new Date(isoStr))
}

// Display hour:minute in Madrid timezone
function formatHour(isoStr: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(isoStr))
}

// Day label for a YYYY-MM-DD key, relative to today in Madrid
function getDayLabel(key: string): string {
  const today = madridTodayKey()
  const [ty, tm, td] = today.split('-').map(Number)
  const [ky, km, kd] = key.split('-').map(Number)
  const diff = Math.round(
    (new Date(ky, km - 1, kd).getTime() - new Date(ty, tm - 1, td).getTime()) / 86400000,
  )
  if (diff === 0) return 'HOY'
  if (diff === 1) return 'MAÑANA'
  return new Date(ky, km - 1, kd)
    .toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' })
    .toUpperCase()
}

// Convert a Madrid local datetime (year, 0-based month, day, h, min) to a UTC Date
function madridLocalToUTC(year: number, month0: number, day: number, hour: number, min: number): Date {
  // Detect Madrid UTC offset at noon on that date (handles DST automatically)
  const probeUTC = new Date(Date.UTC(year, month0, day, 12, 0, 0))
  const offsetMs =
    new Date(probeUTC.toLocaleString('en-US', { timeZone: TZ })).getTime() -
    new Date(probeUTC.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  return new Date(Date.UTC(year, month0, day, hour, min, 0) - offsetMs)
}

// Highest-priority task in a list
function topPriority(list: Task[]): Priority {
  return list.reduce<Priority>(
    (best, t) => PRIORITY_RANK[t.priority] > PRIORITY_RANK[best] ? t.priority : best,
    'green',
  )
}

// Build calendar grid for a month (Monday-first weeks, pure string keys)
function buildMonthGrid(year: number, month: number): MonthCell[] {
  const firstDay    = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevLastDay = new Date(year, month, 0).getDate()
  const startDow    = firstDay.getDay()
  const offset      = startDow === 0 ? 6 : startDow - 1

  const cells: MonthCell[] = []
  for (let i = offset - 1; i >= 0; i--)
    cells.push({ key: null, dayNum: prevLastDay - i, isCurrentMonth: false })

  for (let d = 1; d <= daysInMonth; d++)
    cells.push({
      key: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      dayNum: d,
      isCurrentMonth: true,
    })

  let next = 1
  while (cells.length % 7 !== 0)
    cells.push({ key: null, dayNum: next++, isCurrentMonth: false })

  return cells
}

// Postpone options calculated in Madrid timezone
function getPostponeOptions(): PostponeOption[] {
  const todayK  = madridTodayKey()
  const [y, m, d] = todayK.split('-').map(Number)
  const month0  = m - 1
  const dow     = new Date(y, month0, d).getDay()
  const toSat   = (6 - dow + 7) % 7 || 7

  return [
    { label: '+1 hora',            getValue: () => new Date(Date.now() + 3_600_000).toISOString() },
    { label: 'Esta noche (21:00)', getValue: () => madridLocalToUTC(y, month0, d,        21,  0).toISOString() },
    { label: 'Mañana 9:00',       getValue: () => madridLocalToUTC(y, month0, d + 1,     9,  0).toISOString() },
    { label: 'Fin de semana',      getValue: () => madridLocalToUTC(y, month0, d + toSat, 10, 0).toISOString() },
    { label: 'Quitar fecha',       getValue: () => null },
  ]
}

// ── Exported function for Atlas ──────────────────────────
export async function addTaskFromAtlas(task: {
  title: string
  type: TaskType
  priority: Priority
  scheduled_at?: string
  notes?: string
}): Promise<string> {
  const payload = {
    title:           task.title,
    type:            task.type,
    priority:        task.priority,
    status:          'pending',
    scheduled_at:    task.scheduled_at ?? null,
    notes:           task.notes ?? null,
    postponed_count: 0,
    source:          'atlas',
  }
  console.log('[Feed] Insertando en Supabase:', payload)
  const { data, error } = await supabase
    .from('tasks')
    .insert([payload])
    .select('id')
    .single()
  if (error) {
    console.error('[Feed] Error insert Supabase:', error)
    throw error
  }
  console.log('[Feed] Resultado insert:', data)
  return data.id
}

// ── Main Component ───────────────────────────────────────
export default function FeedScreen() {
  const [tasks,          setTasks]          = useState<Task[]>([])
  const [loading,        setLoading]        = useState(true)
  const [expanded,       setExpanded]       = useState<string | null>(null)
  const [postponeTarget, setPostponeTarget] = useState<Task | null>(null)
  const [discardWarning, setDiscardWarning] = useState<Task | null>(null)
  const [showAdd,        setShowAdd]        = useState(false)
  const [viewMode,       setViewMode]       = useState<'list' | 'calendar'>('list')
  const [showMore,       setShowMore]       = useState(false)
  const [calSheetDay,    setCalSheetDay]    = useState<string | null>(null)

  const [newTitle,    setNewTitle]    = useState('')
  const [newType,     setNewType]     = useState<TaskType>('task')
  const [newPriority, setNewPriority] = useState<Priority>('orange')
  const [newDate,     setNewDate]     = useState('')
  const [saving,      setSaving]      = useState(false)

  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showAdd) {
      document.body.style.setProperty('--hide-tabbar', '1')
    } else {
      document.body.style.removeProperty('--hide-tabbar')
    }
    return () => { document.body.style.removeProperty('--hide-tabbar') }
  }, [showAdd])

  const loadTasks = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .in('status', ['pending', 'postponed'])
      .order('scheduled_at', { ascending: true, nullsFirst: false })
    setTasks((data as Task[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { loadTasks() }, [loadTasks])

  // Scroll to current month when calendar view activates
  useEffect(() => {
    if (viewMode !== 'calendar') return
    const id = setTimeout(() => {
      const container = contentRef.current
      if (!container) return
      const monthId = todayKey.slice(0, 7)
      const el = container.querySelector(`[data-month-id="${monthId}"]`) as HTMLElement | null
      if (el) container.scrollTop = Math.max(0, el.offsetTop - 12)
    }, 380)
    return () => clearTimeout(id)
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────
  async function markDone(task: Task) {
    await supabase.from('tasks').update({ status: 'done' }).eq('id', task.id)
    setTasks(prev => prev.filter(t => t.id !== task.id))
    setExpanded(null)
  }

  async function markDiscarded(task: Task) {
    await supabase.from('tasks').update({ status: 'discarded' }).eq('id', task.id)
    setTasks(prev => prev.filter(t => t.id !== task.id))
    setExpanded(null)
    setDiscardWarning(null)
  }

  async function postponeTask(task: Task, newScheduledAt: string | null) {
    const newCount = task.postponed_count + 1
    await supabase
      .from('tasks')
      .update({ scheduled_at: newScheduledAt, postponed_count: newCount, status: 'pending' })
      .eq('id', task.id)
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, scheduled_at: newScheduledAt, postponed_count: newCount } : t,
    ))
    setPostponeTarget(null)
    setExpanded(null)
    if (newCount >= 3) setDiscardWarning({ ...task, postponed_count: newCount })
  }

  async function saveNewTask() {
    if (!newTitle.trim()) return
    setSaving(true)
    // Interpret datetime-local input as Madrid local time
    let scheduled_at: string | null = null
    if (newDate) {
      const [datePart, timePart] = newDate.split('T')
      const [y, mo, d] = datePart.split('-').map(Number)
      const [h, mi]    = timePart.split(':').map(Number)
      scheduled_at = madridLocalToUTC(y, mo - 1, d, h, mi).toISOString()
    }
    const { data, error } = await supabase
      .from('tasks')
      .insert([{
        title:           newTitle.trim(),
        type:            newType,
        priority:        newPriority,
        status:          'pending',
        scheduled_at,
        notes:           null,
        postponed_count: 0,
        source:          'manual',
      }])
      .select()
      .single()
    setSaving(false)
    if (!error && data) {
      setTasks(prev => [...prev, data as Task])
      setNewTitle(''); setNewType('task'); setNewPriority('orange'); setNewDate('')
      setShowAdd(false)
    }
  }

  // ── Grouping (Madrid timezone) ───────────────────────
  const todayKey   = madridTodayKey()
  const currentYear = parseInt(todayKey.split('-')[0], 10)

  const mainDayKeys:     string[] = Array.from({ length: 16 }, (_, i) => addDays(todayKey, i))
  const extendedDayKeys: string[] = Array.from({ length: 60 }, (_, i) => addDays(todayKey, 16 + i))

  const grouped: Record<string, Task[]> = {}
  const noDate:  Task[] = []

  for (const task of tasks) {
    if (!task.scheduled_at) {
      noDate.push(task)
    } else {
      const k = dateKey(task.scheduled_at)
      if (!grouped[k]) grouped[k] = []
      grouped[k].push(task)
    }
  }

  const moreCount = extendedDayKeys.reduce((n, k) => n + (grouped[k]?.length ?? 0), 0)

  // Jan currentYear → Dec (currentYear + 1) = 24 months
  const months: Array<{ year: number; month: number }> = []
  for (let y = currentYear; y <= currentYear + 1; y++)
    for (let mo = 0; mo < 12; mo++)
      months.push({ year: y, month: mo })

  // ── Shared helpers ───────────────────────────────────
  const renderCards = (list: Task[]) =>
    list.map((task, i) => (
      <TaskCard
        key={task.id}
        task={task}
        index={i}
        expanded={expanded === task.id}
        onToggle={() => setExpanded(prev => prev === task.id ? null : task.id)}
        onDone={() => markDone(task)}
        onPostpone={() => setPostponeTarget(task)}
        onDiscard={() => markDiscarded(task)}
      />
    ))

  const inp: React.CSSProperties = {
    background: '#080810', border: '0.5px solid #222', borderRadius: 10,
    color: '#ccc', fontSize: 13, padding: '9px 12px',
    fontFamily: 'Inter, sans-serif', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  }

  // ── Render ───────────────────────────────────────────
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
        {/* LED gradient line */}
        <div style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, #8B5CF6, #06B6D4, #EC4899, transparent)',
        }} />
      </div>

      {/* ── Content ── */}
      <div
        ref={contentRef}
        style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 0', position: 'relative', zIndex: 1 }}
      >
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2, 3].map(i => (
              <motion.div key={i}
                animate={{ opacity: [0.3, 0.6, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.6, delay: i * 0.2 }}
                style={{ height: 68, borderRadius: 14, background: 'rgba(255,255,255,0.03)' }}
              />
            ))}
          </div>
        )}

        {!loading && (
          <AnimatePresence mode="wait">

            {/* ═══ LIST VIEW ═══ */}
            {viewMode === 'list' && (
              <motion.div
                key="list"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                {mainDayKeys.map(key => {
                  const dt = grouped[key]
                  if (!dt || dt.length === 0) return null
                  return (
                    <div key={key}>
                      <DayLabel label={getDayLabel(key)} />
                      {renderCards(dt)}
                    </div>
                  )
                })}

                {moreCount > 0 && !showMore && (
                  <motion.button
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setShowMore(true)}
                    style={{
                      width: '100%', marginTop: 4, marginBottom: 8,
                      padding: '11px 0', borderRadius: 12,
                      background: 'rgba(255,255,255,0.03)', border: '0.5px solid #1e1e1e',
                      color: '#555', fontSize: 12, fontFamily: 'Inter, sans-serif',
                      letterSpacing: '0.5px', cursor: 'pointer',
                    }}
                  >
                    Ver más ({moreCount} {moreCount === 1 ? 'tarea' : 'tareas'})
                  </motion.button>
                )}

                {showMore && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                    {extendedDayKeys.map(key => {
                      const dt = grouped[key]
                      if (!dt || dt.length === 0) return null
                      return (
                        <div key={key}>
                          <DayLabel label={getDayLabel(key)} />
                          {renderCards(dt)}
                        </div>
                      )
                    })}
                  </motion.div>
                )}

                {noDate.length > 0 && (
                  <div>
                    <DayLabel label="SIN FECHA" />
                    {renderCards(noDate)}
                  </div>
                )}

                {tasks.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '60px 0', color: '#252525', fontSize: 12, letterSpacing: '1px' }}>
                    SIN TAREAS PENDIENTES
                  </div>
                )}
              </motion.div>
            )}

            {/* ═══ CALENDAR VIEW ═══ */}
            {viewMode === 'calendar' && (
              <motion.div
                key="calendar"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                {months.map(({ year, month }) => {
                  const monthId = `${year}-${String(month + 1).padStart(2, '0')}`
                  const cells   = buildMonthGrid(year, month)

                  return (
                    <div key={monthId} data-month-id={monthId}>
                      <div style={{
                        fontSize: 11, color: 'rgba(255,255,255,0.35)',
                        letterSpacing: '2px', marginTop: 24, marginBottom: 10,
                      }}>
                        {MONTH_NAMES_ES[month]} {year}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 2 }}>
                        {CAL_HEADERS.map(h => (
                          <div key={h} style={{
                            textAlign: 'center', fontSize: 10,
                            color: 'rgba(255,255,255,0.25)', padding: '3px 0',
                          }}>
                            {h}
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                        {cells.map((cell, ci) => {
                          const dayTasks = cell.key ? (grouped[cell.key] ?? []) : []
                          const hasTasks = dayTasks.length > 0
                          const isToday  = cell.key === todayKey
                          const isPast   = cell.key ? cell.key < todayKey : false

                          return (
                            <motion.div
                              key={`${monthId}-${ci}`}
                              whileTap={hasTasks ? { scale: 0.88 } : {}}
                              onClick={() => hasTasks && cell.key && setCalSheetDay(cell.key)}
                              style={{
                                height: 36, borderRadius: 8,
                                border: isToday ? '1px solid #8B5CF6' : 'none',
                                background: isToday
                                  ? 'rgba(139,92,246,0.3)'
                                  : hasTasks ? 'rgba(255,255,255,0.05)' : 'transparent',
                                display: 'flex', flexDirection: 'column',
                                alignItems: 'center', justifyContent: 'center',
                                cursor: hasTasks ? 'pointer' : 'default',
                                opacity: !cell.isCurrentMonth ? 0.25 : isPast && !isToday ? 0.4 : 1,
                              }}
                            >
                              <span style={{
                                fontSize: 12, lineHeight: 1,
                                color: isToday ? '#fff' : cell.isCurrentMonth ? '#ccc' : 'rgba(255,255,255,0.4)',
                                fontWeight: isToday ? 500 : 300,
                              }}>
                                {cell.dayNum}
                              </span>
                              {hasTasks && (
                                <div style={{
                                  width: 4, height: 4, borderRadius: '50%', marginTop: 2,
                                  background: PRIORITY_COLOR[topPriority(dayTasks)],
                                }} />
                              )}
                            </motion.div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                <div style={{ height: 24 }} />
              </motion.div>
            )}

          </AnimatePresence>
        )}
      </div>

      {/* ── FABs ── */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => { setViewMode(v => v === 'list' ? 'calendar' : 'list'); setExpanded(null) }}
        style={{
          position: 'fixed', bottom: 100, left: 'calc(50% - 195px + 20px)',
          width: 48, height: 48, borderRadius: '50%',
          background: 'rgba(139,92,246,0.3)',
          border: '0.5px solid rgba(139,92,246,0.5)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          filter: 'drop-shadow(0 0 8px rgba(139,92,246,0.6))',
          zIndex: 100,
        }}
      >
        <Calendar size={20} color="#8B5CF6" />
      </motion.button>

      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => setShowAdd(true)}
        style={{
          position: 'fixed', bottom: 100, right: 'calc(50% - 195px + 20px)',
          width: 48, height: 48, borderRadius: 24,
          background: 'linear-gradient(135deg, #8B5CF6, #06B6D4)',
          border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(139,92,246,0.4)',
          zIndex: 100,
        }}
      >
        <Plus size={20} color="#fff" />
      </motion.button>

      {/* ── Calendar day detail bottom sheet ── */}
      <AnimatePresence>
        {calSheetDay && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { setCalSheetDay(null); setExpanded(null) }}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 38 }}
            />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 45,
                background: '#080810', borderRadius: '20px 20px 0 0',
                border: '0.5px solid #1e1e1e', padding: '20px 16px 44px',
                maxHeight: '72%', overflowY: 'auto',
              }}
            >
              <div style={{ width: 36, height: 3, borderRadius: 2, background: '#222', margin: '0 auto 20px' }} />
              <div style={{ fontSize: 9, color: '#2a2a2a', letterSpacing: '2px', marginBottom: 16, textAlign: 'center' }}>
                {getDayLabel(calSheetDay)}
              </div>
              {renderCards(grouped[calSheetDay] ?? [])}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Postpone bottom sheet ── */}
      <AnimatePresence>
        {postponeTarget && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setPostponeTarget(null)}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50 }}
            />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 55,
                background: '#080810', borderRadius: '20px 20px 0 0',
                border: '0.5px solid #1e1e1e', padding: '20px 20px 36px',
              }}
            >
              <div style={{ width: 36, height: 3, borderRadius: 2, background: '#222', margin: '0 auto 20px' }} />
              <div style={{ fontSize: 12, color: '#444', letterSpacing: '1.5px', marginBottom: 16 }}>POSPONER</div>
              {getPostponeOptions().map(opt => (
                <motion.button
                  key={opt.label}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => postponeTask(postponeTarget, opt.getValue())}
                  style={{
                    width: '100%', padding: '13px 16px', marginBottom: 6,
                    background: 'rgba(255,255,255,0.03)', border: '0.5px solid #1e1e1e',
                    borderRadius: 12, color: '#ccc', fontSize: 14, fontFamily: 'Inter, sans-serif',
                    textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </motion.button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Discard warning ── */}
      <AnimatePresence>
        {discardWarning && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 60 }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 65, width: 300,
                background: '#080810', borderRadius: 20,
                border: '0.5px solid #2a1a1a', padding: 24,
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 10, textAlign: 'center' }}>⚠️</div>
              <div style={{ fontSize: 14, color: '#ccc', textAlign: 'center', marginBottom: 6, fontWeight: 500 }}>
                Has pospuesto esto 3 veces.
              </div>
              <div style={{ fontSize: 12, color: '#555', textAlign: 'center', marginBottom: 24 }}>¿Lo eliminamos?</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <motion.button whileTap={{ scale: 0.95 }} onClick={() => setDiscardWarning(null)}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 12,
                    background: 'rgba(255,255,255,0.04)', border: '0.5px solid #222',
                    color: '#888', fontSize: 13, fontFamily: 'Inter, sans-serif', cursor: 'pointer',
                  }}
                >Mantener</motion.button>
                <motion.button whileTap={{ scale: 0.95 }} onClick={() => markDiscarded(discardWarning)}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 12,
                    background: 'rgba(239,68,68,0.12)', border: '0.5px solid rgba(239,68,68,0.3)',
                    color: '#EF4444', fontSize: 13, fontFamily: 'Inter, sans-serif', cursor: 'pointer',
                  }}
                >Descartar</motion.button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Add task modal ── */}
      <AnimatePresence>
        {showAdd && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowAdd(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 199 }}
            />
            <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '390px', zIndex: 200 }}>
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 280 }}
              style={{
                background: '#111118', borderRadius: '20px 20px 0 0',
                borderTop: '0.5px solid rgba(255,255,255,0.1)', padding: '20px 20px 48px',
              }}
            >
              <div style={{ width: 32, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.15)', margin: '0 auto 18px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: '#444', letterSpacing: '1.5px' }}>NUEVA TAREA</div>
                <motion.button whileTap={{ scale: 0.9 }} onClick={() => setShowAdd(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
                >
                  <X size={18} color="#444" />
                </motion.button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <input placeholder="Título" value={newTitle} onChange={e => setNewTitle(e.target.value)} style={inp} />

                <div>
                  <div style={{ fontSize: 9, color: '#333', letterSpacing: '1.5px', marginBottom: 6 }}>TIPO</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['task', 'event', 'reminder'] as TaskType[]).map(t => (
                      <motion.button key={t} whileTap={{ scale: 0.95 }} onClick={() => setNewType(t)}
                        style={{
                          flex: 1, padding: '8px 0', borderRadius: 10, fontFamily: 'Inter, sans-serif',
                          fontSize: 10, letterSpacing: '0.8px', cursor: 'pointer',
                          background: newType === t ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                          border: `0.5px solid ${newType === t ? 'rgba(139,92,246,0.4)' : '#1e1e1e'}`,
                          color: newType === t ? '#8B5CF6' : '#555',
                        }}
                      >
                        {TYPE_LABEL[t]}
                      </motion.button>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 9, color: '#333', letterSpacing: '1.5px', marginBottom: 6 }}>PRIORIDAD</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['red', 'orange', 'green'] as Priority[]).map(p => (
                      <motion.button key={p} whileTap={{ scale: 0.9 }} onClick={() => setNewPriority(p)}
                        style={{
                          width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
                          background: PRIORITY_COLOR[p],
                          border: newPriority === p ? '2.5px solid #fff' : '2.5px solid transparent',
                          opacity: newPriority === p ? 1 : 0.4, flexShrink: 0,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 9, color: '#333', letterSpacing: '1.5px', marginBottom: 6 }}>FECHA Y HORA (OPCIONAL)</div>
                  <input
                    type="datetime-local"
                    value={newDate}
                    onChange={e => setNewDate(e.target.value)}
                    style={{ ...inp, colorScheme: 'dark' }}
                  />
                </div>

                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={saveNewTask}
                  disabled={saving || !newTitle.trim()}
                  style={{
                    padding: '13px 0', borderRadius: 14, marginTop: 4,
                    background: newTitle.trim() ? 'linear-gradient(135deg, #8B5CF6, #06B6D4)' : '#111',
                    border: 'none', color: '#fff', fontSize: 14, fontFamily: 'Inter, sans-serif',
                    fontWeight: 500, cursor: newTitle.trim() ? 'pointer' : 'default',
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  {saving ? 'Guardando…' : 'Guardar'}
                </motion.button>
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>

      <style>{`
        @keyframes blink-badge {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}

// ── DayLabel ─────────────────────────────────────────────
function DayLabel({ label }: { label: string }) {
  return (
    <div style={{
      textAlign: 'center', fontSize: 9, color: '#2a2a2a',
      letterSpacing: '2px', padding: '14px 0 10px',
    }}>
      {label}
    </div>
  )
}

// ── TaskCard ─────────────────────────────────────────────
function TaskCard({
  task, index, expanded, onToggle, onDone, onPostpone, onDiscard,
}: {
  task: Task; index: number; expanded: boolean
  onToggle: () => void; onDone: () => void; onPostpone: () => void; onDiscard: () => void
}) {
  const color     = PRIORITY_COLOR[task.priority]
  const showBadge = task.postponed_count >= 3

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ delay: index * 0.06, duration: 0.22 }}
      style={{ marginBottom: 8, position: 'relative' }}
    >
      <div style={{
        position: 'absolute', top: 0, left: 16, right: 16, height: 1,
        background: `linear-gradient(to right, transparent, ${color}22, transparent)`, borderRadius: 1,
      }} />
      <motion.div
        whileTap={{ scale: 0.985 }}
        onClick={onToggle}
        style={{
          background: 'rgba(255,255,255,0.04)', border: '0.5px solid #161616',
          borderLeft: `3px solid ${color}`, borderRadius: 14,
          padding: '12px 14px', cursor: 'pointer', position: 'relative', overflow: 'hidden',
        }}
      >
        {showBadge && (
          <div style={{
            position: 'absolute', top: 8, right: 10,
            background: 'rgba(239,68,68,0.15)', border: '0.5px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '2px 7px', fontSize: 9, color: '#EF4444', letterSpacing: '0.5px',
            animation: 'blink-badge 1.8s ease-in-out infinite',
          }}>⚠ Pospuesto 3x</div>
        )}
        <div style={{
          fontSize: 14, color: '#f0f0f0', fontWeight: 600,
          lineHeight: 1.3, paddingRight: showBadge ? 90 : 0, marginBottom: 6,
        }}>
          {task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color, letterSpacing: '1.2px' }}>{TYPE_LABEL[task.type]}</span>
          {task.scheduled_at && (
            <span style={{ fontSize: 10, color: '#333', letterSpacing: '0.5px' }}>
              {formatHour(task.scheduled_at)}
            </span>
          )}
        </div>
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ display: 'flex', gap: 7, marginTop: 12, paddingTop: 12, borderTop: '0.5px solid #1e1e1e' }}>
                <ActionBtn icon={<Check size={13} />}  label="Hecho"     color="#10B981" onClick={e => { e.stopPropagation(); onDone() }} />
                <ActionBtn icon={<Clock size={13} />}  label="Posponer"  color="#F59E0B" onClick={e => { e.stopPropagation(); onPostpone() }} />
                <ActionBtn icon={<Trash2 size={13} />} label="Descartar" color="#EF4444" onClick={e => { e.stopPropagation(); onDiscard() }} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

// ── ActionBtn ────────────────────────────────────────────
function ActionBtn({ icon, label, color, onClick }: {
  icon: React.ReactNode; label: string; color: string; onClick: (e: React.MouseEvent) => void
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      style={{
        flex: 1, padding: '8px 0', borderRadius: 10, cursor: 'pointer',
        background: `${color}12`, border: `0.5px solid ${color}30`,
        color, fontSize: 11, fontFamily: 'Inter, sans-serif',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        letterSpacing: '0.3px',
      }}
    >
      {icon}{label}
    </motion.button>
  )
}
