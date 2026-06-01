import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Wrap a plain string system prompt with cache_control so Anthropic caches it.
// If system is already an array, leave it untouched.
function injectSystemCache(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.system !== 'string') return body
  return {
    ...body,
    system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }],
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_KEY') ?? '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(injectSystemCache(body)),
    })

    const data = await anthropicRes.json()

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
