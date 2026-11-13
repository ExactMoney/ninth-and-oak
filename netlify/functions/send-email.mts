import type { Config } from '@netlify/functions';
import { Resend } from 'resend';
import { bearerToken, json, userSupabase } from '../lib/crm';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] || character));

function brandedEmail(message: string) {
  const content = escapeHtml(message).replace(/\r?\n/g, '<br>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4efe6;color:#202326;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4efe6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fffdf8;border:1px solid #e4ddd2">
        <tr><td style="padding:28px 36px;border-top:4px solid #b76e43;border-bottom:1px solid #e4ddd2">
          <a href="https://ninthandoak.com" style="text-decoration:none"><img src="https://ninthandoak.com/images/ninth-and-oak-logo-transparent.png" width="250" alt="Ninth & Oak" style="display:block;max-width:100%;height:auto"></a>
        </td></tr>
        <tr><td style="padding:38px 36px 26px;font-size:16px;line-height:1.75;color:#303336">${content}</td></tr>
        <tr><td style="padding:8px 36px 38px">
          <div style="width:52px;height:2px;background:#b76e43;margin-bottom:18px"></div>
          <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;color:#202326">Jason Purvis</p>
          <p style="margin:0 0 12px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#b76e43">Ninth &amp; Oak</p>
          <p style="margin:0;font-size:13px;line-height:1.65;color:#6d6a64"><a href="mailto:Jason@NinthandOak.com" style="color:#6d6a64;text-decoration:none">Jason@NinthandOak.com</a><br><a href="https://ninthandoak.com" style="color:#6d6a64;text-decoration:none">ninthandoak.com</a></p>
        </td></tr>
        <tr><td style="background:#202326;padding:18px 36px;font-family:Georgia,serif;font-size:13px;color:#f4efe6">Rooted in Experience. <span style="color:#c98257">Built for What’s Next.</span></td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

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

    const body = await request.json() as { contactId?: string; threadId?: string; to?: string; subject?: string; text?: string };
    const to = String(body.to || '').trim().toLowerCase();
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '').trim();
    if (!body.contactId || !/^\S+@\S+\.\S+$/.test(to) || !subject || !text) return json({ error: 'Contact, recipient, subject, and message are required.' }, 400);
    if (!process.env.RESEND_API_KEY) return json({ error: 'Email delivery is awaiting provider connection.' }, 503);

    const { data: contact } = await supabase.from('contacts').select('id,email').eq('id', body.contactId).maybeSingle();
    if (!contact) return json({ error: 'Contact not found.' }, 404);

    const from = process.env.CRM_FROM_EMAIL || 'Ninth & Oak <hello@mail.ninthandoak.com>';
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from, to: [to], subject, text, html: brandedEmail(text),
      // Replies return through Resend's verified inbound subdomain so they are
      // captured in the CRM. The public root-domain address remains in the signature.
      replyTo: process.env.CRM_REPLY_TO || 'jason@mail.ninthandoak.com',
    });
    if (result.error || !result.data) return json({ error: result.error?.message || 'Message could not be sent.' }, 502);

    let thread: { id: string } | null = null;
    if (body.threadId) {
      const existing = await supabase.from('email_threads').select('id').eq('id', body.threadId).eq('contact_id', contact.id).maybeSingle();
      thread = existing.data;
    }
    if (!thread) {
      const normalizedSubject = subject.replace(/^(re:|fwd:)\s*/i, '');
      const existing = await supabase.from('email_threads').select('id').eq('contact_id', contact.id).ilike('subject', normalizedSubject).order('last_message_at', { ascending: false }).limit(1).maybeSingle();
      thread = existing.data;
    }
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

