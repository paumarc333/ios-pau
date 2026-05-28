import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS = { 'Access-Control-Allow-Origin': '*' }

const CATEGORY_MAP: Record<string, string> = {
  sports:     'Fútbol',
  technology: 'IA & Tech',
  general:    'Mundo',
}

interface Article {
  id:          string
  title:       string
  description: string
  source:      string
  publishedAt: string
  category:    string
  url:         string
}

interface NewsAPIResponse {
  articles: Array<{
    title:       string | null
    description: string | null
    source:      { name: string }
    publishedAt: string
    url:         string
  }>
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  const NEWSAPI_KEY = Deno.env.get('NEWSAPI_KEY') ?? ''
  if (!NEWSAPI_KEY) {
    return new Response(JSON.stringify({ error: 'NEWSAPI_KEY not set' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const url        = new URL(req.url)
  const queryParam = url.searchParams.get('query') ?? 'sports,technology,general'
  const categories = queryParam.split(',').map(c => c.trim()).filter(Boolean)

  const fetchCategory = async (category: string): Promise<Article[]> => {
    const apiUrl = `https://newsapi.org/v2/top-headlines?category=${encodeURIComponent(category)}&language=es&pageSize=5`
    const res    = await fetch(apiUrl, { headers: { 'X-Api-Key': NEWSAPI_KEY } })
    if (!res.ok) return []
    const data: NewsAPIResponse = await res.json()
    const label = CATEGORY_MAP[category] ?? category
    return (data.articles ?? [])
      .filter(a => a.title && a.title !== '[Removed]')
      .slice(0, 5)
      .map((a, i) => ({
        id:          `${category}-${i}-${Date.now()}`,
        title:       a.title        ?? '',
        description: a.description  ?? '',
        source:      a.source?.name ?? '',
        publishedAt: a.publishedAt  ?? '',
        category:    label,
        url:         a.url          ?? '#',
      }))
  }

  const buckets = await Promise.all(categories.map(fetchCategory))

  const maxLen   = Math.max(...buckets.map(b => b.length), 0)
  const articles: Article[] = []
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) articles.push(bucket[i])
    }
  }

  return new Response(JSON.stringify({ articles: articles.slice(0, 15) }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
