import type { Config } from '@netlify/functions';
import { Resend } from 'resend';
import { bearerToken, json, userSupabase } from '../lib/crm';
import { notificationEmail } from '../lib/notification-email';

const formEncode = (values: Record<string, string>) => new URLSearchParams(values).toString();

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const token = bearerToken(request); if (!token) return json({ error: 'Sign in required.' }, 401);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not connected yet. Add STRIPE_SECRET_KEY in Netlify environment variables.' }, 503);
  try {
    const supabase = userSupabase(token);
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth.user) return json({ error: 'Session expired. Sign in again.' }, 401);
    const { data: member } = await supabase.from('crm_members').select('user_id').eq('user_id', auth.user.id).maybeSingle();
    if (!member) return json({ error: 'CRM access required.' }, 403);
    const body = await request.json() as { contactId?: string; title?: string; amount?: string | number; message?: string; details?: string; expiresInDays?: string | number };
    const contactId = String(body.contactId || ''); const title = String(body.title || '').trim(); const amount = Number(body.amount || 0); const days = Math.min(90, Math.max(1, Number(body.expiresInDays || 30)));
    if (!contactId || !title || !Number.isFinite(amount) || amount <= 0) return json({ error: 'Client, title, and a positive amount are required.' }, 400);
    const { data: contact } = await supabase.from('contacts').select('id,first_name,last_name,email,company').eq('id', contactId).maybeSingle();
    if (!contact?.email) return json({ error: 'This contact needs an email address before a proposal can be sent.' }, 400);
    const cents = Math.round(amount * 100);
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    const details = String(body.details || '').trim();
    const stripeResponse = await fetch('https://api.stripe.com/v1/payment_links', { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formEncode({ 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': title, 'line_items[0][price_data][product_data][description]': details || String(body.message || 'Ninth & Oak proposal'), 'line_items[0][price_data][unit_amount]': String(cents), 'line_items[0][quantity]': '1', 'after_completion[type]': 'redirect', 'after_completion[redirect][url]': 'https://ninthandoak.com/thank-you', 'metadata[contact_id]': contactId, 'metadata[proposal_title]': title }) });
    const stripe = await stripeResponse.json() as { id?: string; url?: string; error?: { message?: string } };
    if (!stripeResponse.ok || !stripe.id || !stripe.url) return json({ error: stripe.error?.message || 'Stripe could not create the payment link.' }, 502);
    const { data: proposal, error } = await supabase.from('proposals').insert({ contact_id: contactId, title, message: [details, String(body.message || '').trim()].filter(Boolean).join('\n\n'), amount_cents: cents, status: 'sent', payment_url: stripe.url, stripe_payment_link_id: stripe.id, expires_at: expires, created_by: auth.user.id }).select('id').single();
    if (error) throw error;
    const resend = new Resend(process.env.RESEND_API_KEY || '');
    if (process.env.RESEND_API_KEY) {
      const clientName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'there';
      await resend.emails.send({ from: process.env.CRM_FROM_EMAIL || 'Ninth & Oak <Hello@ninthandoak.com>', to: [contact.email], subject: `Proposal from Ninth & Oak: ${title}`, text: `Hi ${clientName},\n\n${details}\n\n${body.message || 'Thank you for the opportunity to work together.'}\n\nReview and pay securely: ${stripe.url}\n\nThis link expires ${new Date(expires).toLocaleDateString('en-US')}.`, html: notificationEmail(`A proposal for ${clientName}`, `${details}\n\n${body.message || 'Thank you for the opportunity to work together.'}\n\nProposal: ${title}\nAmount: $${amount.toFixed(2)}\nExpires: ${new Date(expires).toLocaleDateString('en-US')}`, 'Review proposal', stripe.url) });
    }
    await supabase.from('activities').insert({ contact_id: contactId, activity_type: 'email', summary: `Proposal sent: ${title}`, details: stripe.url, created_by: auth.user.id });
    return json({ id: proposal.id, paymentUrl: stripe.url });
  } catch (error) { console.error('Create proposal failed', error); return json({ error: 'Proposal could not be created.' }, 500); }
};

export const config: Config = { path: '/api/crm/proposals/create' };
