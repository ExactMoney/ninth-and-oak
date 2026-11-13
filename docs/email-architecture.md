# Ninth & Oak email architecture

## Recommended setup

Use two separate email lanes so the human mailbox and CRM automation do not compete for the root domain's MX records.

1. **Zoho Mail on `ninthandoak.com`**
   - Human inboxes: `hello@ninthandoak.com`, plus named addresses as needed.
   - Zoho supplies the exact MX, SPF, DKIM, and verification records for the account's data center.
   - Netlify remains the DNS host; email hosting does not move the website.

2. **Resend on `mail.ninthandoak.com`**
   - CRM outbound messages and delivery events.
   - Inbound replies arrive through a Resend webhook and are written to `email_threads` and `email_messages` in Supabase.
   - The subdomain isolates automated delivery reputation and avoids conflicting with Zoho's root-domain MX records.

3. **Netlify Forms on the public website**
   - Keep the existing consultation form.
   - Add an email notification for immediate visibility and a form webhook to create or update a CRM contact.

## DNS plan

Do not copy generic DNS values into production. Create the Zoho and Resend accounts first, then use the exact records each dashboard issues.

- Root (`@`): Zoho verification, MX, SPF, DKIM and DMARC.
- `mail`: Resend SPF/DKIM records and inbound MX records.
- Start DMARC in reporting mode, review reports, then tighten the policy after all legitimate senders pass.

## Secrets

- Store the Resend API key and webhook signing secret only in Netlify environment variables.
- Never expose either value in `PUBLIC_*` variables or browser JavaScript.
- Supabase's publishable key is intentionally public; database access remains protected by Auth and RLS.

## CRM email flow

Outbound: CRM composer → Netlify Function → Resend → recipient → delivery event webhook → Supabase.

Inbound: recipient reply → `mail.ninthandoak.com` → Resend inbound webhook → signature verification → Supabase thread/contact match.

