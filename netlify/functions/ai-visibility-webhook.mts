import type { Config } from '@netlify/functions';
import { fulfillOrder, stripeClient, updateSubscriptionStatus, verifiedOrder } from './_shared/ai-visibility.mts';

export default async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const raw = await request.text();
    const signature = request.headers.get('stripe-signature') || '';
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('Webhook secret is not configured');
    const stripe = stripeClient();
    const event = stripe.webhooks.constructEvent(raw, signature, secret);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const order = await verifiedOrder(session.id, stripe);
      if (order.offer && order.paid) await fulfillOrder(order.session, order.offer, event.id);
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subscription = typeof invoice.parent?.subscription_details?.subscription === 'string' ? invoice.parent.subscription_details.subscription : invoice.parent?.subscription_details?.subscription?.id;
      if (subscription) await updateSubscriptionStatus(subscription, event.type === 'invoice.paid' ? 'active/renewed' : 'payment failed');
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      await updateSubscriptionStatus(event.data.object.id, event.data.object.status);
    }
    return new Response(JSON.stringify({ received: true }), { headers: { 'content-type': 'application/json' } });
  } catch (error) { console.error('AI Visibility webhook failed', error); return new Response('Invalid webhook', { status: 400 }); }
};
export const config: Config = { path: '/api/ai-visibility-webhook' };
