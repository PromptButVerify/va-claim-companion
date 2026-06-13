// POST /api/interpret — Claude AI plain-language claim interpretation
// No auth required (claim data is sent in the request body, not fetched)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Graceful degradation — no interpretation without API key
    return new Response(JSON.stringify({
      interpretation: null,
      error: 'AI interpretation not configured',
    }), { status: 200, headers: CORS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS });
  }

  const { claimType, status, phase, contentions = [], closeDate } = body;

  const prompt = `You are helping a veteran understand their VA benefits claim status. Explain it in plain, empathetic language.

Claim type: ${claimType || 'Compensation claim'}
Current status: ${status || 'Unknown'}
Current phase: ${phase || 'Unknown'}
Contentions: ${contentions.length ? contentions.join(', ') : 'Not specified'}
${closeDate ? `Decision date: ${closeDate}` : ''}

Write 2-3 sentences in plain English explaining what this status means and what happens next.
Do not use VA jargon. Be warm and direct. Do not start with "This claim" or "Your claim".
Respond with only the explanation, no preamble or labels.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      console.error('Claude API error:', e);
      return new Response(JSON.stringify({ interpretation: null }), { status: 200, headers: CORS });
    }

    const data = await resp.json();
    const interpretation = data.content?.[0]?.text?.trim() || null;

    return new Response(JSON.stringify({ interpretation }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Interpret error:', err);
    return new Response(JSON.stringify({ interpretation: null }), { status: 200, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
