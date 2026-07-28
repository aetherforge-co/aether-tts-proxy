// Vercel serverless function: /api/ask
// Proxies chat requests from the AETHER dashboard to the Claude API.
// Keeps your Anthropic API key server-side — the dashboard never sees it.
//
// Setup:
//   npm install @anthropic-ai/sdk   (or just use fetch, shown below — no extra package needed)
//   Add ANTHROPIC_API_KEY to your Vercel project's environment variables

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your dashboard's origin in production
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing "messages" array.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic error:', response.status, errText);
      return res.status(502).json({ error: 'Claude request failed.' });
    }

    const data = await response.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
    res.status(200).json({ text });
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal proxy error.' });
  }
}
