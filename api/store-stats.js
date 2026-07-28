// Vercel serverless function: /api/store-stats
// Pulls today's real revenue, order count, AOV, and recent orders from Stripe.
// Keeps your Stripe secret key server-side — the dashboard only ever calls this endpoint.
//
// Setup:
//   npm install stripe
//   Add STRIPE_SECRET_KEY to your Vercel project's environment variables
//   Deploy this file as /api/store-stats.js (or app/api/store-stats/route.js if using the app router)

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // Tighten this to your actual dashboard's origin once you know where it's hosted
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const startOfDay = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);

    const charges = await stripe.charges.list({
      created: { gte: startOfDay },
      limit: 100,
    });

    const successful = charges.data.filter(c => c.paid && !c.refunded);
    const refunded = charges.data.filter(c => c.refunded);

    const revenue = successful.reduce((sum, c) => sum + c.amount, 0) / 100;
    const orders = successful.length;
    const aov = orders ? revenue / orders : 0;

    const recent = successful.slice(0, 6).map(c => ({
      amount: c.amount / 100,
      description: c.description || c.billing_details?.name || 'Order',
      created: c.created,
    }));

    res.status(200).json({
      revenue,
      orders,
      aov,
      refundsToday: refunded.length,
      recent,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Stripe fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch Stripe data' });
  }
}
