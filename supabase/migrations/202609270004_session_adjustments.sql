-- Manual review/application AFTER 003. Append-only corrections; no historical data migration.
begin;
create table public.pos_session_adjustments (
  sequence bigint generated always as identity primary key,
  request_id uuid not null unique,
  actor text not null,
  created_at timestamptz not null default now(),
  reason text not null check (length(trim(reason)) > 0),
  action text not null check (action in ('move','cancel','window')),
  session_id uuid not null references public.pos_sales_sessions(id) on delete restrict,
  destination_id uuid references public.pos_sales_sessions(id) on delete restrict,
  order_id uuid references public.pos_orders(id) on delete restrict,
  payload jsonb not null,
  before_data jsonb not null
);
alter table public.pos_session_adjustments enable row level security;
revoke all on public.pos_session_adjustments from public,anon,authenticated;
grant select on public.pos_session_adjustments to authenticated;
create policy session_adjustments_read on public.pos_session_adjustments for select to authenticated using(public.pos_cash_allowed());

create function public.pos_session_adjustment(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  actor text := lower(coalesce(auth.jwt()->>'email',''));
  a text := payload->>'action'; why text := trim(payload->>'reason');
  s public.pos_sales_sessions; destination public.pos_sales_sessions; o public.pos_orders;
  previous public.pos_session_adjustments; latest public.pos_session_adjustments; result public.pos_session_adjustments;
  effective_sid uuid; prior jsonb; normalized jsonb; opened timestamptz; closed timestamptz; business_day date;
begin
  if actor='' or not public.pos_cash_allowed(true) then raise exception 'Solo superadmin puede registrar ajustes'; end if;
  if request_id is null or payload is null or why is null or why='' then raise exception 'Indica un motivo para el ajuste'; end if;
  perform pg_advisory_xact_lock(9272026,1);
  select * into previous from public.pos_session_adjustments x where x.request_id=pos_session_adjustment.request_id;
  if found then
    if previous.actor<>actor or previous.payload<>payload then raise exception 'Solicitud ya utilizada con otros datos'; end if;
    return to_jsonb(previous);
  end if;
  if a in ('move','cancel') then
    select * into o from public.pos_orders where id=(payload->>'order_id')::uuid for update;
    if not found or o.closed_at is null then raise exception 'Selecciona una cuenta cerrada'; end if;
    if o.financial_status='cancelled' or exists(select 1 from public.pos_session_adjustments where order_id=o.id and action='cancel') then
      raise exception 'La venta ya esta anulada';
    end if;
    if exists(select 1 from public.pos_payments where order_id=o.id and status='pending') then raise exception 'Resuelve los pagos pendientes antes del ajuste'; end if;
    if exists(select 1 from public.pos_payments where order_id=o.id and sales_session_id is distinct from o.sales_session_id) then
      raise exception 'Cuenta y pagos tienen jornadas inconsistentes. Requieren revision';
    end if;
    select * into latest from public.pos_session_adjustments where order_id=o.id and action='move' order by sequence desc limit 1;
    effective_sid := coalesce(latest.destination_id,o.sales_session_id);
    if effective_sid is distinct from (payload->>'session_id')::uuid then raise exception 'La cuenta cambio de jornada. Recarga el reporte'; end if;
    prior := jsonb_build_object('order',to_jsonb(o),'effective_session_id',effective_sid,
      'items',(select coalesce(jsonb_agg(i),'[]') from public.pos_order_items i where order_id=o.id),
      'payments',(select coalesce(jsonb_agg(p),'[]') from public.pos_payments p where order_id=o.id));
  elsif a='window' then
    effective_sid := (payload->>'session_id')::uuid;
    opened := (payload->>'opened_at')::timestamptz; closed := (payload->>'closed_at')::timestamptz;
    business_day := (payload->>'business_date')::date;
    if opened is null or closed is null or not isfinite(opened) or not isfinite(closed) or closed<=opened or business_day is null or not isfinite(business_day) or nullif(trim(payload->>'session_label'),'') is null then
      raise exception 'Fecha, nombre y periodo de jornada invalidos';
    end if;
  else raise exception 'Ajuste desconocido'; end if;
  select * into s from public.pos_sales_sessions where id=effective_sid for update;
  if not found or s.status<>'closed' then raise exception 'Los ajustes requieren jornadas cerradas'; end if;
  if a='move' then
    select * into destination from public.pos_sales_sessions where id=(payload->>'destination_id')::uuid for update;
    if not found or destination.status<>'closed' or destination.id=s.id then raise exception 'Selecciona otra jornada cerrada como destino'; end if;
  end if;
  if a='window' then
    select * into latest from public.pos_session_adjustments where session_id=s.id and action='window' order by sequence desc limit 1;
    prior := jsonb_build_object('session',to_jsonb(s),'previous_adjustment',to_jsonb(latest));
  end if;
  insert into public.pos_session_adjustments(request_id,actor,reason,action,session_id,destination_id,order_id,payload,before_data)
    values(request_id,actor,why,a,s.id,destination.id,o.id,payload,prior) returning * into result;
  return to_jsonb(result);
end;
$$;
revoke all on function public.pos_session_adjustment(uuid,jsonb) from public,anon;
grant execute on function public.pos_session_adjustment(uuid,jsonb) to authenticated;

create function public.pos_session_report_v2() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.pos_cash_allowed() then raise exception 'Acceso denegado al reporte financiero'; end if;
  return public.pos_session_report() || jsonb_build_object('adjustments',
    (select coalesce(jsonb_agg(a order by sequence),'[]') from public.pos_session_adjustments a));
end;
$$;
revoke all on function public.pos_session_report_v2() from public,anon;
grant execute on function public.pos_session_report_v2() to authenticated;

-- Once corrected, original rows cannot be edited by legacy operations, even without a cash snapshot.
create function public.pos_adjusted_record_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare sid uuid; oid uuid;
begin
  perform pg_advisory_xact_lock(9272026,1);
  if tg_table_name='pos_session_adjustments' then raise exception 'Los ajustes son inmutables'; end if;
  if tg_table_name='pos_sales_sessions' then
    sid := old.id;
  elsif tg_table_name='pos_orders' then
    oid := old.id; sid := old.sales_session_id;
  else
    oid := coalesce((to_jsonb(old)->>'order_id')::uuid,(to_jsonb(new)->>'order_id')::uuid);
    select sales_session_id into sid from public.pos_orders where id=oid;
  end if;
  if exists(select 1 from public.pos_session_adjustments a where a.session_id=sid or a.destination_id=sid or a.order_id=oid)
    or exists(select 1 from public.pos_orders o join public.pos_session_adjustments a on a.order_id=o.id or a.session_id=o.sales_session_id or a.destination_id=o.sales_session_id
      where o.id=(to_jsonb(new)->>'order_id')::uuid)
    or exists(select 1 from public.pos_session_adjustments a where a.session_id=(to_jsonb(new)->>'sales_session_id')::uuid or a.destination_id=(to_jsonb(new)->>'sales_session_id')::uuid) then
    raise exception 'Esta jornada tiene ajustes. Usa el reporte para registrar otra correccion';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.pos_adjusted_record_guard() from public,anon,authenticated;
create trigger pos_adjusted_record_guard before update or delete on public.pos_session_adjustments for each row execute function public.pos_adjusted_record_guard();
create trigger pos_adjusted_record_guard before update or delete on public.pos_sales_sessions for each row execute function public.pos_adjusted_record_guard();
create trigger pos_adjusted_record_guard before insert or update or delete on public.pos_orders for each row execute function public.pos_adjusted_record_guard();
create trigger pos_adjusted_record_guard before insert or update or delete on public.pos_order_items for each row execute function public.pos_adjusted_record_guard();
create trigger pos_adjusted_record_guard before insert or update or delete on public.pos_payments for each row execute function public.pos_adjusted_record_guard();
commit;
