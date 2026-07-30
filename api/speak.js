// /api/speak
//
// Proxies text-to-speech requests to ElevenLabs. The ElevenLabs API key lives
// only in this server-side environment variable (ELEVENLABS_API_KEY) — it is
// never sent to or visible from the browser.
//
// Deploy this on Vercel as-is: any file under /api becomes a serverless
// route at /api/<filename>, so this becomes POST https://your-domain/api/speak

const ELEVENLABS_TTS_URL = (voiceId) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

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
    const redisKey = `ratelimit:speak:${key}`;
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

  // SECURITY: fail CLOSED, not open. If the secret isn't configured, this
  // used to just log a warning and let every request through — meaning
  // anyone who found the URL could burn through the ElevenLabs quota for
  // free. Now a missing secret is treated as "not deployable" and the
  // endpoint refuses all requests until it's set.
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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('ELEVENLABS_API_KEY is not set in the environment.');
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

  const { text, voiceId } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: '"text" is required.' });
    return;
  }
  if (text.length > 1000) {
    res.status(400).json({ error: 'Text is too long (max 1000 characters).' });
    return;
  }

  try {
    const elevenRes = await fetch(ELEVENLABS_TTS_URL(voiceId || DEFAULT_VOICE_ID), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error('ElevenLabs error:', elevenRes.status, errText);
      res.status(elevenRes.status).json({ error: 'Text-to-speech request failed.' });
      return;
    }

    const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(audioBuffer);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Could not reach the text-to-speech service.' });
  }
};
