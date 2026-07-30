// /api/ask
//
// Proxies AETHER's chat requests to Google's Gemini API (free tier, no
// credit card required). The Gemini API key lives only in this server-side
// environment variable (GEMINI_API_KEY) — it is never sent to or visible
// from the browser. Same secret-gate pattern as /api/speak.

const GEMINI_MODEL = 'gemini-flash-latest'; // alias — always points at Google's current stable Flash model
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const memoryRequestLog = new Map();
function isRateLimitedMemory(key, max, windowMs) {
  const now = Date.now();
  const timestamps = (memoryRequestLog.get(key) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  memoryRequestLog.set(key, timestamps);
  return timestamps.length > max;
}

// Real distributed rate limit via Upstash Redis's REST API — falls back to
// the in-memory limiter above if UPSTASH_REDIS_REST_URL/TOKEN aren't set.
async function isRateLimited(key, max, windowSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return isRateLimitedMemory(key, max, windowSeconds * 1000);
  }
  try {
    const redisKey = `ratelimit:ask:${key}`;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Aether-Secret');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  // SECURITY: fail CLOSED, not open — see speak.js for the same fix and why
  // it matters. A missing secret now blocks every request instead of
  // silently letting them through.
  const expectedSecret = process.env.AETHER_PROXY_SECRET;
  if (!expectedSecret) {
    console.error('AETHER_PROXY_SECRET is not set — refusing all requests.');
    res.status(500).json({ error: 'Server misconfigured — missing shared secret.' });
    return;
  }
  const providedSecret = req.headers['x-aether-secret'];
  if (providedSecret !== expectedSecret) {
    res.status(401).json({ error: 'Missing or invalid secret.' });
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
  if (await isRateLimited(ip, 20, 60)) {
    res.status(429).json({ error: 'Too many requests — slow down.' });
    return;
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: '"messages" array is required.' });
    return;
  }

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const geminiRes = await fetch(GEMINI_URL(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
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
