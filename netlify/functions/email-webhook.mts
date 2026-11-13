import type { Config } from '@netlify/functions';
import { Resend } from 'resend';
import { integrationSecret, json, publicSupabase } from '../lib/crm';
import { notificationEmail } from '../lib/notification-email';

const tracked = new Set(['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.complained', 'email.bounced', 'email.failed', 'email.suppressed']);

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const apiKey = process.env.RESEND_API_KEY;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) return json({ error: 'Email webhook is not configured.' }, 503);

  try {
    const payload = await request.text();
    const resend = new Resend(apiKey);
    const event = resend.webhooks.verify({
      payload,
      headers: {
        id: request.headers.get('svix-id') || '',
        timestamp: request.headers.get('svix-timestamp') || '',
        signature: request.headers.get('svix-signature') || '',
      },
      webhookSecret,
    });
    const supabase = publicSupabase();
    if (event.type === 'email.received') {
      const received = await resend.emails.receiving.get(event.data.email_id);
      if (received.error || !received.data) throw new Error(received.error?.message || 'Inbound message could not be retrieved.');
      const { error } = await supabase.rpc('record_inbound_email', {
        p_secret: integrationSecret(), p_provider_message_id: received.data.id,
        p_from: received.data.from, p_to: received.data.to,
        p_subject: received.data.subject || '(No subject)', p_text_body: received.data.text || '',
        p_received_at: received.data.created_at,
      });
      if (error) throw error;
      const from = received.data.from || 'A customer';
      const subject = received.data.subject || '(No subject)';
      const preview = (received.data.text || '').slice(0, 700);
      const alert = await resend.emails.send({
        from: process.env.CRM_FROM_EMAIL || 'Ninth & Oak <hello@mail.ninthandoak.com>',
        to: [process.env.CRM_NOTIFICATION_EMAIL || 'Jason@NinthandOak.com'],
        subject: `New CRM reply: ${subject}`,
        text: `New customer reply from ${from}\n\nSubject: ${subject}\n\n${preview}\n\nOpen CRM: https://ninthandoak.com/admin`,
        html: notificationEmail('New customer reply', `From: ${from}\nSubject: ${subject}\n\n${preview}`),
      });
      if (alert.error) console.error('CRM notification email failed', alert.error);
    } else if (tracked.has(event.type) && 'email_id' in event.data) {
      const { error } = await supabase.rpc('update_email_delivery', {
        p_secret: integrationSecret(), p_provider_message_id: event.data.email_id,
        p_status: event.type.replace('email.', ''),
      });
      if (error) throw error;
    }
    return json({ received: true });
  } catch (error) {
    console.error('Resend webhook rejected', error);
    return json({ error: 'Invalid webhook.' }, 400);
  }
};

export const config: Config = { path: '/api/webhooks/resend' };
