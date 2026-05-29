import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Camera, ArrowUp, Mic, Square } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { addTaskFromAtlas } from './FeedScreen'

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY
const PAGE_SIZE = 50

// ── Prompts ───────────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `Eres Atlas. Compañero inteligente y directo, no coach motivacional ni psicólogo. Responde siempre en el idioma del usuario. Máximo 2 párrafos cortos por respuesta, preferiblemente 1. Nunca uses más palabras de las necesarias. Solo confronta o profundiza cuando el usuario claramente busca consejo o reflexión. Si el usuario miente o exagera, una sola frase seca, sin análisis. Tienes opiniones y las dices cuando vienen al caso — sin sermonear.

COMIDA — cuando el usuario mencione haber comido o bebido algo, o envíe una foto, usa save_meal con los macros estimados y confirma brevemente: qué guardaste y los macros. Punto. Sin consejos ni comentarios sobre la elección. Si es foto, analiza visualmente y estima directamente. Nunca pidas confirmación.

MEMORIA — usa save_memory para cualquier detalle personal relevante: nombre, meta, hábito, queja, plan, persona importante. Nunca pidas confirmación. Categorías: nutricion, deporte, salud_medica, emociones, crecimiento, amistad, amor, familia, finanzas, proyectos, rutinas. Un solo save_memory por mensaje.

INICIATIVA — 1 de cada 4 respuestas, termina con una pregunta corta y específica basada en lo que ya sabes del usuario. Nunca genérica. Las otras 3, no preguntes nada.`

function buildSystemPrompt(memory: string): string {
  return memory ? `${BASE_SYSTEM_PROMPT}\n\n${memory}` : BASE_SYSTEM_PROMPT
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const SAVE_MEAL_TOOL = {
  name: 'save_meal',
  description: 'Guarda una comida con sus macronutrientes estimados en la base de datos.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name:     { type: 'string',  description: 'Nombre de la comida o alimento' },
      calories: { type: 'integer', description: 'Calorías totales estimadas' },
      protein:  { type: 'integer', description: 'Proteína en gramos' },
      carbs:    { type: 'integer', description: 'Carbohidratos en gramos' },
      fat:      { type: 'integer', description: 'Grasa en gramos' },
    },
    required: ['name', 'calories', 'protein', 'carbs', 'fat'],
  },
}

const SAVE_MEMORY_TOOL = {
  name: 'save_memory',
  description: 'Guarda información relevante del usuario en la memoria persistente de Atlas.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: { type: 'string', description: 'Categoría: nutricion, deporte, salud_medica, emociones, crecimiento, amistad, amor, familia, finanzas, proyectos, rutinas' },
      summary:  { type: 'string', description: 'Resumen conciso (1-2 frases)' },
      raw_text: { type: 'string', description: 'Texto original del usuario' },
    },
    required: ['category', 'summary', 'raw_text'],
  },
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ImagePayload = { dataUrl: string; base64: string; mediaType: string; file?: File }
type Message = {
  id: string
  role: 'ai' | 'user'
  text: string
  image?: ImagePayload
  createdAt: Date
  memoryCategories?: string[]
  feedTasks?: Array<{ title: string; priority: 'red' | 'orange' | 'green' }>
}
type ApiMessage = { role: 'user' | 'assistant'; content: string | object[] }
type DbRow = { id: string; role: string; content: string; image_url: string | null; created_at: string }

// ── Day helpers ───────────────────────────────────────────────────────────────

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function formatDayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(date, today)) return 'Hoy'
  if (isSameDay(date, yesterday)) return 'Ayer'
  return date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
}

function rowToMessage(row: DbRow): Message {
  return {
    id: row.id,
    role: row.role as 'ai' | 'user',
    text: row.content,
    createdAt: new Date(row.created_at),
    ...(row.image_url ? { image: { dataUrl: row.image_url, base64: '', mediaType: 'image/jpeg' } } : {}),
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const LINE_STYLES = `
  @keyframes atlas-flow {
    0%   { background-position: 0% 50%; }
    100% { background-position: 200% 50%; }
  }
  @keyframes atlas-glow-pulse {
    0%, 100% {
      filter: drop-shadow(0 0 6px #8B5CF6) drop-shadow(0 0 14px #06B6D4) drop-shadow(0 0 28px #EC4899);
    }
    50% {
      filter: drop-shadow(0 0 14px #8B5CF6) drop-shadow(0 0 32px #06B6D4) drop-shadow(0 0 64px #EC4899);
    }
  }
  .atlas-listen-line {
    height: 1px;
    background: linear-gradient(90deg, #8B5CF6, #06B6D4, #EC4899, #8B5CF6);
    background-size: 300% 100%;
    animation: atlas-flow 3s linear infinite;
  }
  .memory-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 9px;
    color: rgba(255,255,255,0.7);
    background: linear-gradient(90deg, #8B5CF6, #06B6D4, #EC4899, #8B5CF6);
    background-size: 300% 100%;
    animation: atlas-flow 3s linear infinite;
    font-family: Inter, sans-serif;
    font-weight: 400;
    letter-spacing: 0.4px;
    white-space: nowrap;
  }
  .atlas-orb-wrap {
    animation: atlas-glow-pulse 4s ease-in-out infinite;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  .task-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 9px;
    font-family: Inter, sans-serif;
    font-weight: 400;
    letter-spacing: 0.4px;
    white-space: nowrap;
  }
  .task-pill-red    { background: rgba(239,68,68,0.12);  border: 0.5px solid rgba(239,68,68,0.28);  color: #EF4444; }
  .task-pill-orange { background: rgba(245,158,11,0.12); border: 0.5px solid rgba(245,158,11,0.28); color: #F59E0B; }
  .task-pill-green  { background: rgba(16,185,129,0.12); border: 0.5px solid rgba(16,185,129,0.28); color: #10B981; }
  @keyframes mic-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
    50%       { opacity: 0.7; box-shadow: 0 0 0 6px rgba(239,68,68,0); }
  }
  .mic-recording { animation: mic-pulse 1s ease-in-out infinite; }
`

// ── Atlas Triangle ─────────────────────────────────────────────────────────────

function AtlasOrb({ onClick }: { onClick: () => void }) {
  return (
    <div className="atlas-orb-wrap" onClick={onClick}>
      <svg width="145" height="145" viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="tri-grad" gradientUnits="userSpaceOnUse" x1="10" y1="18" x2="110" y2="102">
            <stop offset="0%"   stopColor="#8B5CF6" />
            <stop offset="45%"  stopColor="#06B6D4" />
            <stop offset="80%"  stopColor="#EC4899" />
            <stop offset="100%" stopColor="#8B5CF6" />
            <animateTransform
              attributeName="gradientTransform"
              type="rotate"
              from="0 60 46"
              to="360 60 46"
              dur="3s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
        <polygon
          points="10,18 110,18 60,102"
          stroke="url(#tri-grad)"
          strokeWidth="2"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

// Module-level: persists scroll position across component remounts within the same session
let _savedScrollPos = 0

export default function ChatScreen({ isActive }: { isActive: boolean }) {
  const [chatMode, setChatMode] = useState<boolean>(() => {
    const last = parseInt(localStorage.getItem('atlas_chat_last_visit') ?? '0', 10)
    return Date.now() - last < 10_000
  })
  const [messages,     setMessages]     = useState<Message[]>(() => {
    try {
      const raw = localStorage.getItem('atlas_chat_messages')
      if (!raw) return []
      const parsed = JSON.parse(raw) as Array<Omit<Message, 'createdAt'> & { createdAt: string }>
      return parsed.map(m => ({ ...m, createdAt: new Date(m.createdAt) }))
    } catch { return [] }
  })
  const [input,        setInput]        = useState('')
  const [loading,      setLoading]      = useState(false)
  const [memoryCtx,    setMemoryCtx]    = useState('')
  const [pendingImage, setPendingImage] = useState<ImagePayload | null>(null)
  const [hasMore,        setHasMore]        = useState(false)
  const [loadingMore,    setLoadingMore]    = useState(false)
  const [isRecording,    setIsRecording]    = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [recordSeconds,  setRecordSeconds]  = useState(0)
  const [recordError,    setRecordError]    = useState(false)
  const [dbgLogs,        setDbgLogs]        = useState<string[]>([])
  const [dbgVisible,     setDbgVisible]     = useState(false)

  const bottomRef        = useRef<HTMLDivElement>(null)
  const fileInputRef     = useRef<HTMLInputElement>(null)
  const textareaRef      = useRef<HTMLTextAreaElement>(null)
  const scrollRef        = useRef<HTMLDivElement>(null)
  const oldestCreatedAt  = useRef<string | null>(null)
  const autoScroll       = useRef(true)
  const initialMsgCount  = useRef(messages.length)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef   = useRef<Blob[]>([])
  const recordTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Tab visibility: show/skip triangle based on elapsed time ────────────────

  useEffect(() => {
    if (!isActive) return
    const last = parseInt(localStorage.getItem('atlas_chat_last_visit') ?? '0', 10)
    setChatMode(Date.now() - last < 10_000)
  }, [isActive])

  const enterChat = () => {
    localStorage.setItem('atlas_chat_last_visit', String(Date.now()))
    setChatMode(true)
    // Wait for AnimatePresence mode="wait" exit (400ms) + render before scrolling
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, 500)
  }

  // ── Initialize: memory + history + daily greeting ────────────────────────────

  useEffect(() => {
    const initialize = async () => {

      // 1. Memory
      const { data: memData } = await supabase
        .from('atlas_memory')
        .select('category, summary')
        .order('created_at', { ascending: false })
        .limit(20)

      let memory = ''
      if (memData && memData.length > 0) {
        const grouped: Record<string, string[]> = {}
        for (const row of memData) {
          if (!grouped[row.category]) grouped[row.category] = []
          grouped[row.category].push(row.summary)
        }
        memory = 'MEMORIA DE ATLAS:\n' + Object.entries(grouped)
          .map(([cat, s]) => `[${cat}] ${s.join(' | ')}`)
          .join('\n')
        setMemoryCtx(memory)
      }

      // 2. Chat history
      const { data: histData } = await supabase
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (histData) {
        const msgs = [...histData].reverse().map(rowToMessage)
        setMessages(msgs)
        setHasMore(histData.length === PAGE_SIZE)
        if (histData.length > 0) oldestCreatedAt.current = histData[histData.length - 1].created_at
      }

      // 3. Daily greeting — only if hour >= 8 and not already sent today
      const now = new Date()
      if (now.getHours() < 8) return

      const todayKey = now.toLocaleDateString('en-CA')
      if (localStorage.getItem('last_greeting_date') === todayKey) return

      const todayStart = new Date(now)
      todayStart.setHours(0, 0, 0, 0)

      const { data: existing } = await supabase
        .from('chat_messages')
        .select('id')
        .eq('daily_summary', true)
        .gte('created_at', todayStart.toISOString())
        .limit(1)

      if (existing && existing.length > 0) {
        localStorage.setItem('last_greeting_date', todayKey)
        return
      }

      // Lock immediately so any concurrent execution skips
      localStorage.setItem('last_greeting_date', todayKey)

      const isMonday = now.getDay() === 1
      let greetingSystem: string
      let maxTokens = 300

      if (isMonday) {
        const lastMonday = new Date(now)
        lastMonday.setDate(now.getDate() - 7)
        lastMonday.setHours(0, 0, 0, 0)
        const lastSunday = new Date(now)
        lastSunday.setDate(now.getDate() - 1)
        lastSunday.setHours(23, 59, 59, 999)

        const { data: goalData } = await supabase
          .from('user_settings')
          .select('value')
          .eq('key', 'goal_calories')
          .single()
        const goalCalories = goalData ? (parseInt(goalData.value, 10) || 2200) : 2200

        const { data: weekMeals } = await supabase
          .from('meals')
          .select('created_at, calories')
          .gte('created_at', lastMonday.toISOString())
          .lte('created_at', lastSunday.toISOString())

        const dayTotals: Record<string, number> = {}
        weekMeals?.forEach(m => {
          const key = new Date(m.created_at).toLocaleDateString('en-CA')
          dayTotals[key] = (dayTotals[key] ?? 0) + (m.calories ?? 0)
        })
        const dayValues = Object.values(dayTotals)
        const avgCalories = dayValues.length > 0
          ? Math.round(dayValues.reduce((s, c) => s + c, 0) / dayValues.length)
          : 0
        const daysMetGoal = dayValues.filter(c => c >= goalCalories).length

        const nutritionLine = dayValues.length > 0
          ? `Promedio calórico: ${avgCalories} kcal/día. Días que cumplieron el objetivo (${goalCalories} kcal): ${daysMetGoal} de ${dayValues.length} días registrados.`
          : 'Sin registros de alimentación la semana pasada.'

        const { data: weekMemData } = await supabase
          .from('atlas_memory')
          .select('category, summary')
          .gte('updated_at', lastMonday.toISOString())
          .lte('updated_at', lastSunday.toISOString())
          .order('updated_at', { ascending: false })

        let weekMemoryStr = ''
        if (weekMemData && weekMemData.length > 0) {
          const grouped: Record<string, string[]> = {}
          for (const row of weekMemData) {
            if (!grouped[row.category]) grouped[row.category] = []
            grouped[row.category].push(row.summary)
          }
          weekMemoryStr = 'MEMORIA DE LA SEMANA PASADA:\n' + Object.entries(grouped)
            .map(([cat, s]) => `[${cat}] ${s.join(' | ')}`)
            .join('\n')
        }

        maxTokens = 500
        greetingSystem = `${buildSystemPrompt(memory)}

${weekMemoryStr ? `${weekMemoryStr}\n\n` : ''}ALIMENTACIÓN SEMANA PASADA: ${nutritionLine}

Es lunes. Genera un resumen semanal breve e introspectivo para Pau. Incluye: una frase estoica relevante a lo que vivió, resumen emocional y personal basado en la memoria, cómo fue la semana en alimentación con los datos reales, y una intención o reflexión para la semana nueva. Tono directo, cercano, sin ser condescendiente. Máximo 150 palabras.`

      } else {
        const yesterday = new Date(now)
        yesterday.setDate(yesterday.getDate() - 1)
        const yStart = new Date(yesterday); yStart.setHours(0, 0, 0, 0)
        const yEnd   = new Date(yesterday); yEnd.setHours(23, 59, 59, 999)

        const { data: meals } = await supabase
          .from('meals')
          .select('name, calories, protein')
          .gte('created_at', yStart.toISOString())
          .lte('created_at', yEnd.toISOString())

        const mealsLine = meals && meals.length > 0
          ? `Comidas de ayer: ${meals.map(m => `${m.name} (${m.calories} kcal, ${m.protein}g prot)`).join(' · ')}.`
          : 'Sin comidas registradas ayer.'

        greetingSystem = `${buildSystemPrompt(memory)}

Genera un saludo de buenos días conciso. Incluye: ${mealsLine} Si hay contexto relevante en la memoria (proyectos, emociones, deporte), añade un recordatorio o intención del día. Termina con una frase estoica breve (Marco Aurelio, Séneca o Epicteto) relacionada con crecimiento, disciplina o constancia, en una línea separada, de forma natural. Sin florituras ni citas con comillas excesivas. Máximo 150 palabras en total.`
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: maxTokens,
          system: greetingSystem,
          messages: [{ role: 'user', content: 'Buenos días.' }],
        }),
      })
      if (!res.ok) return

      const greetingData = await res.json()
      const textBlock = greetingData.content?.find((b: { type: string }) => b.type === 'text')
      if (!textBlock?.text) return

      const greetingText: string = textBlock.text
      const greetingMsg: Message = {
        id: Date.now().toString(),
        role: 'ai',
        text: greetingText,
        createdAt: new Date(),
      }

      setMessages(prev => [...prev, greetingMsg])
      autoScroll.current = true

      await supabase.from('chat_messages').insert({
        role: 'ai',
        content: greetingText,
        daily_summary: true,
      })
    }

    initialize()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-resize textarea ─────────────────────────────────────────────────────

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxH = window.innerHeight * 0.4
    const newH = Math.min(el.scrollHeight, maxH)
    el.style.height = newH + 'px'
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
  }, [input])

  // ── Auto-scroll (only when new messages arrive beyond initial load) ──────────

  useEffect(() => {
    if (messages.length > initialMsgCount.current && autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length])

  // ── Scroll position persistence ──────────────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => { _savedScrollPos = el.scrollTop }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (scrollRef.current && _savedScrollPos > 0) {
      scrollRef.current.scrollTop = _savedScrollPos
    }
  }, [])

  // ── Sync messages to localStorage (max 100, no base64) ───────────────────────

  useEffect(() => {
    if (messages.length === 0) return
    try {
      const toSave = messages.slice(-100).map(m => ({
        ...m,
        image: m.image ? { dataUrl: m.image.dataUrl, base64: '', mediaType: m.image.mediaType } : undefined,
      }))
      localStorage.setItem('atlas_chat_messages', JSON.stringify(toSave))
    } catch { /* localStorage quota exceeded */ }
  }, [messages])

  // ── Load more ────────────────────────────────────────────────────────────────

  const loadMore = useCallback(async () => {
    if (!oldestCreatedAt.current || loadingMore) return
    setLoadingMore(true)
    autoScroll.current = false

    const container = scrollRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0

    const { data } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .lt('created_at', oldestCreatedAt.current)
      .limit(PAGE_SIZE)

    if (!data || data.length === 0) {
      setHasMore(false)
      setLoadingMore(false)
      autoScroll.current = true
      return
    }

    const olderMsgs = [...data].reverse().map(rowToMessage)
    setMessages(prev => [...olderMsgs, ...prev])
    setHasMore(data.length === PAGE_SIZE)
    oldestCreatedAt.current = data[data.length - 1].created_at

    requestAnimationFrame(() => {
      if (container) container.scrollTop = container.scrollHeight - prevScrollHeight
      autoScroll.current = true
      setLoadingMore(false)
    })
  }, [loadingMore])

  // ── Save to DB ───────────────────────────────────────────────────────────────

  const saveMessage = async (role: 'user' | 'ai', text: string, imageDataUrl?: string) => {
    await supabase.from('chat_messages').insert({ role, content: text, image_url: imageDataUrl ?? null })
  }

  // ── API ──────────────────────────────────────────────────────────────────────

  const callAnthropic = async (apiMessages: ApiMessage[], systemPrompt: string) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        tools: [SAVE_MEAL_TOOL, SAVE_MEMORY_TOOL],
        messages: apiMessages,
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`)
    }
    return res.json()
  }

  const executeTool = async (tb: { id: string; name: string; input: Record<string, string & number> }): Promise<{ content: string; savedCategory?: string }> => {
    if (tb.name === 'save_meal') {
      const { name: mealName, calories, protein, carbs, fat } = tb.input
      const { error } = await supabase.from('meals').insert({ name: mealName, calories, protein, carbs, fat })
      if (!error) window.dispatchEvent(new CustomEvent('meal-saved'))
      return { content: error ? `Error: ${error.message}` : 'Comida guardada.' }
    }
    if (tb.name === 'save_memory') {
      const { category, summary, raw_text } = tb.input
      const { error } = await supabase.from('atlas_memory').insert({ category, summary, raw_text })
      return {
        content: error ? `Error: ${error.message}` : 'Memoria guardada.',
        savedCategory: error ? undefined : String(category),
      }
    }
    return { content: 'Herramienta desconocida.' }
  }

  // ── File picker ──────────────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      setPendingImage({ dataUrl, base64: dataUrl.split(',')[1], mediaType: file.type || 'image/jpeg', file })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // ── Voice recording + Whisper transcription ─────────────────────────────────

  const dbg = (msg: string) => {
    const t = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setDbgLogs(prev => [`${t} ${msg}`, ...prev].slice(0, 60))
  }

  const toggleRecording = async () => {
    if (isTranscribing) return

    if (isRecording) {
      mediaRecorderRef.current?.stop()
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      setIsRecording(false)
      setRecordSeconds(0)
      return
    }

    setRecordError(false)
    setDbgVisible(true)
    dbg('─── nueva grabación ───')

    try {
      dbg('solicitando permiso micrófono…')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      dbg('permiso concedido')

      // iOS Safari only supports audio/mp4; Chrome supports webm
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      dbg(`mimeType: ${mimeType}`)

      const mediaRecorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []
      let chunkCount = 0

      mediaRecorder.ondataavailable = (e) => {
        chunkCount++
        dbg(`chunk #${chunkCount}: ${e.data.size} bytes`)
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        dbg(`blob size: ${blob.size} bytes (${chunkCount} chunks)`)

        if (blob.size === 0) {
          dbg('ERROR: blob vacío — abortando')
          setRecordError(true)
          return
        }

        setIsTranscribing(true)
        try {
          const ext = mimeType.startsWith('audio/mp4') ? 'mp4' : 'webm'
          dbg(`enviando a Edge Function… (recording.${ext})`)

          const formData = new FormData()
          formData.append('file', blob, `recording.${ext}`)

          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
              body: formData,
            }
          )

          dbg(`status: ${res.status}`)
          const data = await res.json()
          dbg(`respuesta: ${JSON.stringify(data)}`)

          if (data.text) {
            setInput(prev => prev ? `${prev} ${data.text}` : data.text)
            dbg('✓ transcripción OK')
          } else {
            dbg(`ERROR: sin texto — ${JSON.stringify(data)}`)
            setRecordError(true)
          }
        } catch (error) {
          dbg(`ERROR transcripción: ${(error as Error).message}`)
          setRecordError(true)
        } finally {
          setIsTranscribing(false)
        }
      }

      // timeslice=1000ms: ensures ondataavailable fires every second on WebKit/iOS
      mediaRecorder.start(1000)
      dbg('grabación iniciada (timeslice 1000ms)')
      setIsRecording(true)
      setRecordSeconds(0)
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000)
    } catch (error) {
      dbg(`ERROR acceso micrófono: ${(error as Error).message}`)
      setIsRecording(false)
      setRecordError(true)
    }
  }

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      mediaRecorderRef.current?.stop()
    }
  }, [])

  // ── Task extractor (silent, non-blocking) ────────────────────────────────────

  const extractAndSaveTasks = async (userText: string, msgId: string) => {
    try {
      console.log('[Feed] Extrayendo tareas de:', userText)
      const today = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date())
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 512,
          system: `Eres un extractor de tareas. Analiza el mensaje del usuario y extrae SOLO si hay tareas, eventos o recordatorios concretos. Devuelve SOLO JSON válido sin texto adicional. Si no hay tareas devuelve []`,
          messages: [{
            role: 'user',
            content: `Extrae tareas de este mensaje: '${userText.replace(/'/g, "\\'")}'\nDevuelve array JSON con este formato exacto:\n[{"title":"título corto y claro","type":"task|event|reminder","priority":"red|orange|green","scheduled_at":"ISO 8601 o null","notes":"contexto adicional o null"}]\n\nReglas de prioridad:\n- red: citas médicas, pagos, deadlines, llamadas importantes\n- orange: gym, estudiar, revisar finanzas, proyectos\n- green: rutinas, recordatorios suaves, cosas opcionales\n\nFecha actual: ${today}`,
          }],
        }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        console.error('[Feed] Error HTTP extractor:', res.status, errBody)
        return
      }
      const data = await res.json()
      console.log('[Feed] Respuesta extractor:', JSON.stringify(data, null, 2))

      const textBlock = data.content?.find((b: { type: string }) => b.type === 'text')
      if (!textBlock?.text) {
        console.warn('[Feed] Sin bloque de texto en respuesta extractor')
        return
      }

      // Strip markdown code fences if the model wraps JSON in ```json ... ```
      const rawText = textBlock.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

      let extracted: Array<{ title: string; type: 'task' | 'event' | 'reminder'; priority: 'red' | 'orange' | 'green'; scheduled_at?: string; notes?: string }> = []
      try {
        extracted = JSON.parse(rawText)
      } catch (parseErr) {
        console.error('[Feed] Error parseando JSON extractor:', parseErr, '| raw:', rawText)
        return
      }
      console.log('[Feed] Tareas extraídas:', extracted)

      if (!Array.isArray(extracted) || extracted.length === 0) return

      const created: Array<{ title: string; priority: 'red' | 'orange' | 'green' }> = []
      for (const task of extracted) {
        try {
          const payload = {
            title: task.title,
            type: task.type ?? 'task',
            priority: task.priority ?? 'orange',
            scheduled_at: task.scheduled_at && task.scheduled_at !== 'null' ? task.scheduled_at : undefined,
            notes: task.notes && task.notes !== 'null' ? task.notes : undefined,
          } as const
          console.log('[Feed] Llamando addTaskFromAtlas con:', payload)
          await addTaskFromAtlas(payload)
          created.push({ title: task.title, priority: task.priority ?? 'orange' })
        } catch (taskErr) {
          console.error('[Feed] Error en addTaskFromAtlas:', taskErr)
        }
      }

      if (created.length > 0) {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, feedTasks: created } : m))
      }
    } catch (err) {
      console.error('[Feed] Error general extractAndSaveTasks:', err)
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  const send = async () => {
    if ((!input.trim() && !pendingImage) || loading) return

    const userText = input.trim()
    const imageToSend = pendingImage
    setInput('')
    setPendingImage(null)
    autoScroll.current = true

    const newMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: userText,
      createdAt: new Date(),
      ...(imageToSend && { image: imageToSend }),
    }
    setMessages(prev => [...prev, newMsg])
    setLoading(true)

    // Upload image to chat-images bucket and save public URL instead of base64
    let imagePublicUrl: string | undefined
    if (imageToSend?.file) {
      const ext = imageToSend.file.name.split('.').pop() ?? 'jpg'
      const path = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('chat-images').upload(path, imageToSend.file)
      if (!error) {
        const { data } = supabase.storage.from('chat-images').getPublicUrl(path)
        imagePublicUrl = data.publicUrl
      }
    }
    saveMessage('user', userText, imagePublicUrl)

    const systemPrompt = buildSystemPrompt(memoryCtx)

    try {
      const allMessages = messages.concat(newMsg)
      let startIdx = 0
      while (startIdx < allMessages.length && allMessages[startIdx].role === 'ai') startIdx++

      const history: ApiMessage[] = allMessages.slice(startIdx).map(m => {
        if (m.role === 'user' && m.image && m.image.base64) {
          return {
            role: 'user' as const,
            content: [
              { type: 'image', source: { type: 'base64', media_type: m.image.mediaType, data: m.image.base64 } },
              { type: 'text', text: m.text || 'Analiza esta imagen.' },
            ],
          }
        }
        return { role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.text }
      }).filter(m => typeof m.content !== 'string' || m.content.trim() !== '')

      let data = await callAnthropic(history, systemPrompt)
      const savedCategories: string[] = []

      if (data.stop_reason === 'tool_use') {
        const toolBlocks = data.content.filter((b: { type: string }) => b.type === 'tool_use')
        const results = await Promise.all(
          toolBlocks.map((tb: { id: string; name: string; input: Record<string, string & number> }) => executeTool(tb))
        )
        for (const r of results) if (r.savedCategory) savedCategories.push(r.savedCategory)

        const toolResults = toolBlocks.map((tb: { id: string }, i: number) => ({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: results[i].content,
        }))

        data = await callAnthropic([
          ...history,
          { role: 'assistant', content: data.content },
          { role: 'user', content: toolResults },
        ], systemPrompt)
      }

      const textBlock = data.content?.find((b: { type: string }) => b.type === 'text')
      const aiText = textBlock?.text ?? 'Hecho.'
      const aiMsgId = Date.now().toString()

      setMessages(prev => [...prev, {
        id: aiMsgId,
        role: 'ai',
        text: aiText,
        createdAt: new Date(),
        ...(savedCategories.length > 0 && { memoryCategories: savedCategories }),
      }])
      saveMessage('ai', aiText)

      if (userText.trim()) extractAndSaveTasks(userText, aiMsgId)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'ai', text: `Error: ${msg}`, createdAt: new Date() }])
    } finally {
      setLoading(false)
    }
  }

  // ── Render messages ──────────────────────────────────────────────────────────

  const renderMessages = () => {
    const nodes: React.ReactNode[] = []
    let lastDayLabel = ''

    for (const msg of messages) {
      const dayLabel = formatDayLabel(msg.createdAt)
      if (dayLabel !== lastDayLabel) {
        lastDayLabel = dayLabel
        nodes.push(
          <div key={`sep-${msg.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
            <div style={{ flex: 1, height: '0.5px', background: '#1e1e1e' }} />
            <span style={{ fontSize: 10, color: '#333', fontWeight: 400, letterSpacing: 1, whiteSpace: 'nowrap' }}>
              {dayLabel.toUpperCase()}
            </span>
            <div style={{ flex: 1, height: '0.5px', background: '#1e1e1e' }} />
          </div>
        )
      }

      nodes.push(
        <motion.div
          key={msg.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
        >
          <div style={{
            maxWidth: '82%',
            padding: msg.image && !msg.text ? '6px' : '11px 15px',
            borderRadius: msg.role === 'ai' ? 16 : 20,
            borderBottomLeftRadius: msg.role === 'ai' ? 5 : 20,
            borderBottomRightRadius: msg.role === 'user' ? 5 : 20,
            ...(msg.role === 'ai' ? {
              background: 'rgba(255,255,255,0.04)',
              backdropFilter: 'blur(12px)',
              border: '0.5px solid rgba(255,255,255,0.07)',
            } : {
              background: '#1c1c1e',
              border: '0.5px solid #252525',
            }),
            fontSize: 13,
            fontWeight: 300,
            color: msg.role === 'ai' ? '#aaa' : '#ddd',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
          }}>
            {msg.image && (
              <img
                src={msg.image.dataUrl}
                alt=""
                style={{ display: 'block', maxWidth: '100%', maxHeight: 220, borderRadius: 14, objectFit: 'cover', marginBottom: msg.text ? 8 : 0 }}
              />
            )}
            {msg.text}
          </div>

          {msg.memoryCategories && msg.memoryCategories.length > 0 && (
            <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
              {msg.memoryCategories.map(cat => (
                <span key={cat} className="memory-pill">💾 {cat}</span>
              ))}
            </div>
          )}

          {msg.feedTasks && msg.feedTasks.length > 0 && (
            <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
              {msg.feedTasks.map((t, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.08, duration: 0.18 }}
                  className={`task-pill task-pill-${t.priority}`}
                >
                  ✓ Feed: {t.title}
                </motion.span>
              ))}
            </div>
          )}
        </motion.div>
      )
    }
    return nodes
  }

  // ── JSX ──────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '100vh', position: 'relative', zIndex: 1, overflow: 'hidden' }}>
      <style>{LINE_STYLES}</style>

      {/* ── Depth orbs ─────────────────────────────────── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute', width: 350, height: 350, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 65%)',
          top: -150, left: '50%', transform: 'translateX(-50%)',
          filter: 'blur(70px)',
        }} />
        <div style={{
          position: 'absolute', width: 280, height: 280, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 65%)',
          bottom: 60, right: -80,
          filter: 'blur(60px)',
        }} />
      </div>

      <AnimatePresence mode="wait">
        {!chatMode ? (

          // ── LOGO STATE ─────────────────────────────────────────────────────
          <motion.div
            key="logo-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <AtlasOrb onClick={enterChat} />
          </motion.div>

        ) : (

          // ── CHAT STATE ─────────────────────────────────────────────────────
          <motion.div
            key="chat-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          >
            <div
              ref={scrollRef}
              style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 16px 160px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}
            >
              {hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    style={{ background: 'none', border: '0.5px solid #222', borderRadius: 20, padding: '6px 16px', fontSize: 11, color: '#444', cursor: loadingMore ? 'default' : 'pointer', fontFamily: 'Inter, sans-serif', letterSpacing: 0.5 }}
                  >
                    {loadingMore ? '···' : 'Cargar más'}
                  </button>
                </div>
              )}

              <div style={{ flex: 1 }} />
              {renderMessages()}

              {loading && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{ padding: '11px 15px', borderRadius: 20, borderBottomLeftRadius: 5, background: '#141414', border: '0.5px solid #1e1e1e', fontSize: 13, color: '#444', fontWeight: 300 }}>
                    ···
                  </div>
                </motion.div>
              )}

              <div ref={bottomRef} />
            </div>

            <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 'min(390px, 100vw)', height: 150, background: 'linear-gradient(to top, #080810 60%, transparent)', zIndex: 55, pointerEvents: 'none' }} />
            <div style={{ position: 'fixed', bottom: 90, left: '50%', transform: 'translateX(-50%)', width: 'min(calc(390px - 32px), calc(100vw - 32px))', zIndex: 60, background: 'rgba(8,8,16,0.98)', pointerEvents: 'all' }}>
              <div className="atlas-listen-line" />

              <AnimatePresence>
                {pendingImage && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ padding: '8px 16px 0', overflow: 'hidden' }}
                  >
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <img src={pendingImage.dataUrl} alt="" style={{ height: 64, width: 64, borderRadius: 10, objectFit: 'cover', display: 'block', border: '0.5px solid #252525' }} />
                      <button
                        onClick={() => setPendingImage(null)}
                        style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#333', border: 'none', color: '#aaa', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >✕</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '12px 16px 14px', background: 'transparent' }}>
                <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
                <div style={{ flex: 1, background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: '11px 16px', display: 'flex', alignItems: 'flex-end', gap: 8, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)' }}>
                  <textarea
                    ref={textareaRef}
                    value={input}
                    rows={1}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                    }}
                    placeholder="Ask anything..."
                    style={{ background: 'none', border: 'none', outline: 'none', fontSize: 13, color: '#888', fontWeight: 300, width: '100%', fontFamily: 'Inter, sans-serif', resize: 'none', overflowY: 'hidden', lineHeight: '1.5', padding: 0, display: 'block' }}
                  />
                </div>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ width: 32, height: 32, borderRadius: '50%', background: pendingImage ? '#1a1a2e' : '#111', border: `0.5px solid ${pendingImage ? '#8B5CF6' : '#1e1e1e'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.2s, border 0.2s' }}
                >
                  <Camera size={14} color={pendingImage ? '#8B5CF6' : '#333'} />
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={toggleRecording}
                  disabled={isTranscribing}
                  className={isRecording ? 'mic-recording' : ''}
                  style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: isRecording ? 'rgba(239,68,68,0.15)' : recordError ? 'rgba(249,115,22,0.12)' : '#111',
                    border: `0.5px solid ${isRecording ? '#EF4444' : recordError ? '#f97316' : '#1e1e1e'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: isTranscribing ? 'default' : 'pointer',
                    transition: 'background 0.2s, border 0.2s',
                    position: 'relative',
                  }}
                >
                  {isTranscribing ? (
                    <span style={{ fontSize: 8, color: '#888', fontFamily: 'Inter, sans-serif', letterSpacing: 0 }}>···</span>
                  ) : isRecording ? (
                    <>
                      <Square size={10} color="#EF4444" fill="#EF4444" />
                      <span style={{ position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)', fontSize: 8, color: '#EF4444', fontFamily: 'Inter, sans-serif', whiteSpace: 'nowrap' }}>{recordSeconds}s</span>
                    </>
                  ) : (
                    <Mic size={14} color={recordError ? '#f97316' : 'rgba(255,255,255,0.5)'} />
                  )}
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={send}
                  disabled={loading}
                  style={{ width: 32, height: 32, borderRadius: '50%', background: loading ? '#333' : '#f0f0f0', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: loading ? 'default' : 'pointer', transition: 'background 0.2s' }}
                >
                  <ArrowUp size={14} color={loading ? '#555' : '#0a0a0a'} />
                </motion.button>
              </div>
            </div>
          </motion.div>

        )}
      </AnimatePresence>

      {/* ── DEBUG PANEL — temporal, borrar cuando no se necesite ── */}
      {dbgVisible && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.92)', borderTop: '1px solid #2a2a2a',
          maxHeight: '45vh', overflowY: 'auto',
          padding: '8px 10px 12px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, position: 'sticky', top: 0, background: 'rgba(0,0,0,0.92)', paddingBottom: 4 }}>
            <span style={{ fontSize: 10, color: '#f97316', fontWeight: 700, letterSpacing: 1.5, fontFamily: 'monospace' }}>MIC DEBUG</span>
            <button
              onClick={() => { setDbgLogs([]); setDbgVisible(false) }}
              style={{ fontSize: 10, color: '#888', background: 'none', border: '1px solid #333', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'monospace' }}
            >
              cerrar ✕
            </button>
          </div>
          {dbgLogs.length === 0 ? (
            <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace' }}>sin logs aún</div>
          ) : dbgLogs.map((line, i) => (
            <div key={i} style={{
              fontSize: 10, lineHeight: 1.6, fontFamily: 'monospace',
              color: line.includes('ERROR') ? '#EF4444' : line.includes('✓') ? '#22c55e' : line.includes('───') ? '#f97316' : '#bbb',
            }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
