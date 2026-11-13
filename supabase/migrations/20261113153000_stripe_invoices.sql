alter table public.contacts add column if not exists stripe_customer_id text unique;
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(), contact_id uuid not null references public.contacts(id) on delete cascade,
  proposal_id uuid references public.proposals(id) on delete set null, title text not null,
  amount_cents integer not null check (amount_cents > 0), status text not null default 'draft' check (status in ('draft','open','paid','void','uncollectible')),
  stripe_invoice_id text unique, hosted_invoice_url text, due_at timestamptz,
  created_by uuid references auth.users(id) default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.invoices enable row level security;
create policy "CRM members can manage invoices" on public.invoices for all to authenticated
using (exists (select 1 from public.crm_members m where m.user_id = (select auth.uid()) and m.active = true))
with check (exists (select 1 from public.crm_members m where m.user_id = (select auth.uid()) and m.active = true));

create or replace function public.update_stripe_invoice_status(p_secret text, p_stripe_invoice_id text, p_status text)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if not private.valid_integration_secret(p_secret) then raise exception 'invalid integration secret'; end if;
  update public.invoices set status = p_status, updated_at = now() where stripe_invoice_id = p_stripe_invoice_id;
end;
$function$;
revoke all on function public.update_stripe_invoice_status(text,text,text) from public, authenticated;
grant execute on function public.update_stripe_invoice_status(text,text,text) to anon;
