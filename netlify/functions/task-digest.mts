import type { Config } from '@netlify/functions';
import { Resend } from 'resend';
import { integrationSecret, json, publicSupabase } from '../lib/crm';
import { notificationEmail } from '../lib/notification-email';

export default async (request: Request) => {
  if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!process.env.RESEND_API_KEY) return json({ error: 'Email delivery is not configured.' }, 503);
  try {
    const supabase = publicSupabase();
    const { data, error } = await supabase.rpc('get_task_digest', { p_secret: integrationSecret() });
    if (error) throw error;
    const tasks = (data || []) as Array<{ title: string; due_at: string | null; priority: string; contact_name: string | null }>;
    if (!tasks.length) return json({ sent: false, reason: 'No open tasks.' });
    const lines = tasks.map((task) => `• ${task.title}${task.contact_name ? ` — ${task.contact_name}` : ''}${task.due_at ? ` (due ${new Date(task.due_at).toLocaleDateString('en-US')})` : ''}`);
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: process.env.CRM_FROM_EMAIL || 'Ninth & Oak <hello@mail.ninthandoak.com>',
      to: [process.env.CRM_NOTIFICATION_EMAIL || 'Jason@NinthandOak.com'],
      subject: `CRM task digest: ${tasks.length} open task${tasks.length === 1 ? '' : 's'}`,
      text: `You have ${tasks.length} open CRM task${tasks.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nOpen CRM: https://ninthandoak.com/admin`,
      html: notificationEmail(`Your CRM task digest`, `You have ${tasks.length} open CRM task${tasks.length === 1 ? '' : 's'}.\n\n${lines.join('\n')}`),
    });
    if (result.error) throw result.error;
    return json({ sent: true, count: tasks.length });
  } catch (error) {
    console.error('CRM task digest failed', error);
    return json({ error: 'Digest could not be sent.' }, 500);
  }
};

export const config: Config = { schedule: '0 13 * * *' };
