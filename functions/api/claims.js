// GET /api/claims — Proxy to VA Benefits Claims API
// Requires Authorization: Bearer <access_token> from client

const VA_CLAIMS_BASE = 'https://sandbox-api.va.gov/services/claims/v1';

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
  const url = new URL(request.url);

  // Optional: specific claim ID
  const claimId = url.searchParams.get('id');
  const endpoint = claimId
    ? `${VA_CLAIMS_BASE}/claims/${claimId}`
    : `${VA_CLAIMS_BASE}/claims`;

  try {
    const resp = await fetch(endpoint, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    // Forward VA response
    const data = await resp.json();

    if (!resp.ok) {
      return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
    }

    return new Response(JSON.stringify(data), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Claims proxy error:', err);
    return new Response(JSON.stringify({
      error: 'proxy_error',
      message: 'Failed to reach VA claims API',
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
