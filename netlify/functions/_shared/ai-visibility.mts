import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

export const OFFERS = {
  price_1UgVjLLmNyj2mqXWIY14iOKs: { slug: 'playbook', name: 'AI Visibility Playbook', amount: 2700, files: ['playbook'] },
  price_1UgVjeLmNyj2mqXWbUFyLxVx: { slug: 'toolkit', name: 'AI Visibility Business Toolkit', amount: 4700, files: ['playbook', 'toolkit'] },
  price_1UgVjwLmNyj2mqXWiUn6c6pr: { slug: 'management', name: 'AI Visibility Management', amount: 25000, files: [] },
} as const;

export type Offer = (typeof OFFERS)[keyof typeof OFFERS];
const store = () => getStore({ name: 'ai-visibility-fulfillment', consistency: 'strong' });
const clean = (value: unknown, max = 500) => String(value || '').trim().slice(0, max);
const richText = (value: string) => ({ markdown: value });

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key);
}

export async function verifiedOrder(sessionId: string, stripe = stripeClient()) {
  if (!/^cs_(?:test_)?[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid Checkout Session');
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price', 'subscription'] });
  const price = session.line_items?.data?.[0]?.price;
  const offer = price?.id ? OFFERS[price.id as keyof typeof OFFERS] : undefined;
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  const amountMatches = Boolean(offer && session.amount_total === offer.amount && session.currency === 'usd');
  return { session, offer, paid: paid && amountMatches, priceId: price?.id || '' };
}

function signingSecret() {
  return process.env.DOWNLOAD_SIGNING_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
}

export function signDownload(sessionId: string, file: string, expires = Date.now() + 15 * 60_000) {
  const payload = Buffer.from(JSON.stringify({ s: sessionId, f: file, e: expires })).toString('base64url');
  const signature = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyDownload(token: string) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !signingSecret()) return null;
  const expected = createHmac('sha256', signingSecret()).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { s: string; f: string; e: number };
    return value.e > Date.now() ? value : null;
  } catch { return null; }
}

async function twentyApi(path: string, init?: RequestInit) {
  const base = clean(process.env.TWENTY_BASE_URL).replace(/\/$/, '');
  const key = process.env.TWENTY_API_KEY;
  if (!base || !key) throw new Error('Twenty is not configured');
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init?.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.messages?.[0] || result?.message || `Twenty request failed (${response.status})`);
  return result;
}

async function syncTwenty(session: Stripe.Checkout.Session, offer: Offer, status = 'paid') {
  const email = clean(session.customer_details?.email || session.customer_email, 180).toLowerCase();
  if (!email) return;
  const personQuery = encodeURIComponent(`emails.primaryEmail[eq]:${email}`);
  let person = (await twentyApi(`/rest/people?filter=${personQuery}&limit=1`)).data?.people?.[0];
  const fullName = clean(session.customer_details?.name, 160);
  const [firstName, ...last] = fullName.split(/\s+/).filter(Boolean);
  const fields = { name: { firstName: firstName || 'AI Visibility', lastName: last.join(' ') || 'Customer' }, emails: { primaryEmail: email, additionalEmails: [] } };
  person = person
    ? (await twentyApi(`/rest/people/${person.id}`, { method: 'PATCH', body: JSON.stringify(fields) })).data?.updatePerson
    : (await twentyApi('/rest/people', { method: 'POST', body: JSON.stringify(fields) })).data?.createPerson;

  const opportunityName = `AI Visibility | ${session.id}`;
  const opportunityQuery = encodeURIComponent(`name[eq]:"${opportunityName}"`);
  let opportunity = (await twentyApi(`/rest/opportunities?filter=${opportunityQuery}&limit=1`)).data?.opportunities?.[0];
  if (!opportunity) {
    opportunity = (await twentyApi('/rest/opportunities', { method: 'POST', body: JSON.stringify({
      name: opportunityName,
      amount: { amountMicros: (session.amount_total || offer.amount) * 10_000, currencyCode: 'USD' },
      stage: status === 'paid' && offer.slug !== 'management' ? 'WON' : 'NEW',
      pointOfContactId: person?.id,
    }) })).data?.createOpportunity;
  }
  const noteText = [
    `Stripe Checkout Session: ${session.id}`,
    `Offer: ${offer.name}`,
    `Amount: ${((session.amount_total || offer.amount) / 100).toFixed(2)} USD`,
    `Payment status: ${status}`,
    `Source: ${clean(session.client_reference_id || session.metadata?.source || 'ai-visibility')}`,
    `Fulfillment status: ${status === 'paid' ? 'access granted' : 'pending'}`,
  ].join('\n');
  const title = `AI Visibility order — ${session.id}`;
  const existingNote = (await twentyApi(`/rest/notes?filter=${encodeURIComponent(`title[eq]:"${title}"`)}&limit=1`)).data?.notes?.[0];
  if (!existingNote) {
    const note = (await twentyApi('/rest/notes', { method: 'POST', body: JSON.stringify({ title, bodyV2: richText(noteText) }) })).data?.createNote;
    if (note?.id && person?.id) await twentyApi('/rest/noteTargets', { method: 'POST', body: JSON.stringify({ noteId: note.id, targetPersonId: person.id }) });
    if (note?.id && opportunity?.id) await twentyApi('/rest/noteTargets', { method: 'POST', body: JSON.stringify({ noteId: note.id, targetOpportunityId: opportunity.id }) });
  }
  if (offer.slug === 'management') {
    const title = `Onboard AI Visibility Management — ${email}`;
    const existing = (await twentyApi(`/rest/tasks?filter=${encodeURIComponent(`title[eq]:"${title}"`)}&limit=1`)).data?.tasks?.[0];
    if (!existing) await twentyApi('/rest/tasks', { method: 'POST', body: JSON.stringify({ title, bodyV2: richText(`Paid subscription ${session.subscription}. Confirm priority market, access, and first update.`), status: 'TODO', dueAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), personId: person?.id }) });
  }
}

async function sendAccessEmail(session: Stripe.Checkout.Session, offer: Offer) {
  const key = process.env.RESEND_API_KEY;
  const email = clean(session.customer_details?.email || session.customer_email, 180).toLowerCase();
  if (!email || offer.slug === 'management') return;
  const accessUrl = `https://ninthandoak.com/ai-visibility/order?session_id=${encodeURIComponent(session.id)}`;
  const message = {
    from: process.env.CRM_FROM_EMAIL || 'Ninth & Oak <Hello@ninthandoak.com>', to: [email], reply_to: process.env.CRM_REPLY_TO || 'Jason@ninthandoak.com',
    subject: 'Your Ninth & Oak AI Visibility materials',
    text: `Thanks for your purchase. Open your materials: ${accessUrl}\n\nStart with one service and two AI search experiences, and save a baseline before making edits. If you need help getting into your files, reply to this email.`,
    html: `<p>Thanks for your purchase.</p><p><a href="${accessUrl}">Open my purchase</a></p><p>Start with one service and two AI search experiences, and save a baseline before making edits. If you need help getting into your files, reply to this email.</p>`,
  };
  if (key) {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    if (!response.ok) throw new Error(`Resend failed (${response.status})`);
    return;
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USERNAME || !process.env.SMTP_PASSWORD) throw new Error('No delivery channel is configured');
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465, auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } });
  await transporter.sendMail({ from: message.from, to: email, replyTo: message.reply_to, subject: message.subject, text: message.text, html: message.html });
}

export async function fulfillOrder(session: Stripe.Checkout.Session, offer: Offer, eventId?: string) {
  const db = store();
  if (eventId) {
    const claim = await db.setJSON(`events/${eventId}`, { processedAt: new Date().toISOString() }, { onlyIfNew: true });
    if (claim?.modified === false) return { duplicate: true };
  }
  const key = `orders/${session.id}`;
  const existing = await db.get(key, { type: 'json' }) as Record<string, unknown> | null;
  const record = { ...existing, sessionId: session.id, offer: offer.slug, priceAmount: offer.amount, paymentStatus: session.payment_status, fulfilledAt: existing?.fulfilledAt || new Date().toISOString(), emailSent: Boolean(existing?.emailSent), crmSynced: Boolean(existing?.crmSynced) };
  await db.setJSON(key, record);
  if (!record.emailSent) try { await sendAccessEmail(session, offer); record.emailSent = true; await db.setJSON(key, record); } catch (error) { console.error('Access email failed', error); }
  if (!record.crmSynced) try { await syncTwenty(session, offer); record.crmSynced = true; await db.setJSON(key, record); } catch (error) { console.error('Twenty sync failed', error); }
  return record;
}

export async function updateSubscriptionStatus(subscriptionId: string, status: string) {
  try {
    const query = encodeURIComponent(`name[like]:"%${subscriptionId}%"`);
    const notes = (await twentyApi(`/rest/notes?filter=${query}&limit=10`)).data?.notes || [];
    for (const note of notes) await twentyApi(`/rest/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ bodyV2: richText(`${note.bodyV2?.markdown || ''}\n\nSubscription status: ${status}\nUpdated: ${new Date().toISOString()}`) }) });
  } catch (error) { console.error('Subscription CRM update failed', error); }
}
