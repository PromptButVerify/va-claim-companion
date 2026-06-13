// GET /api/appeals — Proxy to VA Appeals Status API
// Requires Authorization: Bearer <access_token> from client

const VA_APPEALS_URL = 'https://sandbox-api.va.gov/services/appeals/v1/appeals';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { request } = context;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing authorization token' }), {
      status: 401, headers: CORS,
    });
  }

  const token = authHeader.slice(7);

  try {
    const resp = await fetch(VA_APPEALS_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    const data = await resp.json();

    if (!resp.ok) {
      return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
    }

    return new Response(JSON.stringify(data), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Appeals proxy error:', err);
    return new Response(JSON.stringify({
      error: 'proxy_error',
      message: 'Failed to reach VA appeals API',
    }), { status: 502, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}
