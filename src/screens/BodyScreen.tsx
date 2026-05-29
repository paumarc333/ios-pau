import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Pencil, Check, Plus, Trash2, X, Dumbbell } from 'lucide-react'
import { supabase, type Meal } from '../lib/supabase'

const RING_R = 28
const RING_C = 2 * Math.PI * RING_R
const BAR_MAX_H = 120
const CAL_CIRCLE_R = 48
const CAL_CIRCLE_C = 2 * Math.PI * CAL_CIRCLE_R
const DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

type WeekDay = { date: string; calories: number; isToday: boolean }
type MealRow = Meal & { image_url?: string }
type MacroGoals = { protein: number; carbs: number; fat: number }
type ProgressEntry = {
  id: string
  created_at: string
  date: string
  photos: string[]
  measurements: Record<string, number>
  prs: Array<{ name: string; weight?: number; reps?: number }>
}

function localDateStr(d: Date) {
  return d.toLocaleDateString('en-CA')
}

function getMondayOfWeek(ref: Date) {
  const d = new Date(ref)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

// ── Modal nueva / editar entrada ──────────────────────────
const MEASURES = [
  { key: 'bicep',  label: 'Bícep'       },
  { key: 'chest',  label: 'Pecho'       },
  { key: 'waist',  label: 'Cintura'     },
  { key: 'hip',    label: 'Cadera'      },
  { key: 'thigh',  label: 'Muslo'       },
  { key: 'calf',   label: 'Pantorrilla' },
] as const

function ProgressModal({
  onClose,
  onSaved,
  editEntry,
}: {
  onClose: () => void
  onSaved: () => void
  editEntry?: ProgressEntry
}) {
  const isEdit = !!editEntry

  const [date, setDate] = useState(editEntry?.date ?? localDateStr(new Date()))

  // Existing photos stay as a plain const — never mutated during modal lifetime
  const existingPhotos = editEntry?.photos ?? []

  // New files selected in this session
  const [localFiles, setLocalFiles]     = useState<File[]>([])
  const [localPreviews, setLocalPreviews] = useState<string[]>([])

  // Combined for rendering: existing Supabase URLs + local blob URLs
  const allPreviews = [...existingPhotos, ...localPreviews]
  const totalPhotos = allPreviews.length

  const [measurements, setMeasurements] = useState<Record<string, string>>(() => ({
    body_weight: editEntry?.measurements['body_weight']?.toString() ?? '',
    ...Object.fromEntries(
      MEASURES.map(({ key }) => [key, editEntry?.measurements[key]?.toString() ?? ''])
    ),
  }))

  const [prs, setPrs] = useState<Array<{ name: string; weight: string; reps: string }>>(() => {
    const defaults = [
      { name: 'Press Banca', weight: '', reps: '' },
      { name: 'Sentadilla',  weight: '', reps: '' },
      { name: 'Peso Muerto', weight: '', reps: '' },
    ]
    if (!editEntry?.prs) return defaults
    const mapped = editEntry.prs.map(pr => ({
      name:   pr.name,
      weight: pr.weight?.toString() ?? '',
      reps:   pr.reps?.toString()   ?? '',
    }))
    while (mapped.length < 3) mapped.push(defaults[mapped.length])
    return mapped.slice(0, 3)
  })

  const [saving, setSaving]       = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // Called when a file is chosen — immediately shows blob preview, defers upload to save
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || totalPhotos >= 3) return
    setLocalFiles(prev => [...prev, file])
    setLocalPreviews(prev => [...prev, URL.createObjectURL(file)])
    // Reset input so same file can be re-selected after removal
    e.target.value = ''
  }

  const doSave = async (opts: { overwriteId?: string; forceNew?: boolean } = {}) => {
    setSaving(true)

    // Duplicate check — create mode only, first attempt only
    if (!isEdit && !opts.overwriteId && !opts.forceNew) {
      const { data: existing } = await supabase
        .from('progress_entries')
        .select('id')
        .eq('date', date)
        .limit(1)
      if (existing && existing.length > 0) {
        setConfirmId(existing[0].id)
        setSaving(false)
        return
      }
    }

    // Upload new local files
    const uploadedUrls: string[] = []
    for (const file of localFiles) {
      const ext  = file.name.split('.').pop() ?? 'jpg'
      const path = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('progress-photos').upload(path, file)
      if (!error) {
        const { data } = supabase.storage.from('progress-photos').getPublicUrl(path)
        uploadedUrls.push(data.publicUrl)
      }
    }

    const cleanM: Record<string, number> = {}
    Object.entries(measurements).forEach(([k, v]) => {
      const n = parseFloat(v); if (!isNaN(n) && n > 0) cleanM[k] = n
    })

    const payload = {
      date,
      photos: [...existingPhotos, ...uploadedUrls],
      measurements: cleanM,
      prs: prs.map(pr => ({
        name: pr.name,
        ...(pr.weight !== '' && { weight: parseFloat(pr.weight) }),
        ...(pr.reps   !== '' && { reps:   parseInt(pr.reps)    }),
      })),
    }

    if (isEdit) {
      await supabase.from('progress_entries').update(payload).eq('id', editEntry!.id)
    } else if (opts.overwriteId) {
      await supabase.from('progress_entries').update(payload).eq('id', opts.overwriteId)
    } else {
      await supabase.from('progress_entries').insert(payload)
    }

    setSaving(false)
    onSaved()
  }

  const inp: React.CSSProperties = {
    background: '#111', border: '0.5px solid #1e1e1e', borderRadius: 10,
    color: '#ccc', fontSize: 13, outline: 'none', fontFamily: 'Inter, sans-serif',
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100 }}
      />
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: '#0d0d0d', borderRadius: '24px 24px 0 0',
          maxHeight: '92vh', overflowY: 'auto', zIndex: 101,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#222' }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 20px 20px' }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <X size={18} color="#555" />
          </button>
          <span style={{ fontSize: 11, color: '#555', letterSpacing: '2px' }}>
            {isEdit ? 'EDITAR ENTRADA' : 'NUEVA ENTRADA'}
          </span>
          <button onClick={() => doSave()} disabled={saving}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: saving ? '#333' : '#ccc', fontFamily: 'Inter, sans-serif', padding: 4 }}>
            {saving ? '···' : 'Guardar'}
          </button>
        </div>

        <div style={{ padding: '0 20px 48px' }}>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 9, color: '#333', letterSpacing: '2px', marginBottom: 10 }}>FECHA</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ ...inp, width: '100%', boxSizing: 'border-box', padding: '10px 12px' }} />
          </div>

          {/* ── Fotos ── label approach avoids programmatic .click() issues on iOS */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 9, color: '#333', letterSpacing: '2px', marginBottom: 10 }}>FOTOS</div>
            {/* Input hidden via opacity/size, not display:none, for maximum browser compat */}
            <input
              id="progress-photo-input"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{
                position: 'absolute',
                width: 1, height: 1,
                opacity: 0,
                overflow: 'hidden',
                pointerEvents: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              {[0, 1, 2].map(i => {
                const preview = allPreviews[i]
                const isNextSlot = i === totalPhotos && totalPhotos < 3

                if (preview) {
                  return (
                    <div key={i} style={{ width: 88, height: 88, borderRadius: 14, overflow: 'hidden', flexShrink: 0, border: '0.5px solid #1a1a1a' }}>
                      <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                  )
                }

                if (isNextSlot) {
                  // label natively triggers the file input — works on iOS Safari without .click()
                  return (
                    <label
                      key={i}
                      htmlFor="progress-photo-input"
                      style={{
                        width: 88, height: 88, borderRadius: 14, background: '#111',
                        border: '0.5px solid #1a1a1a', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Plus size={16} color="#2a2a2a" />
                    </label>
                  )
                }

                return (
                  <div key={i} style={{ width: 88, height: 88, borderRadius: 14, background: '#0a0a0a', border: '0.5px solid #141414', flexShrink: 0 }} />
                )
              })}
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 9, color: '#333', letterSpacing: '2px', marginBottom: 10 }}>MEDIDAS</div>

            {/* Peso corporal — campo destacado */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <span style={{ fontSize: 15, color: '#ccc', fontWeight: 300, flex: 1 }}>Peso corporal</span>
              <input
                type="number"
                placeholder="—"
                value={measurements['body_weight']}
                onChange={e => setMeasurements(prev => ({ ...prev, body_weight: e.target.value }))}
                style={{ ...inp, width: 62, textAlign: 'center', padding: '7px 8px', border: '0.5px solid #333' }}
              />
              <span style={{ fontSize: 11, color: '#333', width: 18 }}>kg</span>
            </div>
            <div style={{ height: '0.5px', background: '#1e1e1e', marginBottom: 14 }} />

            {MEASURES.map(({ key, label }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 11 }}>
                <span style={{ fontSize: 13, color: '#555', flex: 1 }}>{label}</span>
                <input type="number" placeholder="—" value={measurements[key]}
                  onChange={e => setMeasurements(prev => ({ ...prev, [key]: e.target.value }))}
                  style={{ ...inp, width: 62, textAlign: 'center', padding: '7px 8px' }} />
                <span style={{ fontSize: 11, color: '#333', width: 18 }}>cm</span>
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontSize: 9, color: '#333', letterSpacing: '2px', marginBottom: 10 }}>PRs</div>
            {prs.map((pr, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Dumbbell size={16} className="pr-icon-grad" style={{ flexShrink: 0 }} />
                <input type="text" value={pr.name}
                  onChange={e => setPrs(prev => prev.map((p, j) => j === i ? { ...p, name: e.target.value } : p))}
                  style={{ ...inp, flex: 1, padding: '7px 10px' }} />
                <input type="number" placeholder="kg" value={pr.weight}
                  onChange={e => setPrs(prev => prev.map((p, j) => j === i ? { ...p, weight: e.target.value } : p))}
                  style={{ ...inp, width: 50, textAlign: 'center', padding: '7px 6px' }} />
                <span style={{ fontSize: 11, color: '#333' }}>×</span>
                <input type="number" placeholder="reps" value={pr.reps}
                  onChange={e => setPrs(prev => prev.map((p, j) => j === i ? { ...p, reps: e.target.value } : p))}
                  style={{ ...inp, width: 46, textAlign: 'center', padding: '7px 6px' }} />
              </div>
            ))}
          </div>

        </div>
      </motion.div>

      {/* Duplicate confirmation — fixed above everything */}
      <AnimatePresence>
        {confirmId && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 200,
              background: 'rgba(0,0,0,0.93)',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: 32,
            }}
          >
            <div style={{ fontSize: 15, color: '#ccc', fontWeight: 300, marginBottom: 8, textAlign: 'center' }}>
              Ya existe una entrada para esta fecha.
            </div>
            <div style={{ fontSize: 11, color: '#444', letterSpacing: '0.3px', marginBottom: 40, textAlign: 'center' }}>
              ¿Qué quieres hacer?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 260 }}>
              <button
                onClick={() => { const id = confirmId; setConfirmId(null); doSave({ overwriteId: id }) }}
                style={{
                  background: '#1a1a1a', border: '0.5px solid #2a2a2a', borderRadius: 14,
                  color: '#ccc', fontSize: 13, padding: '14px 20px', cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                Sobreescribir existente
              </button>
              <button
                onClick={() => { setConfirmId(null); doSave({ forceNew: true }) }}
                style={{
                  background: 'none', border: '0.5px solid #1e1e1e', borderRadius: 14,
                  color: '#555', fontSize: 13, padding: '14px 20px', cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                Crear nueva entrada
              </button>
              <button
                onClick={() => setConfirmId(null)}
                style={{
                  background: 'none', border: 'none',
                  color: '#333', fontSize: 12, padding: '10px', cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                Cancelar
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// ── Modal detalle de entrada ──────────────────────────────
function ProgressDetailModal({ entry, onClose }: { entry: ProgressEntry; onClose: () => void }) {
  const [y, m, d] = entry.date.split('-').map(Number)
  const dateDisplay = new Date(y, m - 1, d)
    .toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
  const hasMeasurements = MEASURES.some(({ key }) => entry.measurements[key] !== undefined)
  const activePRs = entry.prs.filter(pr => pr.weight !== undefined || pr.reps !== undefined)

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100 }}
      />
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: '#0d0d0d', borderRadius: '24px 24px 0 0',
          maxHeight: '88vh', overflowY: 'auto', zIndex: 101,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#222' }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 20px 20px' }}>
          <span style={{ fontSize: 16, color: '#ccc', fontWeight: 200 }}>{dateDisplay}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <X size={18} color="#555" />
          </button>
        </div>

        {entry.photos.length > 0 && (
          <div style={{
            display: 'flex', overflowX: 'auto', gap: 12, padding: '0 20px 24px',
            scrollSnapType: 'x mandatory',
          }}>
            {entry.photos.map((url, i) => (
              <img key={i} src={url} alt=""
                style={{
                  width: 240, height: 320, borderRadius: 16,
                  objectFit: 'cover', flexShrink: 0, scrollSnapAlign: 'start',
                }}
              />
            ))}
          </div>
        )}

        <div style={{ padding: '0 20px 48px' }}>

          {entry.measurements['body_weight'] && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 40, color: '#fff', fontWeight: 200, lineHeight: 1, letterSpacing: '-1px' }}>
                  {entry.measurements['body_weight']}
                </span>
                <span style={{ fontSize: 18, color: '#555', fontWeight: 300 }}>kg</span>
              </div>
              <div style={{ fontSize: 10, color: '#333', letterSpacing: '2px', marginTop: 6 }}>PESO CORPORAL</div>
            </div>
          )}

          {hasMeasurements && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: '#444', letterSpacing: '2px', marginBottom: 10 }}>MEDIDAS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {MEASURES.map(({ key, label }) => {
                  const val = entry.measurements[key]
                  if (val === undefined) return null
                  return (
                    <div key={key} style={{
                      display: 'flex', flexDirection: 'column', justifyContent: 'center',
                      padding: '12px 14px',
                      background: 'rgba(255,255,255,0.04)',
                      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                      borderRadius: 12, border: '0.5px solid rgba(255,255,255,0.07)',
                    }}>
                      <div style={{ fontSize: 11, color: '#555', marginBottom: 6, letterSpacing: '1.5px', textTransform: 'uppercase' }}>{label}</div>
                      <div style={{ fontSize: 22, color: '#fff', fontWeight: 300, lineHeight: 1 }}>
                        {val}<span style={{ fontSize: 12, color: '#444', fontWeight: 300, marginLeft: 4 }}> cm</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activePRs.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#444', letterSpacing: '2px', marginBottom: 10 }}>RÉCORDS</div>
              <div style={{
                background: 'rgba(255,255,255,0.04)',
                backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                borderRadius: 12, border: '0.5px solid rgba(255,255,255,0.07)',
                overflow: 'hidden',
              }}>
                {activePRs.map((pr, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '12px 14px',
                    borderBottom: i < activePRs.length - 1 ? '0.5px solid rgba(255,255,255,0.05)' : 'none',
                  }}>
                    <Dumbbell size={15} className="pr-icon-grad" style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: '#666', flex: 1 }}>{pr.name}</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      {pr.weight !== undefined && (
                        <span style={{ fontSize: 15, color: '#ccc', fontWeight: 300 }}>
                          {pr.weight} <span style={{ fontSize: 11, color: '#555' }}>kg</span>
                        </span>
                      )}
                      {pr.reps !== undefined && (
                        <span style={{ fontSize: 12, color: '#444' }}>× {pr.reps}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </>
  )
}

// ── Card de entrada de progreso ───────────────────────────
function ProgressEntryCard({
  entry,
  onTap,
  onEdit,
  onDelete,
}: {
  entry: ProgressEntry
  onTap: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const [y, m, d] = entry.date.split('-').map(Number)
  const dateDisplay = new Date(y, m - 1, d)
    .toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
  const measurementEntries = MEASURES.filter(({ key }) => entry.measurements[key] !== undefined)
  const activePRs = entry.prs.filter(pr => pr.weight !== undefined || pr.reps !== undefined)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      onClick={onTap}
      style={{
        position: 'relative',
        background: '#0f0f0f', border: '0.5px solid #1e1e1e',
        borderRadius: 18, padding: 16, marginBottom: 10, cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      {/* Action buttons top-right */}
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 0 }}>
        <button
          onClick={e => { e.stopPropagation(); setConfirmingDelete(true) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}
        >
          <Trash2 size={13} color="#2a2a2a" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onEdit() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}
        >
          <Pencil size={13} color="#2a2a2a" />
        </button>
      </div>

      {/* Inline delete confirmation overlay */}
      {confirmingDelete && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', inset: 0, borderRadius: 18,
            background: 'rgba(13,13,13,0.97)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16,
            zIndex: 2,
          }}
        >
          <span style={{ fontSize: 13, color: '#ccc', fontWeight: 300 }}>¿Eliminar esta entrada?</span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              style={{
                background: '#1a0808', border: '0.5px solid #3a1010', borderRadius: 10,
                color: '#e05555', fontSize: 13, padding: '8px 24px', cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              Sí
            </button>
            <button
              onClick={e => { e.stopPropagation(); setConfirmingDelete(false) }}
              style={{
                background: 'none', border: '0.5px solid #1e1e1e', borderRadius: 10,
                color: '#555', fontSize: 13, padding: '8px 24px', cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              No
            </button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 14, color: '#ccc', fontWeight: 200, letterSpacing: '-0.5px', marginBottom: 12, paddingRight: 60 }}>
        {dateDisplay}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, overflowX: 'auto' }}>
        {entry.photos.length > 0
          ? entry.photos.map((url, i) => (
              <img key={i} src={url} alt=""
                style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
            ))
          : (
            <div style={{
              width: 72, height: 72, borderRadius: 10, background: '#111',
              border: '0.5px solid #1a1a1a', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#2a2a2a" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8,4 L9.5,2 L12.5,2 L14,4 L17,4 C17.6,4 18,4.4 18,5 L18,15 C18,15.6 17.6,16 17,16 L5,16 C4.4,16 4,15.6 4,15 L4,5 C4,4.4 4.4,4 5,4 Z"/>
                <circle cx="11" cy="10" r="3"/>
              </svg>
            </div>
          )
        }
      </div>

      {entry.measurements['body_weight'] && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 14 }}>
          <span style={{ fontSize: 22, color: '#fff', fontWeight: 200, letterSpacing: '-0.5px' }}>
            {entry.measurements['body_weight']}
          </span>
          <span style={{ fontSize: 13, color: '#555' }}>kg</span>
          <span style={{ fontSize: 10, color: '#2a2a2a', letterSpacing: '1.5px', marginLeft: 3 }}>PESO CORPORAL</span>
        </div>
      )}

      {measurementEntries.length > 0 && (
        <div style={{ marginBottom: activePRs.length > 0 ? 12 : 0 }}>
          <div style={{ fontSize: 9, color: '#2a2a2a', letterSpacing: '2px', marginBottom: 7 }}>MEDIDAS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {measurementEntries.map(({ key, label }) => (
              <div key={key} style={{
                display: 'flex', flexDirection: 'column',
                padding: '8px 10px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: 8, border: '0.5px solid #1a1a1a',
              }}>
                <span style={{ fontSize: 10, color: '#3a3a3a', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 4 }}>{label}</span>
                <span style={{ fontSize: 14, color: '#aaa', fontWeight: 300 }}>
                  {entry.measurements[key]}<span style={{ fontSize: 9, color: '#3a3a3a', marginLeft: 2 }}> cm</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activePRs.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#2a2a2a', letterSpacing: '2px', marginBottom: 7 }}>RÉCORDS</div>
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 8, border: '0.5px solid #1a1a1a',
            overflow: 'hidden',
          }}>
            {activePRs.map((pr, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '8px 10px',
                borderBottom: i < activePRs.length - 1 ? '0.5px solid #161616' : 'none',
              }}>
                <Dumbbell size={12} className="pr-icon-grad" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#555', flex: 1 }}>{pr.name}</span>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                  {pr.weight !== undefined && (
                    <span style={{ fontSize: 12, color: '#888', fontWeight: 300 }}>
                      {pr.weight} <span style={{ fontSize: 9, color: '#444' }}>kg</span>
                    </span>
                  )}
                  {pr.reps !== undefined && (
                    <span style={{ fontSize: 11, color: '#333' }}>× {pr.reps}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  )
}

function MacroRing({
  current, max, color, label, loading, goalKey, onSave,
}: {
  current: number
  max: number
  color: string
  label: string
  loading: boolean
  goalKey: string
  onSave: (val: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const pct = Math.min(current / max, 1)
  const offset = RING_C * (1 - pct)

  const startEdit = () => {
    setInputVal(String(max))
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 30)
  }

  const save = () => {
    const val = parseInt(inputVal, 10)
    if (!isNaN(val) && val > 0) {
      onSave(val)
      supabase
        .from('user_settings')
        .upsert({ key: goalKey, value: String(val) }, { onConflict: 'key' })
        .then(() => {})
    }
    setEditing(false)
  }

  return (
    <div style={{
      flex: 1,
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border: '0.5px solid rgba(255,255,255,0.08)',
      borderRadius: 16,
      padding: '16px 8px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      boxShadow: '0 0 0 0.5px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
    }}>
      {/* Neon top border */}
      <div style={{
        position: 'absolute', top: 0, left: '15%', right: '15%', height: 1, borderRadius: 1,
        background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), rgba(6,182,212,0.3), transparent)',
        pointerEvents: 'none',
      }} />
      <div style={{ position: 'relative', width: 70, height: 70, flexShrink: 0 }}>
        <svg width="70" height="70" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="35" cy="35" r={RING_R} fill="none" stroke="#1a1a1a" strokeWidth="5" />
          <motion.circle
            cx="35" cy="35" r={RING_R}
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            initial={{ strokeDashoffset: RING_C }}
            animate={{ strokeDashoffset: loading ? RING_C : offset }}
            transition={{ duration: 1.2, ease: [0.4, 0, 0.2, 1] }}
          />
        </svg>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 14, color: '#e0e0e0', fontWeight: 200, lineHeight: 1, whiteSpace: 'nowrap',
        }}>
          {loading ? '—' : current}
        </div>
      </div>

      {editing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <input
            ref={inputRef}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
            onBlur={save}
            type="number"
            style={{
              width: 36, background: 'none', border: 'none',
              borderBottom: '0.5px solid #333', outline: 'none',
              fontSize: 10, color: '#888', textAlign: 'center',
              fontFamily: 'Inter, sans-serif', padding: '0 1px',
            }}
          />
          <span style={{ fontSize: 10, color: '#333' }}>g</span>
          <button onClick={save} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
            <Check size={9} color="#555" />
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#333', lineHeight: 1 }}>de {max}g</span>
          <button onClick={startEdit} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
            <Pencil size={8} color="#333" />
          </button>
        </div>
      )}

      <div style={{ fontSize: 9, color: '#3a3a3a', letterSpacing: '0.5px', lineHeight: 1 }}>{label}</div>
    </div>
  )
}

const BODY_STYLES = `
  .pr-icon-grad path,
  .pr-icon-grad line,
  .pr-icon-grad circle,
  .pr-icon-grad rect,
  .pr-icon-grad polyline {
    stroke: url(#prDumbbellGrad) !important;
  }
  .progress-add-btn {
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    padding: 14px 0 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Inter, sans-serif;
    font-size: 18px;
    color: #333;
    filter: drop-shadow(0 0 5px rgba(139,92,246,0.18)) drop-shadow(0 0 10px rgba(6,182,212,0.1));
    transition: color 0.25s, filter 0.25s;
    -webkit-tap-highlight-color: transparent;
  }
  .progress-add-btn:hover,
  .progress-add-btn:active {
    color: #888;
    filter: drop-shadow(0 0 10px rgba(139,92,246,0.55)) drop-shadow(0 0 20px rgba(6,182,212,0.3));
  }
`

export default function BodyScreen() {
  const [meals, setMeals] = useState<MealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [count, setCount] = useState(0)
  const [weekData, setWeekData] = useState<WeekDay[]>([])
  const [goalCalories, setGoalCalories] = useState<number>(2200)
  const [macroGoals, setMacroGoals] = useState<MacroGoals>({ protein: 180, carbs: 220, fat: 70 })
  const [progressEntries, setProgressEntries] = useState<ProgressEntry[]>([])
  const [showProgressModal, setShowProgressModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<ProgressEntry | undefined>(undefined)
  const [detailEntry, setDetailEntry] = useState<ProgressEntry | null>(null)
  const [showAllMeals, setShowAllMeals] = useState(false)

  useEffect(() => {
    supabase
      .from('user_settings')
      .select('key, value')
      .in('key', ['goal_calories', 'goal_protein', 'goal_carbs', 'goal_fat'])
      .then(({ data }) => {
        if (!data) return
        const map: Record<string, number> = {}
        data.forEach(row => {
          const v = parseInt(row.value, 10)
          if (!isNaN(v) && v > 0) map[row.key] = v
        })
        if (map.goal_calories) setGoalCalories(map.goal_calories)
        if (map.goal_protein || map.goal_carbs || map.goal_fat) {
          setMacroGoals(prev => ({
            protein: map.goal_protein ?? prev.protein,
            carbs:   map.goal_carbs   ?? prev.carbs,
            fat:     map.goal_fat     ?? prev.fat,
          }))
        }
      })
  }, [])

  const fetchMeals = useCallback(async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    const { data } = await supabase
      .from('meals')
      .select('*')
      .gte('created_at', today.toISOString())
      .lt('created_at', tomorrow.toISOString())
      .order('created_at', { ascending: true })

    setMeals((data ?? []) as MealRow[])
    setLoading(false)
  }, [])

  const fetchWeekData = useCallback(async () => {
    const monday = getMondayOfWeek(new Date())
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    sunday.setHours(23, 59, 59, 999)

    const { data } = await supabase
      .from('meals')
      .select('created_at, calories')
      .gte('created_at', monday.toISOString())
      .lte('created_at', sunday.toISOString())

    const grouped: Record<string, number> = {}
    data?.forEach(m => {
      const key = localDateStr(new Date(m.created_at))
      grouped[key] = (grouped[key] ?? 0) + (m.calories ?? 0)
    })

    const todayStr = localDateStr(new Date())
    const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      const key = localDateStr(d)
      return { date: key, calories: grouped[key] ?? 0, isToday: key === todayStr }
    })

    setWeekData(days)
  }, [])

  const fetchProgressEntries = useCallback(async () => {
    const { data } = await supabase
      .from('progress_entries')
      .select('*')
      .order('date', { ascending: false })
    setProgressEntries((data ?? []) as ProgressEntry[])
  }, [])

  useEffect(() => { fetchProgressEntries() }, [fetchProgressEntries])

  const refreshAll = useCallback(() => {
    fetchMeals()
    fetchWeekData()
  }, [fetchMeals, fetchWeekData])

  useEffect(() => {
    refreshAll()
    window.addEventListener('meal-saved', refreshAll)
    return () => window.removeEventListener('meal-saved', refreshAll)
  }, [refreshAll])

  useEffect(() => {
    const scheduleMidnightReset = () => {
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      const ms = midnight.getTime() - now.getTime()
      return setTimeout(() => { refreshAll(); scheduleMidnightReset() }, ms)
    }
    const timer = scheduleMidnightReset()
    return () => clearTimeout(timer)
  }, [refreshAll])

  const prevCalRef = useRef(0)
  useEffect(() => {
    if (loading) return
    const from = prevCalRef.current
    const to = totals.calories
    prevCalRef.current = to
    const duration = 1200
    const startTime = performance.now()
    const animate = (now: number) => {
      const elapsed = now - startTime
      const ease = 1 - Math.pow(1 - Math.min(elapsed / duration, 1), 3)
      setCount(Math.round(from + ease * (to - from)))
      if (elapsed < duration) requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, meals])

  const totals = meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein:  acc.protein  + (m.protein  ?? 0),
      carbs:    acc.carbs    + (m.carbs    ?? 0),
      fat:      acc.fat      + (m.fat      ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  )


  const dayCircleColor = (day: WeekDay) => {
    if (day.calories === 0) return '#1e1e1e'
    const pct = day.calories / goalCalories
    if (pct >= 1) return '#2ecc71'
    if (pct >= 0.8) return '#f39c12'
    return '#1e1e1e'
  }

  const weekMax = Math.max(goalCalories * 1.5, ...weekData.map(d => d.calories), 1)

  const openNewModal = () => {
    setEditingEntry(undefined)
    setShowProgressModal(true)
  }

  const openEditModal = (entry: ProgressEntry) => {
    setEditingEntry(entry)
    setShowProgressModal(true)
  }

  const closeProgressModal = () => {
    setShowProgressModal(false)
    setEditingEntry(undefined)
  }

  const handleDeleteEntry = useCallback(async (id: string) => {
    await supabase.from('progress_entries').delete().eq('id', id)
    fetchProgressEntries()
  }, [fetchProgressEntries])

  return (
    <div style={{ position: 'relative', overflow: 'hidden', minHeight: '100vh', height: '100%' }}>
      <style>{BODY_STYLES}</style>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="prDumbbellGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="0" spreadMethod="repeat">
            <stop offset="0%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#06B6D4" />
            <animate attributeName="x1" values="0;24;0" dur="3s" repeatCount="indefinite" />
            <animate attributeName="x2" values="24;48;24" dur="3s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
      </svg>

      {/* ── Depth orbs — Linear style ──────────────────── */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute', width: 500, height: 500, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, rgba(139,92,246,0.05) 40%, transparent 70%)',
          top: -200, left: '50%', transform: 'translateX(-50%)',
          filter: 'blur(80px)',
        }} />
        <div style={{
          position: 'absolute', width: 350, height: 350, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 65%)',
          bottom: 100, right: -100,
          filter: 'blur(70px)',
        }} />
      </div>

      {/* Scrollable content */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>

        {/* ── 1. Header ──────────────────────────────────── */}
        <div style={{ padding: '20px 20px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {(weekData.length === 7
              ? weekData
              : Array.from({ length: 7 }, (_, i) => ({ date: '', calories: 0, isToday: false, _i: i } as WeekDay & { _i?: number }))
            ).map((day, i) => {
              const dayNum = day.date ? parseInt(day.date.split('-')[2], 10) : null
              const borderColor = dayCircleColor(day)
              return (
                <div
                  key={day.date || i}
                  style={{
                    width: 36, height: 36, borderRadius: '50%',
                    border: day.isToday ? 'none' : `1.5px solid ${borderColor}`,
                    background: day.isToday ? '#ffffff' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {dayNum !== null && (
                    <span style={{
                      fontSize: 12, lineHeight: 1,
                      fontWeight: day.isToday ? 500 : 300,
                      color: day.isToday ? '#000000' : '#3a3a3a',
                    }}>
                      {dayNum}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── 2. Calorías — card horizontal ─────────────── */}
        <div style={{ padding: '12px 20px 24px' }}>
          {(() => {
            const pct      = loading ? 0 : Math.min(totals.calories / goalCalories, 1)
            const offset   = CAL_CIRCLE_C * (1 - pct)
            const label    = loading ? '—' : `${Math.round(pct * 100)}%`
            return (
              <div style={{
                padding: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}>

                {/* Left */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 52, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
                    {loading ? '—' : count}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                    kcal consumidas
                  </div>
                </div>

                {/* Right — neon circle */}
                <div style={{
                  position: 'relative', width: 110, height: 110, flexShrink: 0,
                  borderRadius: '50%',
                  boxShadow: '0 0 20px rgba(139,92,246,0.3), 0 0 40px rgba(6,182,212,0.15)',
                }}>
                  <svg width="110" height="110" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
                    <defs>
                      <linearGradient id="calGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%"   stopColor="#8B5CF6" />
                        <stop offset="100%" stopColor="#06B6D4" />
                      </linearGradient>
                      <filter id="calGlow" x="-60%" y="-60%" width="220%" height="220%">
                        <feGaussianBlur stdDeviation="3.5" />
                      </filter>
                    </defs>

                    {/* Track */}
                    <circle
                      cx="55" cy="55" r={CAL_CIRCLE_R}
                      fill="rgba(255,255,255,0.05)"
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="6"
                    />

                    {/* Glow layer */}
                    <motion.circle
                      cx="55" cy="55" r={CAL_CIRCLE_R}
                      fill="none"
                      stroke="url(#calGrad)"
                      strokeWidth="10"
                      strokeLinecap="round"
                      strokeDasharray={CAL_CIRCLE_C}
                      initial={{ strokeDashoffset: CAL_CIRCLE_C }}
                      animate={{ strokeDashoffset: loading ? CAL_CIRCLE_C : offset }}
                      transition={{ duration: 1.2, ease: [0.4, 0, 0.2, 1] }}
                      opacity={0.2}
                      filter="url(#calGlow)"
                    />

                    {/* Progress */}
                    <motion.circle
                      cx="55" cy="55" r={CAL_CIRCLE_R}
                      fill="none"
                      stroke="url(#calGrad)"
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={CAL_CIRCLE_C}
                      initial={{ strokeDashoffset: CAL_CIRCLE_C }}
                      animate={{ strokeDashoffset: loading ? CAL_CIRCLE_C : offset }}
                      transition={{ duration: 1.2, ease: [0.4, 0, 0.2, 1] }}
                    />
                  </svg>
                  <div style={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    fontSize: 15, fontWeight: 700, color: '#fff', lineHeight: 1,
                  }}>
                    {label}
                  </div>
                </div>

              </div>
            )
          })()}
        </div>

        {/* ── 3. Macro cards ─────────────────────────────── */}
        <div style={{ padding: '0 16px 24px', display: 'flex', gap: 10 }}>
          <MacroRing
            current={totals.protein} max={macroGoals.protein}
            color="#EC4899" label="Proteína" loading={loading}
            goalKey="goal_protein"
            onSave={val => setMacroGoals(prev => ({ ...prev, protein: val }))}
          />
          <MacroRing
            current={totals.carbs} max={macroGoals.carbs}
            color="#8B5CF6" label="Carbos" loading={loading}
            goalKey="goal_carbs"
            onSave={val => setMacroGoals(prev => ({ ...prev, carbs: val }))}
          />
          <MacroRing
            current={totals.fat} max={macroGoals.fat}
            color="#06B6D4" label="Grasa" loading={loading}
            goalKey="goal_fat"
            onSave={val => setMacroGoals(prev => ({ ...prev, fat: val }))}
          />
        </div>

        {/* ── 4. Comidas recientes ───────────────────────── */}
        <div style={{
          margin: '0 16px 24px',
          position: 'relative',
          background: 'rgba(255,255,255,0.03)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: 14,
          boxShadow: '0 0 0 0.5px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ position: 'absolute', top: 0, left: '15%', right: '15%', height: 1, borderRadius: 1, background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), rgba(6,182,212,0.3), transparent)', pointerEvents: 'none' }} />
          <div style={{ fontSize: 11, color: '#444', letterSpacing: '2px', marginBottom: 10 }}>COMIDAS</div>

          {loading && (
            <div style={{ fontSize: 12, color: '#2a2a2a', textAlign: 'center', padding: '20px 0' }}>Cargando...</div>
          )}
          {!loading && meals.length === 0 && (
            <div style={{ fontSize: 12, color: '#2a2a2a', textAlign: 'center', padding: '20px 0' }}>Sin comidas registradas hoy.</div>
          )}
          {(showAllMeals ? meals : meals.slice(0, 3)).map((meal, i) => (
            <motion.div
              key={meal.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px',
                background: '#0f0f0f',
                border: '0.5px solid #161616',
                borderRadius: 16,
                marginBottom: 7,
              }}
            >
              {meal.image_url && (
                <img
                  src={meal.image_url}
                  alt=""
                  style={{ width: 50, height: 50, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#ccc', fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {meal.name}
                </div>
                <div style={{ fontSize: 10, color: '#2a2a2a', marginTop: 3 }}>
                  {new Date(meal.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#555', fontWeight: 200, flexShrink: 0 }}>{meal.calories}</div>
            </motion.div>
          ))}
          {meals.length > 3 && (
            <button
              onClick={() => setShowAllMeals(v => !v)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 11, color: '#444', fontFamily: 'Inter, sans-serif',
                padding: '6px 0', width: '100%', textAlign: 'center',
              }}
            >
              {showAllMeals ? 'Ocultar' : `Ver todas (${meals.length})`}
            </button>
          )}
        </div>

        {/* ── 5. Gráfica semanal ─────────────────────────── */}
        <div style={{
          margin: '0 16px 40px',
          position: 'relative',
          background: 'rgba(255,255,255,0.03)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: 14,
          boxShadow: '0 0 0 0.5px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ position: 'absolute', top: 0, left: '15%', right: '15%', height: 1, borderRadius: 1, background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), rgba(6,182,212,0.3), transparent)', pointerEvents: 'none' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: '#444', letterSpacing: '2px', paddingTop: 2 }}>ESTA SEMANA</div>
            {(() => {
              const daysWithData = weekData.filter(d => d.calories > 0)
              if (daysWithData.length === 0) return null
              const avg = Math.round(daysWithData.reduce((s, d) => s + d.calories, 0) / daysWithData.length)
              return (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: '#2a2a2a' }}>{avg} kcal</div>
                  <div style={{ fontSize: 9, color: '#2a2a2a', letterSpacing: '1.5px' }}>PROMEDIO</div>
                </div>
              )
            })()}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 6 }}>
            {(weekData.length === 7
              ? weekData
              : Array.from({ length: 7 }, (_, i) => ({ date: String(i), calories: 0, isToday: false }))
            ).map((day, i) => {
              const barH = day.calories > 0
                ? Math.max(6, Math.round((day.calories / weekMax) * BAR_MAX_H))
                : 0
              return (
                <div key={day.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <div style={{ height: BAR_MAX_H, display: 'flex', alignItems: 'flex-end', width: '100%', justifyContent: 'center' }}>
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: barH }}
                      transition={{ duration: 0.9, delay: i * 0.06, ease: [0.4, 0, 0.2, 1] }}
                      style={{
                        width: '100%', maxWidth: 28, borderRadius: 6,
                        background: day.calories > 0 ? 'linear-gradient(to top, #8B5CF6, #EC4899)' : '#141414',
                        opacity: day.isToday ? 1 : day.calories > 0 ? 0.55 : 1,
                        boxShadow: day.isToday && day.calories > 0 ? '0 0 12px rgba(139,92,246,0.35)' : 'none',
                      }}
                    />
                  </div>
                  <span style={{
                    fontSize: 9, letterSpacing: '0.3px',
                    color: day.isToday ? '#555' : '#252525',
                    fontWeight: day.isToday ? 500 : 300,
                  }}>
                    {DAY_SHORT[i]}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── 6. Progreso ────────────────────────────────── */}
        <div style={{
          margin: '0 16px 80px',
          position: 'relative',
          background: 'rgba(255,255,255,0.03)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: 14,
          boxShadow: '0 0 0 0.5px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ position: 'absolute', top: 0, left: '15%', right: '15%', height: 1, borderRadius: 1, background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), rgba(6,182,212,0.3), transparent)', pointerEvents: 'none' }} />
          <div style={{ fontSize: 11, color: '#444', letterSpacing: '2px', marginBottom: 12 }}>PROGRESO</div>
          {progressEntries.length === 0 ? (
            <div style={{ fontSize: 12, color: '#2a2a2a', textAlign: 'center', padding: '20px 0' }}>
              Sin entradas de progreso aún.
            </div>
          ) : (
            progressEntries.map(entry => (
              <ProgressEntryCard
                key={entry.id}
                entry={entry}
                onTap={() => setDetailEntry(entry)}
                onEdit={() => openEditModal(entry)}
                onDelete={() => handleDeleteEntry(entry.id)}
              />
            ))
          )}
          <button className="progress-add-btn" onClick={openNewModal}>+</button>
        </div>

        {/* Modales */}
        <AnimatePresence>
          {showProgressModal && (
            <ProgressModal
              key={editingEntry?.id ?? 'new'}
              onClose={closeProgressModal}
              onSaved={() => { closeProgressModal(); fetchProgressEntries() }}
              editEntry={editingEntry}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {detailEntry && (
            <ProgressDetailModal
              entry={detailEntry}
              onClose={() => setDetailEntry(null)}
            />
          )}
        </AnimatePresence>

      </div>

    </div>
  )
}
