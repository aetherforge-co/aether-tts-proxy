// Vercel serverless function: /api/store-stats
// Pulls today's real revenue, order count, AOV, and recent orders from Stripe.
// Keeps your Stripe secret key server-side — the dashboard only ever calls this endpoint.
//
// Note: the order-list images/customer details come from Stripe Checkout Sessions,
// which assumes your checkout uses Stripe's hosted Checkout (not a custom Payment
// Element flow). If it's custom, that part of the response will just come back empty.
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
    const refundedAmount = refunded.reduce((sum, c) => sum + c.amount, 0) / 100;

    const recent = successful.slice(0, 6).map(c => ({
      amount: c.amount / 100,
      description: c.description || c.billing_details?.name || 'Order',
      created: c.created,
    }));

    // Group orders by customer location (state/region if available, else country)
    const locationTotals = {};
    successful.forEach(c => {
      const addr = c.billing_details?.address;
      const label = addr?.state || addr?.country || 'Unknown';
      if (!locationTotals[label]) locationTotals[label] = { location: label, count: 0, revenue: 0 };
      locationTotals[label].count += 1;
      locationTotals[label].revenue += c.amount / 100;
    });
    const locations = Object.values(locationTotals).sort((a, b) => b.revenue - a.revenue).slice(0, 6);

    // Recent orders with product image + customer info, for the order-list panel.
    // Requires Stripe Checkout Sessions (hosted checkout) — see note above.
    let recentOrders = [];
    try {
      const sessions = await stripe.checkout.sessions.list({
        created: { gte: startOfDay },
        limit: 10,
        status: 'complete',
        expand: ['data.line_items', 'data.line_items.data.price.product'],
      });

      recentOrders = sessions.data.map(s => {
        const item = s.line_items?.data?.[0];
        const product = item?.price?.product;
        return {
          id: s.id,
          customerName: s.customer_details?.name || 'Customer',
          customerEmail: s.customer_details?.email || '',
          location: [s.customer_details?.address?.state, s.customer_details?.address?.country].filter(Boolean).join(', '),
          amount: (s.amount_total || 0) / 100,
          productName: (product && product.name) || item?.description || 'Order',
          productImage: (product && product.images && product.images[0]) || null,
          created: s.created,
        };
      });
    } catch (sessionErr) {
      console.error('Checkout session fetch failed (order list will be empty):', sessionErr);
    }

    res.status(200).json({
      revenue,
      orders,
      aov,
      refundsToday: refunded.length,
      refundedAmount,
      locations,
      recent,
      recentOrders,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Stripe fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch Stripe data' });
  }
}
