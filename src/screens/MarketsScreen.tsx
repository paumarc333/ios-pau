import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { TrendingUp, TrendingDown, RefreshCw, Plus, X, Search } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Quote {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  prevClose: number
  history: number[]
}

interface NewsItem {
  id: string
  headline: string
  summary: string
  source: string
  datetime: number
  url: string
  category: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FINNHUB_KEY       = import.meta.env.VITE_FINNHUB_KEY       || ''
const ANTHROPIC_KEY     = import.meta.env.VITE_ANTHROPIC_API_KEY  || ''
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL       || ''
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY  || ''
const USE_MOCK          = !FINNHUB_KEY

const INDICES = [
  { symbol: 'SPY', displayName: 'S&P 500' },
  { symbol: 'EWG', displayName: 'DAX 40'  },
  { symbol: 'FXI', displayName: 'CSI 300' },
]

const INDEX_FLAGS: Record<string, string> = {
  SPY: '🇺🇸',
  EWG: '🇪🇺',
  FXI: '🇨🇳',
}

const DEFAULT_WATCHLIST  = ['TSLA', 'GOOGL', 'RKLB', 'NVDA']
const WATCHLIST_KEY      = 'markets_watchlist'
const DEEP_RESEARCH_KEY  = 'markets_deep_research'
const DEEP_RESEARCH_TTL  = 7 * 24 * 3600 * 1000  // 7 days

const STOCK_NAMES: Record<string, string> = {
  TSLA:  'Tesla',
  GOOGL: 'Alphabet',
  RKLB:  'Rocket Lab',
  NVDA:  'NVIDIA',
  AAPL:  'Apple',
  AMZN:  'Amazon',
  MSFT:  'Microsoft',
  META:  'Meta',
  SPY:   'S&P 500 ETF',
  QQQ:   'Nasdaq 100 ETF',
  DIA:   'Dow Jones ETF',
  EWG:   'DAX ETF',
  EWU:   'FTSE 100 ETF',
  FXI:   'China A50 ETF',
}

// European-listed tickers → €
const EUROPEAN_SYMBOLS = new Set([
  'DAX', 'SAP', 'SIE', 'BMW', 'VOW3', 'ADS', 'DTE', 'BAS', 'BAYN',
  'ALV', 'MRK', 'HEN3', 'BEI', 'FRE', 'CON', 'RWE', 'MTX',
])

function getCurrency(symbol: string): string {
  return EUROPEAN_SYMBOLS.has(symbol) ? '€' : '$'
}

// ─── Mock ─────────────────────────────────────────────────────────────────────

function mockQuote(symbol: string, displayName?: string): Quote {
  const seed    = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const base    = 50 + (seed % 450)
  const history = Array.from({ length: 7 }, (_, i) =>
    base * (1 + Math.sin(seed * 0.3 + i * 1.2) * 0.04 + Math.cos(seed * 0.7 + i * 0.8) * 0.02)
  )
  const last   = history[history.length - 1]
  const prev   = history[history.length - 2]
  const change = last - prev
  return {
    symbol,
    name:          displayName ?? STOCK_NAMES[symbol] ?? symbol,
    price:         +last.toFixed(2),
    change:        +change.toFixed(2),
    changePercent: +((change / prev) * 100).toFixed(2),
    high:          +(last * 1.015).toFixed(2),
    low:           +(last * 0.985).toFixed(2),
    prevClose:     +prev.toFixed(2),
    history,
  }
}


// ─── Finnhub API ──────────────────────────────────────────────────────────────

async function finnhubQuote(symbol: string) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`)
  return r.json() as Promise<{ c: number; d: number; dp: number; h: number; l: number; pc: number }>
}

function syntheticHistory(symbol: string, prevClose: number, price: number): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return Array.from({ length: 7 }, (_, i) => {
    const t     = i / 6
    const base  = prevClose + (price - prevClose) * t
    const noise = Math.sin(seed * 0.5 + i * 1.7) * Math.abs(price - prevClose) * 0.12
    return i === 6 ? price : base + noise
  })
}

// ─── News via Supabase + Atlas ────────────────────────────────────────────────

const NEWS_TTL_MS = 24 * 3600 * 1000  // 24 h

const SB_HEADERS = {
  'Content-Type': 'application/json',
  apikey:         SUPABASE_ANON_KEY,
  Authorization:  `Bearer ${SUPABASE_ANON_KEY}`,
}

async function readNewsCache(): Promise<{ articles: NewsItem[]; fetched_at: string } | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/news_cache?select=articles,fetched_at&order=fetched_at.desc&limit=1`,
      { headers: SB_HEADERS }
    )
    if (!res.ok) return null
    const rows = await res.json() as Array<{ articles: NewsItem[]; fetched_at: string }>
    return rows[0] ?? null
  } catch { return null }
}

async function writeNewsCache(articles: NewsItem[]): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/news_cache`, {
      method:  'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body:    JSON.stringify({ articles, fetched_at: new Date().toISOString() }),
    })
  } catch { /* ignore */ }
}

async function fetchNewsViaAtlas(): Promise<NewsItem[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key':    ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 2048,
      system:     'Eres Atlas, asistente de noticias. Busca noticias reales y actuales. Devuelve SOLO JSON válido, sin texto adicional, sin markdown.',
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{
        role:    'user',
        content: 'Busca en estos medios las noticias más importantes de hoy:\n- Fútbol: busca en marca.com las 5 noticias más importantes de hoy\n- IA y tecnología: busca en technologyreview.com y xataka.com las 5 noticias más importantes de hoy\n- Geopolítica: busca en elpais.com/internacional las 5 noticias más importantes de hoy\n\nDevuelve exactamente este JSON:\n[\n  {\n    "id": "1",\n    "headline": "titular en español",\n    "summary": "resumen en español máximo 200 caracteres",\n    "category": "Fútbol|IA & Tech|Mundo",\n    "source": "Marca|Xataka|El País"\n  }\n]\nSolo el array JSON, nada más.',
      }],
    }),
  })

  const d = await res.json()

  const allText = (d.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')

  const cleaned = allText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  const m       = cleaned.match(/\[[\s\S]*\]/)
  if (!m) return []

  let articles: Array<{ id: string; headline: string; summary: string; category: string; source: string }> = []
  try {
    articles = JSON.parse(m[0])
  } catch {
    return []
  }

  return articles
    .map((n, i) => ({
      id:       n.id       ?? `news-${i}`,
      headline: n.headline ?? '',
      summary:  n.summary  ?? '',
      source:   n.source   ?? '',
      datetime: Math.floor(Date.now() / 1000),
      url:      '#',
      category: n.category ?? '',
    }))
    .filter(n => n.headline)
}

function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000)
  if (mins < 1)  return 'ahora mismo'
  if (mins < 60) return `hace ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `hace ${hrs}h`
  return `hace ${Math.floor(hrs / 24)}d`
}

async function loadQuote(symbol: string, displayName?: string): Promise<Quote> {
  const q = await finnhubQuote(symbol)
  if (q.c === undefined || q.c === null) throw new Error('invalid response')
  const price     = +q.c.toFixed(2)
  const prevClose = +q.pc.toFixed(2)
  return {
    symbol,
    name:          displayName ?? STOCK_NAMES[symbol] ?? symbol,
    price,
    change:        +q.d.toFixed(2),
    changePercent: +q.dp.toFixed(2),
    high:          +q.h.toFixed(2),
    low:           +q.l.toFixed(2),
    prevClose,
    history:       syntheticHistory(symbol, prevClose, price),
  }
}

// ─── Atlas ────────────────────────────────────────────────────────────────────

async function atlasAnalysis(indices: Quote[], watchlist: Quote[], headlines: string[]): Promise<string> {
  const priceLines = [...indices, ...watchlist].map(
    q => `${q.name ?? q.symbol}: ${q.price} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%)`
  )
  const newsLines = headlines.slice(0, 5).map((h, i) => `${i + 1}. ${h}`)
  const content   = [
    'PRECIOS:\n' + priceLines.join('\n'),
    headlines.length ? '\nNOTICIAS:\n' + newsLines.join('\n') : '',
    '\nAnálisis breve en español, máx 3 frases directas sobre el estado del mercado hoy. Sin saludos.',
  ].join('')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 220,
      messages:   [{ role: 'user', content }],
    }),
  })
  const d = await res.json()
  return d.content?.[0]?.text ?? 'Sin análisis disponible.'
}


// ─── Ambient particles ────────────────────────────────────────────────────────

const PARTICLES = [
  { x: '12%',  y: '7%',   size: 5, color: '#8B5CF6', opacity: 0.22, blur: 48, dur: 8,  delay: 0   },
  { x: '80%',  y: '12%',  size: 4, color: '#06B6D4', opacity: 0.18, blur: 55, dur: 11, delay: 2.2 },
  { x: '55%',  y: '28%',  size: 6, color: '#EC4899', opacity: 0.15, blur: 42, dur: 7,  delay: 4.5 },
  { x: '90%',  y: '52%',  size: 3, color: '#8B5CF6', opacity: 0.25, blur: 60, dur: 9,  delay: 1.3 },
  { x: '18%',  y: '68%',  size: 5, color: '#06B6D4', opacity: 0.17, blur: 50, dur: 12, delay: 3.1 },
  { x: '64%',  y: '82%',  size: 4, color: '#EC4899', opacity: 0.2,  blur: 44, dur: 6,  delay: 5.7 },
]

function AmbientParticles() {
  return (
    <>
      {PARTICLES.map((p, i) => (
        <motion.div
          key={i}
          animate={{ y: [-20, 20, -20], x: [-10, 10, -10] }}
          transition={{ duration: p.dur, repeat: Infinity, delay: p.delay, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            borderRadius: '50%',
            background: p.color,
            opacity: p.opacity,
            filter: `blur(${p.blur}px)`,
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ h, radius = 8 }: { h: number; radius?: number }) {
  return (
    <motion.div
      animate={{ opacity: [0.25, 0.5, 0.25] }}
      transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
      style={{ height: h, background: 'rgba(255,255,255,0.05)', borderRadius: radius }}
    />
  )
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const W     = 64, H = 28
  const color = positive ? '#10B981' : '#EF4444'
  if (data.length < 2) return <div style={{ width: W, height: H }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  // Flat line when all candles are identical (no real history available)
  if (min === max) {
    return (
      <svg width={W} height={H} style={{ overflow: 'visible', flexShrink: 0, display: 'block' }}>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2}
          stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.35" />
      </svg>
    )
  }
  const range = max - min
  const pts   = data.map((v, i) =>
    `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * H}`
  ).join(' ')
  return (
    <svg width={W} height={H} style={{ overflow: 'visible', flexShrink: 0, display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color}
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
    </svg>
  )
}

// ─── Index card ───────────────────────────────────────────────────────────────

function IndexCard({ quote }: { quote: Quote }) {
  const pos      = quote.changePercent >= 0
  const accent   = pos ? '#10B981' : '#EF4444'
  const topGrad  = pos
    ? 'linear-gradient(90deg, transparent, rgba(16,185,129,0.5), transparent)'
    : 'linear-gradient(90deg, transparent, rgba(239,68,68,0.5), transparent)'
  const currency = getCurrency(quote.symbol)
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      style={{
        flex: 1, background: '#111', border: '0.5px solid #1e1e1e',
        borderRadius: 18, padding: '12px 10px', minWidth: 0,
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: topGrad }} />
      {INDEX_FLAGS[quote.symbol] && (
        <div style={{
          position: 'absolute', bottom: 6, right: 8,
          fontSize: 28, opacity: 0.12, lineHeight: 1,
          pointerEvents: 'none', userSelect: 'none',
        }}>
          {INDEX_FLAGS[quote.symbol]}
        </div>
      )}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ fontSize: 9, color: '#444', letterSpacing: '1.5px', marginBottom: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {quote.name}
        </div>
        <div style={{ fontSize: 16, color: '#e0e0e0', fontWeight: 200, letterSpacing: '-0.5px', lineHeight: 1 }}>
          {currency}{quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 6 }}>
          {pos ? <TrendingUp size={9} color={accent} /> : <TrendingDown size={9} color={accent} />}
          <span style={{ fontSize: 10, color: accent }}>
            {pos ? '+' : ''}{quote.changePercent.toFixed(2)}%
          </span>
        </div>
      </div>
    </motion.div>
  )
}

// ─── Watchlist row ────────────────────────────────────────────────────────────

function WatchlistRow({ quote, onRemove }: { quote: Quote; onRemove: () => void }) {
  const pos         = quote.changePercent >= 0
  const accent      = pos ? '#10B981'               : '#EF4444'
  const badgeBg     = pos ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)'
  const badgeBorder = pos ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'
  const topGrad     = pos
    ? 'linear-gradient(90deg, transparent, rgba(16,185,129,0.5), transparent)'
    : 'linear-gradient(90deg, transparent, rgba(239,68,68,0.5), transparent)'
  const currency = getCurrency(quote.symbol)
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px',
        background: '#0f0f0f', border: '0.5px solid #161616',
        borderRadius: 16, marginBottom: 7,
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: topGrad }} />

      {/* Symbol + name */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: '#fff', fontWeight: 700, letterSpacing: '-0.2px', lineHeight: 1 }}>
          {quote.symbol}
        </div>
        <div style={{ fontSize: 11, color: '#555', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {quote.name}
        </div>
      </div>

      {/* Sparkline */}
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <Sparkline data={quote.history} positive={pos} />
      </div>

      {/* Price + badge */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 15, color: '#fff', fontWeight: 600, letterSpacing: '-0.3px', lineHeight: 1 }}>
          {currency}{quote.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', marginTop: 5,
          padding: '2px 7px', borderRadius: 6,
          background: badgeBg, border: `0.5px solid ${badgeBorder}`,
        }}>
          <span style={{ fontSize: 10, color: accent, fontWeight: 500, letterSpacing: '0.2px' }}>
            {pos ? '+' : ''}{quote.changePercent.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Remove */}
      <motion.button
        whileTap={{ scale: 0.8 }} onClick={onRemove}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0, opacity: 0.35 }}
      >
        <X size={13} color="#888" />
      </motion.button>
    </motion.div>
  )
}

// ─── News components ─────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  'Fútbol':    '#10B981',
  'IA & Tech': '#8B5CF6',
  'Mundo':     '#06B6D4',
}

function CategoryPill({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? 'rgba(255,255,255,0.3)'
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 9px', borderRadius: 20,
      background: `${color}18`, border: `0.5px solid ${color}40`,
      fontSize: 10, color, letterSpacing: '1px', fontWeight: 500, lineHeight: 1.4,
    }}>
      {category.toUpperCase()}
    </span>
  )
}

function FeaturedNewsCard({ item }: { item: NewsItem }) {
  const h       = Math.floor((Date.now() / 1000 - item.datetime) / 3600)
  const timeStr = h < 1 ? '<1h' : `${h}h`
  const handleClick = () => {
    if (item.url && item.url !== '#') window.open(item.url, '_blank', 'noopener,noreferrer')
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      onClick={handleClick}
      style={{
        padding: '4px 0 16px',
        borderBottom: '0.5px solid rgba(255,255,255,0.06)',
        cursor: item.url && item.url !== '#' ? 'pointer' : 'default',
      }}
    >
      <CategoryPill category={item.category} />
      <div style={{
        fontSize: 17, color: '#fff', fontWeight: 600, lineHeight: 1.4,
        marginTop: 10, marginBottom: 8,
        display: '-webkit-box', WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {item.headline}
      </div>
      <span style={{ fontSize: 11, color: '#444' }}>{timeStr}</span>
    </motion.div>
  )
}

function CompactNewsRow({ item, isLast }: { item: NewsItem; isLast: boolean }) {
  const h       = Math.floor((Date.now() / 1000 - item.datetime) / 3600)
  const timeStr = h < 1 ? '<1h' : `${h}h`
  const handleClick = () => {
    if (item.url && item.url !== '#') window.open(item.url, '_blank', 'noopener,noreferrer')
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      onClick={handleClick}
      style={{
        padding: '12px 0',
        borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.05)',
        cursor: item.url && item.url !== '#' ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <CategoryPill category={item.category} />
        <span style={{ fontSize: 11, color: '#444', flexShrink: 0 }}>{timeStr}</span>
      </div>
      <div style={{
        fontSize: 13, color: '#e0e0e0', fontWeight: 500, lineHeight: 1.45,
        display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {item.headline}
      </div>
    </motion.div>
  )
}

// ─── Deep Research renderer ───────────────────────────────────────────────────

function parseInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <span key={i} style={{ color: '#fff', fontWeight: 600 }}>{part.slice(2, -2)}</span>
      : <span key={i}>{part}</span>
  )
}

function DeepResearchPanel({ text, fetchedAt, onClose }: { text: string; fetchedAt: Date | null; onClose?: () => void }) {
  const sections = text.split(/\n(?=##\s)/).map(s => {
    const m = s.match(/^##\s+(.+)\n?([\s\S]*)$/)
    if (m) return { title: m[1].trim(), body: m[2].trim() }
    return { title: '', body: s.trim() }
  }).filter(s => s.title || s.body)

  return (
    <div style={{
      marginTop: 8,
      background: 'rgba(139,92,246,0.05)',
      border: '0.5px solid rgba(139,92,246,0.15)',
      borderRadius: 12, padding: 16,
      position: 'relative',
    }}>
      {onClose && (
        <button onClick={onClose} style={{
          position: 'absolute', top: 12, right: 12,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 2, display: 'flex', opacity: 0.6,
        }}>
          <X size={14} color="rgba(255,255,255,0.3)" />
        </button>
      )}
      {sections.map((s, i) => (
        <div key={i}>
          {i > 0 && (
            <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '14px 0' }} />
          )}
          {s.title && (
            <div style={{
              fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '2px',
              fontWeight: 600, textTransform: 'uppercase', marginBottom: 8,
            }}>
              {s.title}
            </div>
          )}
          {s.body && (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
              {parseInline(s.body)}
            </div>
          )}
        </div>
      ))}

      <div style={{ marginTop: 20, paddingTop: 12, borderTop: '0.5px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>Generado por Atlas</div>
        {fetchedAt && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.15)', marginTop: 2 }}>
            {fetchedAt.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
            {' · '}
            {fetchedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Add symbol sheet ─────────────────────────────────────────────────────────

function AddSymbolSheet({ existing, onAdd, onClose }: { existing: string[]; onAdd: (s: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')

  const commit = () => {
    const sym = query.trim().toUpperCase()
    if (sym && !existing.includes(sym)) { onAdd(sym); onClose() }
  }

  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100 }} />
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#0d0d0d', borderRadius: '20px 20px 0 0', padding: '16px 20px 48px', zIndex: 101 }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#222' }} />
        </div>
        <div style={{ fontSize: 11, color: '#555', letterSpacing: '2px', marginBottom: 14 }}>AÑADIR SÍMBOLO</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, background: '#111', border: '0.5px solid #1e1e1e', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={13} color="#333" />
            <input
              autoFocus value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && commit()}
              placeholder="AAPL, META..."
              style={{ background: 'none', border: 'none', outline: 'none', fontSize: 14, color: '#ccc', fontFamily: 'Inter, sans-serif', width: '100%' }}
            />
          </div>
          <button onClick={commit}
            style={{ background: '#f0f0f0', border: 'none', borderRadius: 12, padding: '0 18px', fontSize: 13, color: '#000', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
            Añadir
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MarketsScreen() {
  const [indices,          setIndices]          = useState<Quote[]>([])
  const [watchlist,        setWatchlist]        = useState<Quote[]>([])
  const [news,             setNews]             = useState<NewsItem[]>([])
  const [symbols,          setSymbols]          = useState<string[]>(() => {
    try { const s = localStorage.getItem(WATCHLIST_KEY); return s ? JSON.parse(s) : DEFAULT_WATCHLIST } catch { return DEFAULT_WATCHLIST }
  })
  const [loadingIndices,   setLoadingIndices]   = useState(true)
  const [loadingWatchlist, setLoadingWatchlist] = useState(true)
  const [loadingNews,      setLoadingNews]      = useState(false)
  const [newsRefreshing,   setNewsRefreshing]   = useState(false)
  const [newsLastFetched,  setNewsLastFetched]  = useState<Date | null>(null)
  const [showAdd,          setShowAdd]          = useState(false)
  const [refreshing,       setRefreshing]       = useState(false)
  const [deepResearch,        setDeepResearch]        = useState<string | null>(null)
  const [deepResearchLoading, setDeepResearchLoading] = useState(false)
  const [deepResearchFetched, setDeepResearchFetched] = useState<Date | null>(null)
  const [researchVisible, setResearchVisible] = useState(false)

  const newsFetched = useRef(false)
  const newsLoading = useRef(false)
  const symbolsRef  = useRef(symbols)
  useEffect(() => { symbolsRef.current = symbols }, [symbols])

  // ── Loaders ──────────────────────────────────────────────────────────────

  const loadIndices = useCallback(async () => {
    setLoadingIndices(true)
    try {
      const quotes = USE_MOCK
        ? INDICES.map(i => mockQuote(i.symbol, i.displayName))
        : await Promise.all(INDICES.map(({ symbol, displayName }) =>
            loadQuote(symbol, displayName).catch(() => mockQuote(symbol, displayName))
          ))
      setIndices(quotes)
    } finally {
      setLoadingIndices(false)
    }
  }, [])

  const loadWatchlist = useCallback(async (syms: string[]) => {
    setLoadingWatchlist(true)
    try {
      const quotes = USE_MOCK
        ? syms.map(s => mockQuote(s))
        : await Promise.all(syms.map(s => loadQuote(s).catch(() => mockQuote(s))))
      setWatchlist(quotes)
    } finally {
      setLoadingWatchlist(false)
    }
  }, [])

  const loadNews = useCallback(async () => {
    if (newsLoading.current || newsFetched.current) return
    newsLoading.current = true
    setLoadingNews(true)
    try {
      const row = await readNewsCache()
      if (row && Date.now() - new Date(row.fetched_at).getTime() < NEWS_TTL_MS) {
        setNews(row.articles)
        setNewsLastFetched(new Date(row.fetched_at))
      }
      newsFetched.current = true
    } catch {
      newsFetched.current = true
    } finally {
      newsLoading.current = false
      setLoadingNews(false)
    }
  }, [])

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols)) }, [symbols])
  useEffect(() => { loadIndices() },        [loadIndices])
  useEffect(() => { loadWatchlist(symbols) }, [symbols, loadWatchlist])
  useEffect(() => { loadNews() },           [loadNews])
  useEffect(() => {
    try {
      const cached = localStorage.getItem(DEEP_RESEARCH_KEY)
      if (cached) {
        const { ts, text } = JSON.parse(cached) as { ts: number; text: string }
        if (Date.now() - ts < DEEP_RESEARCH_TTL) {
          setDeepResearch(text)
          setDeepResearchFetched(new Date(ts))
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 30-second price auto-refresh
  useEffect(() => {
    if (USE_MOCK) return
    const id = setInterval(() => {
      loadIndices()
      loadWatchlist(symbolsRef.current)
    }, 30000)
    return () => clearInterval(id)
  }, [loadIndices, loadWatchlist])

  // ── Actions ──────────────────────────────────────────────────────────────

  const refresh = async () => {
    setRefreshing(true)
    newsFetched.current = false
    await Promise.all([loadIndices(), loadWatchlist(symbols), loadNews()])
    setRefreshing(false)
  }

  const addSymbol    = (sym: string) => setSymbols(prev => [...prev, sym])
  const removeSymbol = (sym: string) => {
    setSymbols(prev  => prev.filter(s => s !== sym))
    setWatchlist(prev => prev.filter(q => q.symbol !== sym))
  }


  const runDeepResearch = async () => {
    if (deepResearchLoading || !ANTHROPIC_KEY) return
    setDeepResearchLoading(true)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key':    ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model:      'claude-opus-4-8',
          max_tokens: 600,
          messages:   [{
            role:    'user',
            content: 'Haz una investigación exhaustiva y profunda sobre el estado actual de los mercados financieros. Busca información real y actual sobre:\n\n1. MACRO: Situación macroeconómica global, decisiones de la Fed, inflación, tipos de interés\n2. SECTORES: Qué sectores están liderando y cuáles cayendo esta semana y por qué\n3. MIS ACCIONES: Busca noticias específicas y relevantes de TSLA, GOOGL, RKLB y NVDA - resultados, productos nuevos, competencia\n4. OPORTUNIDADES: Qué movimientos importantes están ocurriendo que un inversor debería conocer\n5. RIESGOS: Principales amenazas al mercado en el corto/medio plazo\n\nResponde en español, de forma directa y densa, sin introducciones. Máximo 300 palabras pero que cada palabra aporte valor. Sin bullet points, en prosa fluida por secciones.',
          }],
        }),
      })
      const d    = await res.json()
      const raw      = d.content?.[0]?.text ?? ''
      const text     = raw.split('\n').filter((l: string) => !l.match(/^#\s/)).join('\n').trimStart()
      if (text) {
        setDeepResearch(text)
        setResearchVisible(true)
        const now = Date.now()
        setDeepResearchFetched(new Date(now))
        try { localStorage.setItem(DEEP_RESEARCH_KEY, JSON.stringify({ ts: now, text })) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    finally { setDeepResearchLoading(false) }
  }

  const refreshNews = async () => {
    if (newsRefreshing || !ANTHROPIC_KEY) return
    setNewsRefreshing(true)
    try {
      const items = await fetchNewsViaAtlas()
      if (items.length > 0) {
        await writeNewsCache(items)
        setNews(items)
        setNewsLastFetched(new Date())
      }
    } catch { /* ignore */ } finally {
      setNewsRefreshing(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const isOpen = (() => {
    const madrid = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }))
    const day    = madrid.getDay()
    const mins   = madrid.getHours() * 60 + madrid.getMinutes()
    return day >= 1 && day <= 5 && mins >= 15 * 60 + 30 && mins < 22 * 60
  })()

  return (
    <div style={{ position: 'relative', overflow: 'hidden', minHeight: '100vh', height: '100%' }}>

      {/* ── Depth orbs + ambient particles ── */}
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
        <AmbientParticles />
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ position: 'relative', zIndex: 1, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

      {/* ── Header ── */}
      <div style={{ padding: '20px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <motion.div
            animate={isOpen ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
            transition={{ repeat: Infinity, duration: 2.2, ease: 'easeInOut' }}
            style={{ width: 5, height: 5, borderRadius: '50%', background: isOpen ? '#10B981' : '#EF4444', flexShrink: 0 }}
          />
          <span style={{ fontSize: 10, letterSpacing: '2px', color: isOpen ? '#10B981' : 'rgba(255,255,255,0.3)' }}>
            {isOpen ? 'Mercado abierto' : 'Mercado cerrado'}
          </span>
        </div>
        <motion.button whileTap={{ scale: 0.88 }} onClick={refresh}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}>
          <motion.div
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={{ duration: 0.9, repeat: refreshing ? Infinity : 0, ease: 'linear' }}>
            <RefreshCw size={14} color={refreshing ? '#8B5CF6' : '#333'} />
          </motion.div>
        </motion.button>
      </div>

      {/* ── Indices strip ── */}
      <div style={{ padding: '16px 16px 0', display: 'flex', gap: 8 }}>
        {loadingIndices
          ? INDICES.map((_, i) => (
              <div key={i} style={{ flex: 1, background: '#111', border: '0.5px solid #1e1e1e', borderRadius: 18, padding: '12px 10px' }}>
                <Skeleton h={9} />
                <div style={{ marginTop: 8 }}><Skeleton h={16} /></div>
                <div style={{ marginTop: 7 }}><Skeleton h={9} /></div>
              </div>
            ))
          : indices.map(q => <IndexCard key={q.symbol} quote={q} />)
        }
      </div>

      {/* ── Watchlist section ── */}
      <div style={{ padding: '22px 16px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: '#444', letterSpacing: '2px' }}>MI WATCHLIST</span>
          <motion.button whileTap={{ scale: 0.88 }} onClick={() => setShowAdd(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px', display: 'flex', alignItems: 'center' }}>
            <Plus size={14} color="#444" />
          </motion.button>
        </div>
        {loadingWatchlist
          ? Array.from({ length: symbols.length || 4 }).map((_, i) => (
              <div key={i} style={{ padding: '12px 14px', background: '#0f0f0f', border: '0.5px solid #161616', borderRadius: 16, marginBottom: 7 }}>
                <Skeleton h={13} />
                <div style={{ marginTop: 7 }}><Skeleton h={10} /></div>
              </div>
            ))
          : watchlist.map(q => (
              <WatchlistRow key={q.symbol} quote={q} onRemove={() => removeSymbol(q.symbol)} />
            ))
        }
      </div>

      {/* ── Deep Research ── */}
      <div style={{ padding: '16px 16px 0' }}>

        {/* State: loading */}
        {deepResearchLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0' }}>
            <div style={{ position: 'relative', width: 72, height: 72 }}>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)' }}
              />
              <div style={{ position: 'absolute', inset: 2, borderRadius: '50%', background: '#0a0a10', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <TrendingUp size={28} color="#fff" />
              </div>
            </div>
            <motion.div
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}
              style={{ marginTop: 12, fontSize: 15, color: '#fff', fontWeight: 600 }}
            >
              Investigando mercados...
            </motion.div>
          </div>
        )}

        {/* State: button (no result or hidden) */}
        {!deepResearchLoading && (!deepResearch || !researchVisible) && (
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={() => deepResearch ? setResearchVisible(true) : runDeepResearch()}
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0' }}
          >
            <div style={{ position: 'relative', width: 72, height: 72 }}>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
                style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)' }}
              />
              <div style={{ position: 'absolute', inset: 2, borderRadius: '50%', background: '#0a0a10', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <TrendingUp size={28} color="#fff" />
              </div>
            </div>
          </motion.button>
        )}

        {/* State: result visible */}
        {!deepResearchLoading && deepResearch && researchVisible && (
          <div>
            {/* Compact header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }}>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
                  style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'conic-gradient(#8B5CF6, #06B6D4, #EC4899, #8B5CF6)' }}
                />
                <div style={{ position: 'absolute', inset: 2, borderRadius: '50%', background: '#0a0a10', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                  <TrendingUp size={16} color="#fff" />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 14, color: '#fff', fontWeight: 600 }}>Investigación Profunda</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Markets · Stocks</div>
              </div>
            </div>

            <DeepResearchPanel text={deepResearch} fetchedAt={deepResearchFetched} />

            {/* Footer actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'center' }}>
              <button
                onClick={() => setResearchVisible(false)}
                style={{ background: 'transparent', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}
              >
                Ocultar
              </button>
              <button
                onClick={runDeepResearch}
                style={{ background: 'transparent', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}
              >
                Nueva búsqueda
              </button>
            </div>
          </div>
        )}

      </div>

      {/* ── News section ── */}
      <div style={{ padding: '22px 16px 90px' }}>
        <div style={{
          position: 'relative',
          background: 'rgba(255,255,255,0.03)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: 16,
          boxShadow: '0 0 0 0.5px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          {/* Neon top border */}
          <div style={{ position: 'absolute', top: 0, left: '15%', right: '15%', height: 1, borderRadius: 1, background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), rgba(6,182,212,0.3), transparent)', pointerEvents: 'none' }} />

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 15, color: '#ccc', fontWeight: 300 }}>Noticias</span>
              {newsLastFetched && (
                <span style={{ fontSize: 11, color: '#333' }}>{timeAgo(newsLastFetched)}</span>
              )}
            </div>
            <motion.button
              whileTap={{ scale: 0.85 }}
              onClick={refreshNews}
              disabled={newsRefreshing}
              style={{ background: 'none', border: 'none', cursor: newsRefreshing ? 'default' : 'pointer', padding: 4, display: 'flex' }}
            >
              <motion.div
                animate={newsRefreshing ? { rotate: 360 } : { rotate: 0 }}
                transition={{ duration: 0.9, repeat: newsRefreshing ? Infinity : 0, ease: 'linear' }}
              >
                <RefreshCw size={14} color={newsRefreshing ? '#8B5CF6' : '#333'} />
              </motion.div>
            </motion.button>
          </div>

          {/* Loading skeleton */}
          {loadingNews && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <Skeleton h={18} radius={10} />
                <div style={{ marginTop: 10 }}><Skeleton h={54} radius={6} /></div>
                <div style={{ marginTop: 8 }}><Skeleton h={10} radius={6} /></div>
              </div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i}>
                  <Skeleton h={18} radius={10} />
                  <div style={{ marginTop: 8 }}><Skeleton h={32} radius={6} /></div>
                </div>
              ))}
            </div>
          )}

          {/* Featured + list */}
          {!loadingNews && news.length > 0 && (
            <>
              <FeaturedNewsCard item={news[0]} />
              {news.slice(1).map((item, i) => (
                <CompactNewsRow key={item.id} item={item} isLast={i === news.length - 2} />
              ))}
            </>
          )}

          {/* Empty state */}
          {!loadingNews && news.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', color: '#2a2a2a', fontSize: 12, letterSpacing: '0.5px' }}>
              Pulsa ↻ para cargar noticias
            </div>
          )}
        </div>
      </div>

      </div>{/* end scrollable content */}

      {/* Add symbol sheet — outside scroll so it overlays everything */}
      <AnimatePresence>
        {showAdd && <AddSymbolSheet existing={symbols} onAdd={addSymbol} onClose={() => setShowAdd(false)} />}
      </AnimatePresence>

    </div>
  )
}
