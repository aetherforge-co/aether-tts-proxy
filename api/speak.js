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

// A default ElevenLabs voice (Rachel). Swap this for whichever voice ID you
// pick in your ElevenLabs dashboard — Voice Library > (voice) > copy Voice ID.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

// Simple in-memory rate limit per server instance. Not perfect (serverless
// instances can multiply), but stops accidental runaway loops from burning
// through your ElevenLabs quota. Swap for a real rate limiter later if this
// becomes public-facing.
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

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
  // CORS is largely decorative here since the dashboard is a local file://
  // page with no real origin — the actual gatekeeping is the shared-secret
  // check below. This header just avoids blocking legitimate browser fetches.
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

  // Shared-secret gate: only requests carrying the matching header get
  // through. This is what actually keeps random strangers who find this
  // URL from burning through your ElevenLabs quota.
  const expectedSecret = process.env.AETHER_PROXY_SECRET;
  if (expectedSecret) {
    const providedSecret = req.headers['x-aether-secret'];
    if (providedSecret !== expectedSecret) {
      res.status(401).json({ error: 'Missing or invalid secret.' });
      return;
    }
  } else {
    console.warn('AETHER_PROXY_SECRET is not set — endpoint is unprotected.');
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
  if (isRateLimited(ip)) {
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
