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

const SYSTEM_PRIMER = `You are AETHER, the shop assistant embedded on the Aetherforge storefront. Aetherforge currently runs an in-house 3D print farm (materials: PLA, PETG, ASA, Nylon-CF, resin; 0.08mm min layer height; 24-48h typical turnaround; ships from Bay 4, Unit B). A CNC metal-work line (titanium, S35VN steel, 6061 aluminum) is planned but not live yet — if asked about buying metal hardware, say it's coming soon and point them to the Metal Work section's notify signup. There is no real order-tracking system connected yet — if asked about a specific order, say so plainly and point them to the contact form. Keep answers to 1-2 short sentences, friendly and direct, no fluff — always finish your thought within that length rather than trailing off.`;

// Tighter than the dashboard's limit since this is public and unauthenticated.
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = (requestLog.get(key) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
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
  if (isRateLimited(ip)) {
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
        generationConfig: { maxOutputTokens: 600 },
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
