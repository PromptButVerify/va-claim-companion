// POST /api/token — Exchange OAuth authorization code for access token
// Handles PKCE token exchange with VA Lighthouse OAuth server

const VA_TOKEN = {
  claims:  'https://sandbox-api.va.gov/oauth2/claims/v1/token',
  appeals: 'https://sandbox-api.va.gov/oauth2/appeals/v1/token',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: cors });
  }

  const { code, code_verifier, api = 'claims' } = body;

  if (!code || !code_verifier) {
    return new Response(JSON.stringify({ error: 'Missing code or code_verifier' }), { status: 400, headers: cors });
  }

  const tokenUrl = VA_TOKEN[api];
  if (!tokenUrl) {
    return new Response(JSON.stringify({ error: 'Unknown api value' }), { status: 400, headers: cors });
  }

  // Get client credentials from environment
  const clientId = api === 'claims'
    ? (env.CLAIMS_CLIENT_ID || '0oa1bscwxlbnLr2Tk2p8')
    : (env.APPEALS_CLIENT_ID || '0oa1bsd19oocoLYY32p8');

  const redirectUri = env.REDIRECT_URI || 'https://va-claim-companion.pages.dev/callback';
  const clientSecret = api === 'claims' ? env.VA_CLIENT_SECRET_CLAIMS : env.VA_CLIENT_SECRET_APPEALS;

  // Build token request
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });

  // Include client_secret if available (VA may require it even with PKCE)
  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('VA token exchange error:', data);
      return new Response(JSON.stringify({
        error: data.error || 'token_exchange_failed',
        error_description: data.error_description || 'Failed to exchange authorization code',
      }), { status: resp.status, headers: cors });
    }

    // Return only what the client needs (never forward refresh_token to client)
    return new Response(JSON.stringify({
      access_token: data.access_token,
      expires_in: data.expires_in || 3600,
      token_type: data.token_type || 'Bearer',
      scope: data.scope,
    }), { status: 200, headers: cors });

  } catch (err) {
    console.error('Token exchange fetch error:', err);
    return new Response(JSON.stringify({
      error: 'network_error',
      error_description: 'Failed to reach VA authentication server',
    }), { status: 502, headers: cors });
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
