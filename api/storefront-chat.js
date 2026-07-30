// /api/storefront-chat
//
// Proxies the Aetherforge storefront's AETHER widget to Google's Gemini API
// (free tier). This is a DIFFERENT endpoint from /api/ask (the dashboard's
// chat proxy) because this one is public-facing — the storefront's HTML/JS
// is visible to anyone who visits the site, so it can't carry a shared
// secret the way the private dashboard file does. Instead this endpoint is
// locked down by:
//   1. An origin allowlist — only requests from your actual storefront
//      domains get a CORS-approved response.
//   2. A tighter per-IP rate limit than the dashboard proxy.
//   3. A capped response length, to bound cost per request.
//
// Add your real domain(s) below before relying on this in production.

const ALLOWED_ORIGINS = [
  'https://www.aetherforgeco.com',
  'https://aetherforgeco.com',
];

const GEMINI_MODEL = 'gemini-flash-latest'; // alias — always points at Google's current stable Flash model
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const SYSTEM_PRIMER = `You are AETHER, the shop assistant embedded on the Aetherforge storefront. Aetherforge currently runs an in-house 3D print farm (materials: PLA, PETG, ASA, Nylon-CF, resin; 0.08mm min layer height; 24-48h typical turnaround; ships from Bay 4, Unit B). A CNC metal-work line (titanium, S35VN steel, 6061 aluminum) is planned but not live yet — if asked about buying metal hardware, say it's coming soon and point them to the Metal Work section's notify signup. There is no real order-tracking system connected yet — if asked about a specific order, say so plainly and point them to the contact form. Keep answers to 2-3 short sentences, friendly and direct, no fluff.`;

// Fallback in-memory limiter — used only if Upstash isn't configured yet.
const memoryRequestLog = new Map();
function isRateLimitedMemory(key, max, windowMs) {
  const now = Date.now();
  const timestamps = (memoryRequestLog.get(key) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  memoryRequestLog.set(key, timestamps);
  return timestamps.length > max;
}

// Real distributed rate limit via Upstash Redis's REST API — this endpoint
// is public and unauthenticated, so a shared-state limiter matters more
// here than on the private dashboard proxies. Falls back to in-memory if
// UPSTASH_REDIS_REST_URL/TOKEN aren't set.
async function isRateLimited(key, max, windowSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return isRateLimitedMemory(key, max, windowSeconds * 1000);
  }
  try {
    const redisKey = `ratelimit:storefront-chat:${key}`;
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, windowSeconds, 'NX'],
      ]),
    });
    const data = await res.json();
    const count = data?.[0]?.result;
    if (typeof count !== 'number') return isRateLimitedMemory(key, max, windowSeconds * 1000);
    return count > max;
  } catch (err) {
    console.error('Upstash rate limit error, falling back to in-memory:', err);
    return isRateLimitedMemory(key, max, windowSeconds * 1000);
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  // Belt-and-suspenders: reject if the origin isn't on the allowlist at all,
  // even though the browser would already block a cross-origin read without
  // the CORS header above — this stops non-browser clients (curl, scripts)
  // from hitting the endpoint directly using a spoofed Origin header too.
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in the environment.');
    res.status(500).json({ error: 'Server misconfigured — missing API key.' });
    return;
  }

  const ip =
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (await isRateLimited(ip, 8, 60)) {
    res.status(429).json({ error: 'Too many requests — slow down.' });
    return;
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: '"messages" array is required.' });
    return;
  }
  // Cap history length to control token usage on a public, unauthenticated endpoint.
  const trimmedMessages = messages.slice(-8);

  const contents = [
    { role: 'user', parts: [{ text: SYSTEM_PRIMER }] },
    { role: 'model', parts: [{ text: "Understood — I'm AETHER, ready to help." }] },
    ...trimmedMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  ];

  try {
    const geminiRes = await fetch(GEMINI_URL(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        // gemini-flash-latest now resolves to Gemini 3.5 Flash, which uses
        // thinkingLevel (not the older thinkingBudget) and can't fully
        // disable thinking — 'low' is the minimum. maxOutputTokens raised
        // to give that minimal thinking pass headroom without eating into
        // the visible reply.
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini error:', geminiRes.status, data);
      res.status(geminiRes.status).json({ error: 'Chat request failed.' });
      return;
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    res.status(200).json({ text: text || 'No response came back — try again.' });
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Could not reach the chat service.' });
  }
};
