import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('[transcribe] file.name:', file.name, 'size:', file.size, 'type:', file.type)

    const openaiFormData = new FormData()
    // Pass the filename so Whisper can infer the format from the extension
    openaiFormData.append('file', file, file.name || 'recording.mp4')
    openaiFormData.append('model', 'whisper-1')
    openaiFormData.append('language', 'es')

    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('OPENAI_KEY')}`,
        },
        body: openaiFormData,
      }
    )

    const data = await response.json()
    console.log('[transcribe] Whisper status:', response.status, 'data:', JSON.stringify(data))

    if (!response.ok || data.error) {
      const msg = data.error?.message ?? data.error ?? 'Whisper error'
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ text: data.text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[transcribe] Error:', error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
