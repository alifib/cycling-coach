// Cloudflare Worker — Strava proxy + .zwo workout host for cycling-coach
// Holds Strava credentials as secrets. Exchanges refresh_token for a fresh
// access_token on each request, then forwards activity queries to Strava.
//
// Also stores generated .zwo workout files in KV with a 24h TTL so the
// page can share a URL (instead of a File) to Hammerhead Companion via
// the iOS share sheet — file shares from Safari don’t surface Companion,
// but URL shares do.
//

// Secrets needed (set via Cloudflare dashboard → Worker → Settings → Variables):
//   STRAVA_CLIENT_ID
//   STRAVA_CLIENT_SECRET
//   STRAVA_REFRESH_TOKEN
//   ALLOWED_ORIGIN  (your Pages URL, e.g. https://cycling-coach.pages.dev)
//
// KV binding required:
//   ZWO_KV  → namespace “cycling-coach-zwo”

export default {
async fetch(request, env) {
const origin = request.headers.get(‘Origin’) || ‘’;
const allowed = env.ALLOWED_ORIGIN || ‘*’;

```
// CORS preflight
if (request.method === 'OPTIONS') {
  return new Response(null, { headers: corsHeaders(allowed, origin) });
}

const url = new URL(request.url);

try {
  if (url.pathname === '/activities' && request.method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '14', 10);
    const data = await getRecentActivities(env, days);
    return json(data, allowed, origin);
  }

  if (url.pathname === '/athlete' && request.method === 'GET') {
    const data = await stravaFetch(env, '/athlete');
    return json({
      id: data.id,
      firstname: data.firstname,
      weight: data.weight,
      ftp: data.ftp,
    }, allowed, origin);
  }

  // POST /zwo — store workout XML, return a public URL
  if (url.pathname === '/zwo' && request.method === 'POST') {
    return await storeZwo(request, env, allowed, origin);
  }

  // GET /zwo/:id or /zwo/:id/:filename — serve a stored workout.
  // Public, no CORS check (Companion fetches this server-side, not from a browser context).
  if (url.pathname.startsWith('/zwo/') && request.method === 'GET') {
    return await serveZwo(url, env);
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return json({ ok: true, service: 'strava-proxy' }, allowed, origin);
  }

  return json({ error: 'not_found', path: url.pathname }, allowed, origin, 404);
} catch (err) {
  return json({ error: 'proxy_error', message: String(err.message || err) }, allowed, origin, 500);
}
```

},
};

function corsHeaders(allowed, origin) {
const allowOrigin = (allowed === ‘*’ || origin === allowed) ? (origin || allowed) : allowed;
return {
‘Access-Control-Allow-Origin’: allowOrigin,
‘Access-Control-Allow-Methods’: ‘GET, POST, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
‘Access-Control-Max-Age’: ‘86400’,
‘Vary’: ‘Origin’,
};
}

function json(body, allowed, origin, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: {
‘Content-Type’: ‘application/json’,
…corsHeaders(allowed, origin),
},
});
}

// ———– .zwo storage ———–

function randomId(len = 10) {
const bytes = new Uint8Array(len);
crypto.getRandomValues(bytes);
return Array.from(bytes, b => b.toString(36).padStart(2, ‘0’)).join(’’).slice(0, len);
}

async function storeZwo(request, env, allowed, origin) {
if (!env.ZWO_KV) {
return json({ error: ‘kv_not_configured’, message: ‘ZWO_KV binding missing on Worker’ }, allowed, origin, 500);
}
const body = await request.json();
if (!body.xml || typeof body.xml !== ‘string’) {
return json({ error: ‘bad_request’, message: ‘expected { xml, filename? }’ }, allowed, origin, 400);
}
if (body.xml.length > 200000) {
return json({ error: ‘too_large’, message: ‘workout XML > 200KB’ }, allowed, origin, 413);
}
const id = randomId(10);
const filename = (body.filename && /^[\w.-]{1,80}$/.test(body.filename))
? body.filename
: `workout-${id}.zwo`;

await env.ZWO_KV.put(id, body.xml, {
expirationTtl: 60 * 60 * 24,  // 24 hours
metadata: { filename, created: new Date().toISOString() },
});

const workerUrl = new URL(request.url);
const publicUrl = `${workerUrl.origin}/zwo/${id}/${filename}`;
return json({ id, url: publicUrl, filename, expiresIn: 86400 }, allowed, origin);
}

async function serveZwo(url, env) {
if (!env.ZWO_KV) return new Response(‘KV not configured’, { status: 500 });

// Match /zwo/:id or /zwo/:id/:filename
const parts = url.pathname.split(’/’).filter(Boolean);  // [‘zwo’, id, …maybe filename]
if (parts.length < 2) return new Response(‘Not found’, { status: 404 });
const id = parts[1];
if (!/^[\w-]{1,20}$/.test(id)) return new Response(‘Bad id’, { status: 400 });

const { value, metadata } = await env.ZWO_KV.getWithMetadata(id);
if (!value) return new Response(‘Workout not found or expired’, { status: 404 });

const filename = (metadata && metadata.filename) || `workout-${id}.zwo`;
return new Response(value, {
status: 200,
headers: {
// application/octet-stream prevents iOS from appending a content-type-derived
// extension (.xml) when Shortcuts’ “Get Contents of URL” + “Save File” writes
// the response to disk. With application/xml, the saved filename becomes
// “workout.zwo.xml” — which Hammerhead Companion then rejects.
‘Content-Type’: ‘application/octet-stream’,
‘Content-Disposition’: `attachment; filename="${filename}"`,
‘Cache-Control’: ‘public, max-age=3600’,
},
});
}

// ———– Strava helpers ———–

async function getAccessToken(env) {
const res = await fetch(‘https://www.strava.com/api/v3/oauth/token’, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/x-www-form-urlencoded’ },
body: new URLSearchParams({
client_id: env.STRAVA_CLIENT_ID,
client_secret: env.STRAVA_CLIENT_SECRET,
refresh_token: env.STRAVA_REFRESH_TOKEN,
grant_type: ‘refresh_token’,
}),
});
if (!res.ok) {
const t = await res.text();
throw new Error(`token_refresh_failed:${res.status}:${t}`);
}
const data = await res.json();
return data.access_token;
}

async function stravaFetch(env, path, params = {}) {
const token = await getAccessToken(env);
const u = new URL(‘https://www.strava.com/api/v3’ + path);
for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
const res = await fetch(u, {
headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
const t = await res.text();
throw new Error(`strava_api:${res.status}:${t}`);
}
return res.json();
}

async function getRecentActivities(env, days) {
const after = Math.floor(Date.now() / 1000) - days * 86400;
const list = await stravaFetch(env, ‘/athlete/activities’, { after, per_page: 50 });

return list
.filter(a => /Ride|VirtualRide|EBikeRide/i.test(a.type || a.sport_type || ‘’))
.map(a => ({
id: a.id,
name: a.name,
type: a.type,
start_local: a.start_date_local,
start_utc: a.start_date,
moving_time: a.moving_time,
elapsed_time: a.elapsed_time,
distance: a.distance,
avg_watts: a.average_watts ?? null,
weighted_avg_watts: a.weighted_average_watts ?? null,
avg_hr: a.average_heartrate ?? null,
max_hr: a.max_heartrate ?? null,
kj: a.kilojoules ?? null,
device_watts: a.device_watts ?? false,
trainer: a.trainer ?? false,
}));
}