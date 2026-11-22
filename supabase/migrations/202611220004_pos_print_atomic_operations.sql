-- 004: atomic preparation tickets, active-session claims, and cash close purge.

create or replace function public.claim_pos_preparation_print_job(station_id uuid, active_session_id uuid)
returns setof public.pos_preparation_print_jobs
language plpgsql security invoker set search_path = public as $$
declare job public.pos_preparation_print_jobs;
begin
  perform 1 from public.pos_sales_sessions where id=active_session_id and status='open' for update;
  if not found then return; end if;
  select j.* into job from public.pos_preparation_print_jobs j
  where j.sales_session_id=active_session_id and (j.status='pending' or (j.status='claimed' and j.claimed_at < now()-interval '5 minutes'))
  order by j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.pos_preparation_print_jobs set status='claimed',claimed_by_station_id=station_id,claimed_at=now(),error_message=null
  where id=job.id returning * into job;
  return next job;
end;
$$;
grant execute on function public.claim_pos_preparation_print_job(uuid,uuid) to authenticated;
revoke execute on function public.claim_pos_preparation_print_job(uuid) from authenticated;

create or replace function public.send_pos_drafts_with_print_jobs(p_order_id uuid, p_session_id uuid, actor_email text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare ord public.pos_orders; sent jsonb; area text; snapshot jsonb; key text;
begin
  select * into ord from public.pos_orders where id=p_order_id for update;
  if not found then raise exception 'Pedido inexistente'; end if;
  perform 1 from public.pos_sales_sessions where id=p_session_id and status='open' for update;
  if not found then raise exception 'La jornada debe estar abierta'; end if;
  if ord.sales_session_id is distinct from p_session_id then raise exception 'El pedido no pertenece a la jornada activa'; end if;
  with updated as (
    update public.pos_order_items set operational_status='pending_preparation',sent_at=now(),updated_by_email=actor_email
    where order_id=p_order_id and operational_status='draft' returning *
  ) select jsonb_agg(to_jsonb(updated.*)) into sent from updated;
  if sent is null then raise exception 'No hay lineas en borrador para enviar a preparación'; end if;
  for area in select distinct x->>'prep_area' from jsonb_array_elements(sent) x loop
    select jsonb_build_object('area',area,'createdAt',now(),'orderId',ord.id,'orderNumber',upper(left(ord.id::text,4)),
      'server',coalesce(ord.assigned_staff_email,ord.opened_by_email),'table',coalesce(ord.table_code_snapshot,'—'),
      'items',jsonb_agg(jsonb_build_object('id',x->>'id','name',x->>'product_name','notes',coalesce(x->>'notes',''),'quantity',(x->>'quantity')::int)))
    into snapshot from jsonb_array_elements(sent) x where x->>'prep_area'=area;
    select 'preparation:'||ord.id||':'||area||':'||string_agg(x->>'id',',' order by x->>'id') into key from jsonb_array_elements(sent) x where x->>'prep_area'=area;
    insert into public.pos_preparation_print_jobs(order_id,sales_session_id,preparation_area,dedupe_key,ticket_snapshot)
    values(ord.id,p_session_id,area,key,snapshot) on conflict(dedupe_key) do nothing;
  end loop;
  return sent;
end;
$$;
grant execute on function public.send_pos_drafts_with_print_jobs(uuid,uuid,text) to authenticated;

create or replace function public.pos_cash_close_and_purge(request_id uuid, payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb; sid uuid := (payload->>'session')::uuid;
begin
  result := public.pos_cash_command(request_id,payload);
  delete from public.pos_preparation_print_jobs where sales_session_id=sid;
  return result;
end;
$$;
grant execute on function public.pos_cash_close_and_purge(uuid,jsonb) to authenticated;
