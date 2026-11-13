import type { Config } from '@netlify/functions';
import { bearerToken, json, userSupabase } from '../lib/crm';

const encode = (v: Record<string, string>) => new URLSearchParams(v).toString();
const stripePost = (path: string, body: Record<string, string>) => fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: encode(body) });

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const token = bearerToken(request); if (!token) return json({ error: 'Sign in required.' }, 401);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not connected. Add STRIPE_SECRET_KEY in Netlify.' }, 503);
  try {
    const db = userSupabase(token); const { data: auth } = await db.auth.getUser(token); if (!auth.user) return json({ error: 'Session expired.' }, 401);
    const { data: member } = await db.from('crm_members').select('user_id').eq('user_id', auth.user.id).maybeSingle(); if (!member) return json({ error: 'CRM access required.' }, 403);
    const body = await request.json() as { contactId?: string; title?: string; amount?: string|number; daysUntilDue?: string|number; details?: string; proposalId?: string };
    const title = String(body.title || '').trim(); const amount = Number(body.amount || 0); const days = Math.min(90, Math.max(1, Number(body.daysUntilDue || 30)));
    if (!body.contactId || !title || !Number.isFinite(amount) || amount <= 0) return json({ error: 'Client, title, and positive amount are required.' }, 400);
    const { data: contact } = await db.from('contacts').select('id,first_name,last_name,email,stripe_customer_id').eq('id', body.contactId).maybeSingle(); if (!contact?.email) return json({ error: 'Contact email is required.' }, 400);
    let customerId = contact.stripe_customer_id;
    if (!customerId) { const cr = await stripePost('customers', { email: contact.email, name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(), 'metadata[contact_id]': contact.id }); const cj = await cr.json(); if (!cr.ok || !cj.id) return json({ error: cj.error?.message || 'Stripe customer could not be created.' }, 502); customerId = cj.id; await db.from('contacts').update({ stripe_customer_id: customerId }).eq('id', contact.id); }
    const cents = String(Math.round(amount * 100)); const details = String(body.details || '').trim(); const item = await stripePost('invoiceitems', { customer: customerId, amount: cents, currency: 'usd', description: details ? `${title} — ${details}` : title }); const ij = await item.json(); if (!item.ok) return json({ error: ij.error?.message || 'Invoice item failed.' }, 502);
    const inv = await stripePost('invoices', { customer: customerId, collection_method: 'send_invoice', days_until_due: String(days), description: details ? `${title} — ${details}` : title, 'metadata[contact_id]': contact.id, ...(body.proposalId ? { 'metadata[proposal_id]': body.proposalId } : {}) }); const invoice = await inv.json(); if (!inv.ok || !invoice.id) return json({ error: invoice.error?.message || 'Invoice could not be created.' }, 502);
    const final = await stripePost(`invoices/${invoice.id}/finalize`, {}); const finalized = await final.json(); if (!final.ok) return json({ error: finalized.error?.message || 'Invoice could not be finalized.' }, 502);
    const sent = await stripePost(`invoices/${invoice.id}/send`, {}); const sentInvoice = await sent.json(); if (!sent.ok) return json({ error: sentInvoice.error?.message || 'Invoice could not be sent.' }, 502);
    const invoiceUrl = sentInvoice.hosted_invoice_url || finalized.hosted_invoice_url;
    const { data: saved, error } = await db.from('invoices').insert({ contact_id: contact.id, proposal_id: body.proposalId || null, title, amount_cents: Number(cents), status: 'open', stripe_invoice_id: invoice.id, hosted_invoice_url: invoiceUrl, due_at: new Date(Date.now() + days*86400000).toISOString(), created_by: auth.user.id }).select('id').single(); if (error) throw error;
    await db.from('activities').insert({ contact_id: contact.id, activity_type: 'email', summary: `Invoice sent: ${title}`, details: invoiceUrl, created_by: auth.user.id });
    return json({ id: saved.id, invoiceUrl });
  } catch (error) { console.error('Create invoice failed', error); return json({ error: 'Invoice could not be created.' }, 500); }
};
export const config: Config = { path: '/api/crm/invoices/create' };
