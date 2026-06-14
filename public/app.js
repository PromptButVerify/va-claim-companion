// VA Claim Companion — Main App
// Uses VA Lighthouse API (sandbox) + Claude AI

// ─── Config ─────────────────────────────────────────────────────────────────
const CFG = {
  // OAuth — VA Lighthouse sandbox
  // Claims API
  AUTH_CLAIMS:    'https://sandbox-api.va.gov/oauth2/claims/v1/authorization',
  CLIENT_CLAIMS:  '0oa1bscwxlbnLr2Tk2p8',
  SCOPE_CLAIMS:   'claim.read',

  // Appeals API
  AUTH_APPEALS:   'https://sandbox-api.va.gov/oauth2/appeals/v1/authorization',
  CLIENT_APPEALS: '0oa1bsd19oocoLYY32p8',
  SCOPE_APPEALS:  'appeals.read',

  // Shared
  REDIRECT_URI:   window.location.origin + '/callback',

  // Backend (Pages Functions on same origin)
  TOKEN_ENDPOINT: '/api/token',
  CLAIMS_ENDPOINT: '/api/claims',
  APPEALS_ENDPOINT: '/api/appeals',
  INTERPRET_ENDPOINT: '/api/interpret',
};

// ─── VA claim phases ─────────────────────────────────────────────────────────
const PHASES = [
  'Claim received',
  'Initial review',
  'Evidence gathering',
  'Evidence review',
  'Rating',
  'Preparing decision letter',
  'Complete',
];

// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  tab: 'claims',           // claims | appeals | settings
  claims: null,            // [] | null
  appeals: null,           // [] | null
  error: null,
  loading: false,
  interpretations: {},     // { [claimId]: string }
  interpretLoading: {},    // { [claimId]: boolean }
  lastUpdated: null,
  tokenClaims: null,       // access token for Claims API
  tokenAppeals: null,      // access token for Appeals API
};

// ─── PKCE Utilities ──────────────────────────────────────────────────────────
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return b64url(arr.buffer);
}

async function generateChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(hash);
}

function generateState() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return b64url(arr.buffer);
}

// ─── Token storage ───────────────────────────────────────────────────────────
// localStorage (not sessionStorage) — survives iOS in-app browser OAuth redirects
function saveToken(api, token, expiresIn) {
  localStorage.setItem(`va_token_${api}`, token);
  localStorage.setItem(`va_token_${api}_exp`, Date.now() + (expiresIn - 60) * 1000);
}

function loadToken(api) {
  const token = localStorage.getItem(`va_token_${api}`);
  const exp = parseInt(localStorage.getItem(`va_token_${api}_exp`) || '0');
  if (!token || Date.now() > exp) return null;
  return token;
}

function clearTokens() {
  ['claims', 'appeals'].forEach(api => {
    localStorage.removeItem(`va_token_${api}`);
    localStorage.removeItem(`va_token_${api}_exp`);
  });
  localStorage.removeItem('pkce_verifier_claims');
  localStorage.removeItem('pkce_state_claims');
  localStorage.removeItem('pkce_verifier_appeals');
  localStorage.removeItem('pkce_state_appeals');
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────
async function startAuth(api) {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = generateState();

  localStorage.setItem(`pkce_verifier_${api}`, verifier);
  localStorage.setItem(`pkce_state_${api}`, state);

  const authBase = api === 'claims' ? CFG.AUTH_CLAIMS : CFG.AUTH_APPEALS;
  const clientId = api === 'claims' ? CFG.CLIENT_CLAIMS : CFG.CLIENT_APPEALS;
  const scope = api === 'claims' ? CFG.SCOPE_CLAIMS : CFG.SCOPE_APPEALS;

  const url = new URL(authBase);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', CFG.REDIRECT_URI);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.href = url.toString();
}

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const error = params.get('error');

  if (error) {
    S.error = params.get('error_description') || error;
    window.history.replaceState({}, '', '/');
    return render();
  }

  if (!code) return;

  // Determine which API this callback is for (check saved states)
  let api = null;
  for (const a of ['claims', 'appeals']) {
    if (localStorage.getItem(`pkce_state_${a}`) === returnedState) {
      api = a;
      break;
    }
  }

  if (!api) {
    S.error = 'OAuth state mismatch. Please try signing in again.';
    window.history.replaceState({}, '', '/');
    return render();
  }

  const verifier = localStorage.getItem(`pkce_verifier_${api}`);
  localStorage.removeItem(`pkce_verifier_${api}`);
  localStorage.removeItem(`pkce_state_${api}`);

  // Clean URL immediately
  window.history.replaceState({}, '', '/');

  // Exchange code for token via Pages Function
  try {
    const resp = await fetch(CFG.TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, api }),
    });

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error_description || e.error || 'Token exchange failed');
    }

    const data = await resp.json();
    saveToken(api, data.access_token, data.expires_in || 3600);

    if (api === 'claims') {
      S.tokenClaims = data.access_token;

      // Auto-chain to Appeals if not yet authorized.
      // VA Claims and VA Appeals share the same Okta IdP, so the veteran
      // won't be prompted for credentials again — just a brief redirect.
      if (!loadToken('appeals')) {
        document.getElementById('app').innerHTML = `
          <div class="screen-loading">
            <div class="brand-mark"></div>
            <div class="brand-name">VA Claim Companion</div>
            <div class="spinner"></div>
            <div style="font-size:var(--font-size-body-sm);color:var(--color-base-dark);text-align:center;margin-top:8px">
              Step 2 of 2 &mdash; Connecting Appeals&hellip;
            </div>
          </div>`;
        await new Promise(r => setTimeout(r, 700));
        await startAuth('appeals');
        return;
      }
    } else {
      S.tokenAppeals = data.access_token;
    }

    // Both tokens in hand — fetch everything
    await fetchData();
  } catch (err) {
    console.error('[handleCallback] error:', err.message, err);
    S.error = err.message || 'Sign-in failed. Please try again.';
    render();
  }
}

// ─── API calls ────────────────────────────────────────────────────────────────
async function fetchData() {
  S.loading = true;
  render();

  const token = S.tokenClaims || loadToken('claims');
  if (!token) {
    S.loading = false;
    return render();
  }

  try {
    const [claimsResp, appealsResp] = await Promise.allSettled([
      fetch(CFG.CLAIMS_ENDPOINT, {
        headers: { 'Authorization': `Bearer ${token}` },
      }),
      (() => {
        const aToken = S.tokenAppeals || loadToken('appeals');
        if (!aToken) return Promise.resolve(null);
        return fetch(CFG.APPEALS_ENDPOINT, {
          headers: { 'Authorization': `Bearer ${aToken}` },
        });
      })(),
    ]);

    if (claimsResp.status === 'fulfilled' && claimsResp.value) {
      if (claimsResp.value.status === 401) {
        clearTokens();
        S.tokenClaims = null;
        S.error = 'Session expired. Please sign in again.';
        S.loading = false;
        return render();
      }
      if (claimsResp.value.ok) {
        const d = await claimsResp.value.json();
        S.claims = d.data || d.claims || d || [];
      }
    }

    if (appealsResp.status === 'fulfilled' && appealsResp.value?.ok) {
      const d = await appealsResp.value.json();
      S.appeals = d.data || d.appeals || d || [];
    }

    S.lastUpdated = new Date();
    S.error = null;
    S.loading = false;
    render();

    // Kick off interpretations for all claims (non-blocking)
    if (S.claims?.length) {
      S.claims.forEach(c => interpretClaim(c));
    }
  } catch (err) {
    S.error = err.message;
    S.loading = false;
    render();
  }
}

async function interpretClaim(claim) {
  const id = claim.id;
  if (S.interpretations[id] || S.interpretLoading[id]) return;

  S.interpretLoading[id] = true;
  renderInterpret(id);

  try {
    const resp = await fetch(CFG.INTERPRET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimType: claim.attributes?.claimType || 'VA Claim',
        status: claim.attributes?.status || '',
        phase: claim.attributes?.phase || '',
        contentions: claim.attributes?.contentionList || [],
        closeDate: claim.attributes?.closeDate,
      }),
    });

    if (resp.ok) {
      const d = await resp.json();
      S.interpretations[id] = d.interpretation;
    }
  } catch (_) {
    // Silent fail — interpretation is a nice-to-have
  } finally {
    S.interpretLoading[id] = false;
    renderInterpret(id);
  }
}

// ─── Status mapping ───────────────────────────────────────────────────────────
function getStatusClass(status) {
  if (!status) return 'pending';
  const s = status.toLowerCase();
  if (s.includes('complete') || s.includes('closed')) return 'granted';
  if (s.includes('denied') || s.includes('disallowed')) return 'denied';
  if (s.includes('decision') || s.includes('preparation')) return 'decision';
  if (s.includes('initial') || s.includes('evidence') || s.includes('review') || s.includes('rating')) return 'progress';
  return 'pending';
}

function getStatusLabel(status) {
  if (!status) return 'Pending';
  const s = status.toLowerCase();
  if (s.includes('complete')) return 'Complete';
  if (s.includes('closed')) return 'Closed';
  if (s.includes('denied')) return 'Denied';
  if (s.includes('disallowed')) return 'Not Granted';
  if (s.includes('decision')) return 'Decision';
  if (s.includes('rating')) return 'Rating';
  if (s.includes('initial')) return 'In Review';
  if (s.includes('evidence')) return 'Evidence';
  return status;
}

function getPhaseIndex(phase) {
  if (!phase) return -1;
  const p = (phase + '').toLowerCase();
  if (p.includes('received') || p === '1') return 0;
  if (p.includes('initial') || p === '2') return 1;
  if (p.includes('gathering') || p === '3') return 2;
  if (p.includes('review') || p === '4') return 3;
  if (p.includes('rating') || p === '5') return 4;
  if (p.includes('letter') || p.includes('preparing') || p === '6') return 5;
  if (p.includes('complete') || p === '7') return 6;
  const n = parseInt(p);
  if (!isNaN(n)) return Math.min(n - 1, 6);
  return -1;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(dt) {
  if (!dt) return '';
  const diff = Math.floor((Date.now() - dt) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────
const ICONS = {
  claims: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9 12h6M9 16h6M9 8h3M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>`,
  appeals: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18M3 12h18M3 18h9"/><path d="M16 16l2 2 4-4"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

// ─── Render helpers ───────────────────────────────────────────────────────────
function pill(status) {
  const cls = getStatusClass(status);
  const label = getStatusLabel(status);
  return `<span class="pill ${cls}"><span class="pill-dot"></span>${label}</span>`;
}

function phaseBar(phase) {
  const idx = getPhaseIndex(phase);
  if (idx < 0) return '';
  const segs = PHASES.map((name, i) => {
    let cls = '';
    if (i < idx) cls = 'done';
    else if (i === idx) cls = 'active';
    return `<div class="phase-seg ${cls}"></div>`;
  }).join('');
  return `
    <div class="phase-wrap">
      <div class="phase-label">Progress</div>
      <div class="phase-track">${segs}</div>
      <div class="phase-name">${PHASES[idx] || ''}</div>
    </div>`;
}

function claimCard(claim) {
  const a = claim.attributes || {};
  const id = claim.id;
  const type = a.claimType || a.type || 'Compensation Claim';
  const status = a.status || a.claimStatus || '';
  const phase = a.phase || a.phaseChangeDate;
  const contentions = a.contentionList || [];
  const submittedOn = a.claimDate || a.dateFiled || a.submittedOn;
  const decisionDate = a.closeDate || a.decisionDate;

  const interp = S.interpretations[id];
  const interpLoading = S.interpretLoading[id];
  let interpretHtml = '';
  if (interp) {
    interpretHtml = `<div class="interpret">
      <div class="interpret-label">What this means</div>
      <div class="interpret-text">${escHtml(interp)}</div>
    </div>`;
  } else if (interpLoading) {
    interpretHtml = `<div class="interpret">
      <div class="interpret-label">What this means</div>
      <div class="interpret-loading"><div class="spinner" style="width:13px;height:13px;border-width:1.5px"></div>Interpreting with AI...</div>
    </div>`;
  }

  const tagHtml = contentions.length
    ? `<div class="tags">${contentions.slice(0,5).map(c => `<span class="tag">${escHtml(c)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="card" data-claim-id="${escHtml(id)}">
      <div class="card-top">
        <div class="card-row">
          <div class="claim-type">${escHtml(type)}</div>
          ${pill(status)}
        </div>
        <div class="claim-id">Claim #${escHtml(id)}${submittedOn ? ` &middot; Filed ${fmtDate(submittedOn)}` : ''}${decisionDate ? ` &middot; Decision ${fmtDate(decisionDate)}` : ''}</div>
      </div>
      ${phaseBar(a.phase)}
      ${tagHtml}
      ${interpretHtml}
    </div>`;
}

function appealCard(appeal) {
  const a = appeal.attributes || {};
  const id = appeal.id;
  const type = a.appealType || appeal.type || 'Appeal';
  const status = a.status?.type || a.status || '';
  const desc = a.status?.details?.[0]?.description || a.description || '';

  return `
    <div class="card" data-appeal-id="${escHtml(id)}">
      <div class="card-top">
        <div class="card-row">
          <div class="claim-type">${escHtml(type)}</div>
          ${pill(status)}
        </div>
        <div class="claim-id">Appeal #${escHtml(id)}</div>
        ${desc ? `<div style="font-size:var(--font-size-body-sm);color:var(--color-base-dark);margin-top:6px;line-height:1.5">${escHtml(desc)}</div>` : ''}
      </div>
    </div>`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Render interpret in-place ────────────────────────────────────────────
function renderInterpret(id) {
  const card = document.querySelector(`[data-claim-id="${id}"]`);
  if (!card) return;

  const existingInterp = card.querySelector('.interpret');
  const tags = card.querySelector('.tags');
  const interp = S.interpretations[id];
  const loading = S.interpretLoading[id];

  let html = '';
  if (interp) {
    html = `<div class="interpret">
      <div class="interpret-label">What this means</div>
      <div class="interpret-text">${escHtml(interp)}</div>
    </div>`;
  } else if (loading) {
    html = `<div class="interpret">
      <div class="interpret-label">What this means</div>
      <div class="interpret-loading"><div class="spinner" style="width:13px;height:13px;border-width:1.5px"></div>Interpreting with AI...</div>
    </div>`;
  }

  if (existingInterp) {
    if (html) existingInterp.outerHTML = html;
    else existingInterp.remove();
  } else if (html) {
    const insertAfter = tags || card.querySelector('.phase-wrap') || card.querySelector('.card-top');
    if (insertAfter) insertAfter.insertAdjacentHTML('afterend', html);
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  const token = S.tokenClaims || loadToken('claims');

  if (!token) {
    app.innerHTML = renderLogin();
    attachLoginHandlers();
    return;
  }

  app.innerHTML = renderDashboard();
  attachDashboardHandlers();
}

function renderLogin() {
  const errorHtml = S.error
    ? `<div class="error-card" style="margin:16px 0;text-align:left"><div class="error-title">Sign-in error</div><div class="error-msg">${escHtml(S.error)}</div></div>`
    : '';
  return `
    <div class="screen-login">
      <div class="gov-banner">
        <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true" focusable="false" style="flex-shrink:0">
          <rect width="16" height="11" fill="#fff"/>
          <rect y="1.57" width="16" height="1.57" fill="#b22234"/>
          <rect y="4.71" width="16" height="1.57" fill="#b22234"/>
          <rect y="7.86" width="16" height="1.57" fill="#b22234"/>
          <rect width="7" height="6" fill="#3c3b6e"/>
        </svg>
        An official website of the United States government
      </div>
      <div class="login-header">
        <div class="va-wordmark">
          <span class="va-wordmark-letters">VA</span>
          <span class="va-wordmark-dept">U.S. Department<br>of Veterans Affairs</span>
        </div>
      </div>
      <div class="login-content">
        <h1 class="login-title">VA Claim Companion</h1>
        <p class="login-sub">Track your VA benefits claims and appeals in real time &mdash; built for mobile.</p>
        ${errorHtml}
        <button class="btn btn-primary" id="btn-login-claims">Sign in with VA.gov</button>
        <p class="login-note">Uses your existing VA.gov login (ID.me or Login.gov). We never store your VA credentials.</p>
        <div class="sandbox-banner">Sandbox mode &mdash; use VA test accounts</div>
      </div>
    </div>`;
}

function attachLoginHandlers() {
  document.getElementById('btn-login-claims')?.addEventListener('click', () => startAuth('claims'));
}

function renderDashboard() {
  const header = `
    <div class="header">
      <div class="header-inner">
        <div class="va-wordmark">
          <span class="va-wordmark-letters">VA</span>
          <span class="va-wordmark-dept">U.S. Department<br>of Veterans Affairs</span>
        </div>
        <div style="display:flex;align-items:center;gap:var(--sp-1)">
          <span class="header-badge">Sandbox</span>
          <button class="icon-btn" id="btn-refresh" title="Refresh">${ICONS.refresh}</button>
        </div>
      </div>
    </div>`;

  const nav = `
    <nav class="nav">
      <button class="nav-item ${S.tab === 'claims' ? 'active' : ''}" data-tab="claims">
        ${ICONS.claims}Claims
      </button>
      <button class="nav-item ${S.tab === 'appeals' ? 'active' : ''}" data-tab="appeals">
        ${ICONS.appeals}Appeals
      </button>
      <button class="nav-item ${S.tab === 'settings' ? 'active' : ''}" data-tab="settings">
        ${ICONS.settings}Settings
      </button>
    </nav>`;

  let content = '';
  if (S.loading && !S.claims) {
    content = renderSkeleton();
  } else if (S.error) {
    content = `<div class="error-card">
      <div class="error-title">Error</div>
      <div class="error-msg">${escHtml(S.error)}</div>
    </div>` + renderTabContent();
  } else {
    content = renderTabContent();
  }

  return header + `<div class="content">${content}</div>` + nav;
}

function renderTabContent() {
  if (S.tab === 'claims') return renderClaims();
  if (S.tab === 'appeals') return renderAppeals();
  if (S.tab === 'settings') return renderSettings();
  return '';
}

function renderClaims() {
  const claims = S.claims;

  if (!claims) {
    return `<div class="empty">
      <div class="empty-icon">${ICONS.shield}</div>
      <div class="empty-title">No claims loaded</div>
      <div class="empty-sub">Tap refresh to fetch your claims from VA.gov</div>
    </div>`;
  }

  if (!claims.length) {
    return `<div class="empty">
      <div class="empty-icon">${ICONS.doc}</div>
      <div class="empty-title">No claims on file</div>
      <div class="empty-sub">You don't have any active claims with the VA</div>
    </div>`;
  }

  const cards = claims.map(claimCard).join('');
  const lastUpd = S.lastUpdated ? `<div class="last-upd">Updated ${timeAgo(S.lastUpdated)}</div>` : '';

  return `
    <div class="section-hd">
      <div class="section-title">Active Claims</div>
      <div class="section-count">${claims.length}</div>
    </div>
    ${cards}
    ${lastUpd}
    <div class="refresh-wrap">
      <button class="refresh-btn" id="btn-refresh-inline">${ICONS.refresh} Refresh</button>
    </div>`;
}

function renderAppeals() {
  const appeals = S.appeals;

  if (!appeals) {
    // Shouldn't normally show — auto-chain handles Appeals auth on first login.
    // Shown as fallback if appeals token expired independently.
    return `<div class="empty">
      <div class="empty-icon">${ICONS.appeals}</div>
      <div class="empty-title">Appeals not connected</div>
      <div class="empty-sub">Your Appeals session has expired. Reconnect to view your appeal status.</div>
      <button class="btn btn-ghost" id="btn-connect-appeals" style="margin-top:var(--sp-2);max-width:240px">Connect Appeals</button>
    </div>`;
  }

  if (!appeals.length) {
    return `<div class="empty">
      <div class="empty-icon">${ICONS.appeals}</div>
      <div class="empty-title">No appeals on file</div>
      <div class="empty-sub">You don't have any active appeals with the Board</div>
    </div>`;
  }

  return `
    <div class="section-hd">
      <div class="section-title">Active Appeals</div>
      <div class="section-count">${appeals.length}</div>
    </div>
    ${appeals.map(appealCard).join('')}`;
}

function renderSettings() {
  const token = S.tokenClaims || loadToken('claims');
  const tokenAppeals = S.tokenAppeals || loadToken('appeals');

  return `
    <div class="settings-section">
      <div class="section-hd"><div class="section-title">Account</div></div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-label">Claims API</div>
          <div class="settings-row-val">${token ? 'Connected' : 'Not connected'}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Appeals API</div>
          <div class="settings-row-val">${tokenAppeals ? 'Connected' : 'Not connected'}</div>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="section-hd"><div class="section-title">Environment</div></div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-label">Mode</div>
          <div class="settings-row-val">Sandbox</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Claims Client ID</div>
          <div class="settings-row-val" style="font-family:monospace;font-size:11px">0oa1bsc…</div>
        </div>
      </div>
      <div class="settings-sub">Sandbox data is for testing only and does not reflect real VA records.</div>
    </div>
    <div class="settings-section settings-danger">
      <div class="settings-group">
        <div class="settings-row" id="btn-signout">
          <div class="settings-row-label">Sign out</div>
        </div>
      </div>
    </div>`;
}

function renderSkeleton() {
  return Array.from({ length: 3 }, () => `
    <div class="skel-card">
      <div class="skel-line skeleton" style="width:40%;margin-bottom:10px"></div>
      <div class="skel-line skeleton" style="width:70%"></div>
      <div class="skel-line skeleton" style="width:55%;margin-top:10px"></div>
    </div>`).join('');
}

// ─── Event handlers ──────────────────────────────────────────────────────────
function attachDashboardHandlers() {
  // Tab switching
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.tab = btn.dataset.tab;
      render();
    });
  });

  // Refresh
  const doRefresh = () => fetchData();
  document.getElementById('btn-refresh')?.addEventListener('click', doRefresh);
  document.getElementById('btn-refresh-inline')?.addEventListener('click', doRefresh);

  // Connect Appeals
  document.getElementById('btn-connect-appeals')?.addEventListener('click', () => startAuth('appeals'));

  // Sign out
  document.getElementById('btn-signout')?.addEventListener('click', () => {
    clearTokens();
    S.tokenClaims = null;
    S.tokenAppeals = null;
    S.claims = null;
    S.appeals = null;
    S.interpretations = {};
    S.error = null;
    render();
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Check for OAuth callback
  const params = new URLSearchParams(window.location.search);
  if (params.has('code')) {
    await handleCallback();
    return;
  }

  // Check for OAuth error
  if (params.has('error')) {
    S.error = params.get('error_description') || params.get('error');
    window.history.replaceState({}, '', '/');
  }

  // Load token from session
  S.tokenClaims = loadToken('claims');
  S.tokenAppeals = loadToken('appeals');

  if (S.tokenClaims) {
    // Fetch data
    await fetchData();
  } else {
    render();
  }
}

init();
