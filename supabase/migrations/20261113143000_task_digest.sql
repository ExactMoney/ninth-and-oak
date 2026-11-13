create or replace function public.get_task_digest(p_secret text)
returns table(title text, due_at timestamptz, priority text, contact_name text)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_integration_secret(p_secret) then raise exception 'invalid integration secret'; end if;
  return query
    select t.title, t.due_at, t.priority,
      nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')
    from public.tasks t
    left join public.contacts c on c.id = t.contact_id
    where t.status in ('open','in_progress')
    order by (t.due_at is null), t.due_at nulls last, t.priority desc, t.created_at
    limit 25;
end;
$function$;

revoke all on function public.get_task_digest(text) from public, authenticated;
grant execute on function public.get_task_digest(text) to anon;
