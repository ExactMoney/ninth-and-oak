create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  title text not null,
  message text not null default '',
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'draft' check (status in ('draft','sent','paid','expired','cancelled')),
  payment_url text,
  stripe_payment_link_id text unique,
  expires_at timestamptz,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.proposals enable row level security;
create index if not exists proposals_contact_id_idx on public.proposals(contact_id);
create policy "CRM members can manage proposals" on public.proposals for all to authenticated
using (exists (select 1 from public.crm_members m where m.user_id = (select auth.uid()) and m.active = true))
with check (exists (select 1 from public.crm_members m where m.user_id = (select auth.uid()) and m.active = true));
