alter table public.email_messages add column if not exists read_at timestamptz;

create or replace function public.record_inbound_email(
  p_secret text,
  p_provider_message_id text,
  p_from text,
  p_to text[],
  p_subject text,
  p_text_body text,
  p_received_at timestamptz default now()
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_contact_id uuid;
  v_thread_id uuid;
  v_message_id uuid;
  v_email text;
  v_subject text;
begin
  if not private.valid_integration_secret(p_secret) then
    raise exception 'invalid integration secret';
  end if;

  v_email := lower(trim(regexp_replace(p_from, '^.*<([^>]+)>.*$', '\1')));
  v_subject := coalesce(nullif(trim(regexp_replace(coalesce(p_subject, ''), '^(re:|fwd:)\s*', '', 'i')), ''), '(No subject)');

  select id into v_contact_id from public.contacts
  where lower(email) = v_email order by created_at desc limit 1;

  if v_contact_id is null then
    insert into public.contacts(first_name,last_name,email,source,status)
    values (split_part(v_email,'@',1),'',v_email,'email','lead')
    returning id into v_contact_id;
  end if;

  select id into v_thread_id from public.email_threads
  where contact_id = v_contact_id and lower(subject) = lower(v_subject)
  order by last_message_at desc limit 1;

  if v_thread_id is null then
    insert into public.email_threads(contact_id,subject,last_message_at)
    values(v_contact_id,v_subject,p_received_at)
    returning id into v_thread_id;
  else
    update public.email_threads set last_message_at = p_received_at where id = v_thread_id;
  end if;

  insert into public.email_messages(
    thread_id,contact_id,direction,from_address,to_addresses,subject,text_body,
    provider_message_id,delivery_status,sent_at,read_at
  ) values (
    v_thread_id,v_contact_id,'inbound',p_from,p_to,coalesce(nullif(trim(p_subject),''),'(No subject)'),
    p_text_body,p_provider_message_id,'received',p_received_at,null
  )
  on conflict(provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select id into v_message_id from public.email_messages
    where provider_message_id = p_provider_message_id;
    return v_message_id;
  end if;

  insert into public.activities(contact_id,activity_type,summary,details,occurred_at)
  values(v_contact_id,'email','Inbound email: '||coalesce(nullif(trim(p_subject),''),'(No subject)'),p_text_body,p_received_at);

  insert into public.tasks(contact_id,title,due_at,status,priority)
  values(v_contact_id,'Review reply: '||v_subject,p_received_at + interval '1 day','open','high');

  return v_message_id;
end;
$function$;

revoke all on function public.record_inbound_email(text,text,text,text[],text,text,timestamptz)
  from public, authenticated;
grant execute on function public.record_inbound_email(text,text,text,text[],text,text,timestamptz)
  to anon;
