import type { Config } from '@netlify/functions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const clean = (value: unknown, max = 500) => String(value || '').trim().slice(0, max);

function richText(value: string) {
  return { markdown: value };
}

const escapeHtml = (value: string) => value.replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));

function brandedEmail(title: string, body: string, buttonLabel?: string, buttonHref?: string) {
  const button = buttonLabel && buttonHref
    ? `<p style="margin:28px 0 0"><a href="${escapeHtml(buttonHref)}" style="display:inline-block;background:#b76e43;color:#fffdf8;padding:13px 20px;text-decoration:none;font:600 12px Arial,sans-serif;letter-spacing:1.2px;text-transform:uppercase">${escapeHtml(buttonLabel)} →</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4efe6;color:#202326;font-family:Arial,sans-serif"><table width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px;background:#f4efe6"><tr><td align="center"><table width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fffdf8;border:1px solid #e4ddd2"><tr><td style="padding:22px 30px;border-top:4px solid #b76e43"><img src="https://ninthandoak.com/images/ninth-and-oak-logo-transparent.png" width="230" alt="Ninth &amp; Oak" style="display:block;max-width:100%;height:auto"></td></tr><tr><td style="padding:30px"><h1 style="margin:0 0 18px;font:400 30px Georgia,serif;color:#202326">${escapeHtml(title)}</h1><div style="font-size:16px;line-height:1.7;color:#303336">${body}</div>${button}</td></tr><tr><td style="padding:18px 30px;background:#202326;color:#f4efe6;font:13px Georgia,serif">Rooted in Experience. <span style="color:#c98257">Built for What’s Next.</span><br><span style="font:12px Arial,sans-serif;color:#c9c3bb">Ninth &amp; Oak · 3030 Starkey Boulevard, Suite 953 · New Port Richey, FL 34655</span></td></tr></table></td></tr></table></body></html>`;
}

async function sendBrandedEmail(to: string[], subject: string, html: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.CRM_FROM_EMAIL || 'Ninth & Oak <Hello@ninthandoak.com>', to, reply_to: process.env.CRM_REPLY_TO || 'Jason@NinthandOak.com', subject, html, text }),
  });
  if (!response.ok) throw new Error(`Resend request failed (${response.status})`);
}

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const input = await request.json() as Record<string, unknown>;
    if (clean(input.websiteTrap)) return json({ ok: true });

    const firstName = clean(input.firstName, 80);
    const lastName = clean(input.lastName, 80);
    const email = clean(input.email, 180).toLowerCase();
    const phone = clean(input.phone, 40);
    const jobTitle = clean(input.jobTitle, 120);
    const companyName = clean(input.companyName, 180);
    const websiteInput = clean(input.companyWebsite, 240);
    const city = clean(input.city, 100);
    const state = clean(input.state, 100);
    const postcode = clean(input.postcode, 20);
    const businessDescription = clean(input.businessDescription, 1200);
    const mainGoal = clean(input.mainGoal, 1200);
    const biggestChallenge = clean(input.biggestChallenge, 1200);
    const teamSize = clean(input.teamSize, 80);
    const preferredContact = clean(input.preferredContact, 40);
    const interests = Array.isArray(input.interests)
      ? input.interests.map((item) => clean(item, 100)).filter(Boolean).slice(0, 8)
      : [];

    if (!firstName || !lastName || !companyName || !/^\S+@\S+\.\S+$/.test(email) || !businessDescription || !mainGoal) {
      return json({ error: 'Please complete all required fields.' }, 400);
    }

    const baseUrl = String(process.env.TWENTY_BASE_URL || '').replace(/\/$/, '');
    const apiKey = process.env.TWENTY_API_KEY;
    if (!baseUrl || !apiKey) return json({ error: 'The CRM connection is not configured.' }, 503);
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.messages?.[0] || result?.message || `Twenty request failed (${response.status})`);
      return result;
    };

    let normalizedWebsite = '';
    let domain = '';
    if (websiteInput) {
      try {
        const url = new URL(/^https?:\/\//i.test(websiteInput) ? websiteInput : `https://${websiteInput}`);
        normalizedWebsite = url.href.replace(/\/$/, '');
        domain = url.hostname.replace(/^www\./i, '').toLowerCase();
      } catch { /* Keep the intake usable when a prospect mistypes a URL. */ }
    }

    let company: Record<string, any> | undefined;
    if (domain) {
      const query = encodeURIComponent(`domainName.primaryLinkUrl[eq]:${domain}`);
      company = (await api(`/rest/companies?filter=${query}&limit=1`)).data?.companies?.[0];
    }
    if (!company) {
      const query = encodeURIComponent(`name[eq]:"${companyName.replace(/"/g, '')}"`);
      company = (await api(`/rest/companies?filter=${query}&limit=1`)).data?.companies?.[0];
    }

    const companyFields: Record<string, unknown> = {
      name: companyName,
      address: {
        addressStreet1: '', addressStreet2: '', addressCity: city, addressPostcode: postcode,
        addressState: state, addressCountry: 'United States', addressLat: null, addressLng: null,
      },
    };
    if (domain) companyFields.domainName = { primaryLinkLabel: normalizedWebsite, primaryLinkUrl: domain, secondaryLinks: [] };

    if (company) {
      company = (await api(`/rest/companies/${company.id}`, { method: 'PATCH', body: JSON.stringify(companyFields) })).data?.updateCompany;
    } else {
      company = (await api('/rest/companies', { method: 'POST', body: JSON.stringify(companyFields) })).data?.createCompany;
    }

    const personQuery = encodeURIComponent(`emails.primaryEmail[eq]:${email}`);
    let person = (await api(`/rest/people?filter=${personQuery}&limit=1`)).data?.people?.[0];
    const personFields: Record<string, unknown> = {
      name: { firstName, lastName },
      emails: { primaryEmail: email, additionalEmails: [] },
      jobTitle,
      companyId: company?.id,
    };
    const phoneDigits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (phoneDigits.length === 10) {
      personFields.phones = {
        primaryPhoneNumber: phoneDigits,
        primaryPhoneCountryCode: 'US',
        primaryPhoneCallingCode: '+1',
        additionalPhones: [],
      };
    }
    if (person) {
      person = (await api(`/rest/people/${person.id}`, { method: 'PATCH', body: JSON.stringify(personFields) })).data?.updatePerson;
    } else {
      person = (await api('/rest/people', { method: 'POST', body: JSON.stringify(personFields) })).data?.createPerson;
    }

    const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
    const noteText = [
      `Business intake submitted ${submittedAt} ET`,
      `What the business does:\n${businessDescription}`,
      `Primary goal:\n${mainGoal}`,
      biggestChallenge && `Biggest challenge:\n${biggestChallenge}`,
      teamSize && `Team size: ${teamSize}`,
      interests.length && `Areas of interest: ${interests.join(', ')}`,
      preferredContact && `Preferred contact method: ${preferredContact}`,
    ].filter(Boolean).join('\n\n');

    const note = (await api('/rest/notes', {
      method: 'POST', body: JSON.stringify({ title: `Business intake — ${companyName}`, bodyV2: richText(noteText) }),
    })).data?.createNote;
    if (note?.id && person?.id) {
      await api('/rest/noteTargets', { method: 'POST', body: JSON.stringify({ noteId: note.id, targetPersonId: person.id }) });
    }
    if (note?.id && company?.id) {
      await api('/rest/noteTargets', { method: 'POST', body: JSON.stringify({ noteId: note.id, targetCompanyId: company.id }) });
    }

    // Keep follow-up visible in Twenty. This is intentionally best-effort so a mail or task outage never loses the intake.
    try {
      await api('/rest/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: `Review new intake — ${companyName}`,
          bodyV2: richText(`New business profile submitted by ${firstName} ${lastName} (${email}). Review the intake note and follow up within one business day.`),
          status: 'TODO',
          dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          personId: person?.id,
          companyId: company?.id,
        }),
      });
    } catch (taskError) {
      console.error('Business intake task creation failed', taskError);
    }

    const contactName = `${firstName} ${lastName}`.trim();
    const thankYouText = `Hi ${firstName},\n\nThank you for sharing a little about ${companyName}. We received your information and will review it before following up with thoughtful next steps.\n\nNinth & Oak\nRooted in Experience. Built for What’s Next.`;
    const internalText = `New business profile submitted.\n\nContact: ${contactName}\nEmail: ${email}\nCompany: ${companyName}\nPhone: ${phone || 'Not provided'}\n\nOpen the CRM to review the new company, person, note, and follow-up task.`;
    try {
      await Promise.all([
        sendBrandedEmail([email], 'Thank you for reaching out to Ninth & Oak', brandedEmail(`Thank you, ${escapeHtml(firstName)}.`, `<p>We received your business profile for <strong>${escapeHtml(companyName)}</strong>.</p><p>We’ll review what you shared and follow up with thoughtful next steps.</p><p>We look forward to learning more.</p>`), thankYouText),
        sendBrandedEmail([process.env.CRM_NOTIFICATION_EMAIL || 'Jason@NinthandOak.com'], `New business profile: ${companyName}`, brandedEmail('New business profile received', `<p><strong>${escapeHtml(contactName)}</strong> submitted a profile for <strong>${escapeHtml(companyName)}</strong>.</p><p>${escapeHtml(email)}${phone ? ` · ${escapeHtml(phone)}` : ''}</p>`, 'Open CRM', 'https://crm.ninthandoak.com/welcome'), internalText),
      ]);
    } catch (mailError) {
      console.error('Business intake email notification failed', mailError);
    }

    return json({ ok: true });
  } catch (error) {
    console.error('Business intake failed', error);
    return json({ error: 'We could not save the form. Please try again or call 727-416-1509.' }, 500);
  }
};

export const config: Config = { path: '/api/business-intake' };
