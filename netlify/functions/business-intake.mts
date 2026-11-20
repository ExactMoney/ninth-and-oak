import type { Config } from '@netlify/functions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const clean = (value: unknown, max = 500) => String(value || '').trim().slice(0, max);

function richText(value: string) {
  return { markdown: value };
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

    return json({ ok: true });
  } catch (error) {
    console.error('Business intake failed', error);
    return json({ error: 'We could not save the form. Please try again or call 727-416-1509.' }, 500);
  }
};

export const config: Config = { path: '/api/business-intake' };
