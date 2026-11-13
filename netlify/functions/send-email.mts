import type { Config } from '@netlify/functions';
import { Resend } from 'resend';
import { bearerToken, json, userSupabase } from '../lib/crm';

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const token = bearerToken(request);
  if (!token) return json({ error: 'Sign in required.' }, 401);

  try {
    const supabase = userSupabase(token);
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth.user) return json({ error: 'Session expired. Sign in again.' }, 401);
    const { data: member } = await supabase.from('crm_members').select('user_id').eq('user_id', auth.user.id).maybeSingle();
    if (!member) return json({ error: 'CRM access required.' }, 403);

    const body = await request.json() as { contactId?: string; to?: string; subject?: string; text?: string };
    const to = String(body.to || '').trim().toLowerCase();
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '').trim();
    if (!body.contactId || !/^\S+@\S+\.\S+$/.test(to) || !subject || !text) return json({ error: 'Contact, recipient, subject, and message are required.' }, 400);
    if (!process.env.RESEND_API_KEY) return json({ error: 'Email delivery is awaiting provider connection.' }, 503);

    const { data: contact } = await supabase.from('contacts').select('id,email').eq('id', body.contactId).maybeSingle();
    if (!contact) return json({ error: 'Contact not found.' }, 404);

    const from = process.env.CRM_FROM_EMAIL || 'Ninth & Oak <hello@mail.ninthandoak.com>';
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({ from, to: [to], subject, text, replyTo: process.env.CRM_REPLY_TO || undefined });
    if (result.error || !result.data) return json({ error: result.error?.message || 'Message could not be sent.' }, 502);

    let { data: thread } = await supabase.from('email_threads').select('id').eq('contact_id', contact.id).eq('subject', subject).maybeSingle();
    if (!thread) {
      const created = await supabase.from('email_threads').insert({ contact_id: contact.id, subject, last_message_at: new Date().toISOString() }).select('id').single();
      if (created.error) throw created.error;
      thread = created.data;
    } else {
      await supabase.from('email_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);
    }
    const { error: messageError } = await supabase.from('email_messages').insert({
      thread_id: thread.id, contact_id: contact.id, direction: 'outbound', from_address: from,
      to_addresses: [to], subject, text_body: text, provider_message_id: result.data.id,
      delivery_status: 'sent', sent_at: new Date().toISOString(), created_by: auth.user.id,
    });
    if (messageError) throw messageError;
    await supabase.from('activities').insert({ contact_id: contact.id, activity_type: 'email', summary: `Email sent: ${subject}`, details: text, created_by: auth.user.id });
    return json({ id: result.data.id, threadId: thread.id });
  } catch (error) {
    console.error('CRM send email failed', error);
    return json({ error: 'Message could not be sent.' }, 500);
  }
};

export const config: Config = { path: '/api/crm/email/send' };

