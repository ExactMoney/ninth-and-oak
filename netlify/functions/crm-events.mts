import { integrationSecret, publicSupabase } from '../lib/crm';

type FormSubmittedEvent = { data: Record<string, unknown> & { data?: Record<string, unknown> } };

function splitName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || 'Website', last: parts.join(' ') };
}

export default {
  async formSubmitted(event: FormSubmittedEvent) {
    const fields = event.data?.data || event.data || {};
    const email = String(fields.email || '').trim().toLowerCase();
    if (!email) return;
    const name = splitName(String(fields.name || 'Website Lead'));
    const service = String(fields.service || '').trim();
    const message = String(fields.message || '').trim();
    const notes = [service && `Service: ${service}`, message].filter(Boolean).join('\n\n');
    const { error } = await publicSupabase().rpc('ingest_website_lead', {
      p_secret: integrationSecret(),
      p_first_name: name.first,
      p_last_name: name.last,
      p_email: email,
      p_phone: String(fields.phone || '').trim() || null,
      p_company: String(fields.company || '').trim() || null,
      p_notes: notes || null,
    });
    if (error) throw error;
  },
};

