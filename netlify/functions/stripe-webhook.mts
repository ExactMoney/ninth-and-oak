import type { Config } from '@netlify/functions';
import Stripe from 'stripe';
import { integrationSecret, json, publicSupabase } from '../lib/crm';

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe webhook is not configured.' }, 503);
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); const event = stripe.webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature') || '', process.env.STRIPE_WEBHOOK_SECRET); const invoice = event.data.object as Stripe.Invoice;
    if (['invoice.paid','invoice.payment_failed','invoice.voided'].includes(event.type)) await publicSupabase().rpc('update_stripe_invoice_status', { p_secret: integrationSecret(), p_stripe_invoice_id: invoice.id, p_status: event.type === 'invoice.paid' ? 'paid' : event.type === 'invoice.voided' ? 'void' : 'open' });
    return json({ received: true });
  } catch (error) { console.error('Stripe webhook rejected', error); return json({ error: 'Invalid webhook.' }, 400); }
};
export const config: Config = { path: '/api/webhooks/stripe' };
