-- Incremental upgrade AFTER 202609270001_cash_management.sql. Manual review/application.
-- No backfill: no UPDATE of existing sessions, payments, bases or reconciliations.
begin;

create function public.pos_sales_cutoff_hour() returns integer
language sql immutable set search_path = public as $$ select 6; $$;

create function public.pos_sales_business_date(at_time timestamptz default now()) returns date
language sql stable set search_path = public as $$
  select ((at_time at time zone 'America/Bogota') - make_interval(hours => public.pos_sales_cutoff_hour()))::date;
$$;

create function public.pos_validate_operational_date(requested_date date, at_time timestamptz default now()) returns date
language plpgsql stable set search_path = public as $$
declare today date := (at_time at time zone 'America/Bogota')::date;
begin
  if requested_date is null or requested_date not in (today, today - 1) then
    raise exception 'La fecha de la jornada debe ser hoy o ayer en America/Bogota. Para fechas anteriores usa el flujo histórico.';
  end if;
  return requested_date;
end;
$$;

alter table public.pos_sales_sessions alter column cutoff_hour set default public.pos_sales_cutoff_hour();

-- Cover direct INSERT as well as RPC, but preserve the existing closed-history workflow.
create function public.pos_validate_new_operational_session() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'open' then
    new.business_date := public.pos_validate_operational_date(new.business_date);
    new.cutoff_hour := public.pos_sales_cutoff_hour();
    new.opened_at := now();
    new.created_at := now();
    new.opened_by_email := lower(coalesce(auth.jwt()->>'email',''));
    if new.opened_by_email = '' then raise exception 'Se requiere una sesión autenticada'; end if;
  end if;
  return new;
end;
$$;
create trigger pos_validate_new_operational_session before insert on public.pos_sales_sessions
for each row execute function public.pos_validate_new_operational_session();

-- Shared atomic creation path. The no-argument RPC for POS remains compatible.
create function public.pos_cash_get_or_create_session(requested_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.pos_sales_sessions; business_day date;
begin
  if not public.is_pos_staff() then raise exception 'Acceso denegado'; end if;
  if requested_date is not null and not public.pos_cash_allowed() then raise exception 'Solo administración o caja puede elegir la fecha'; end if;
  perform pg_advisory_xact_lock(9272026, 1);
  if (select count(*) from public.pos_sales_sessions where status='open') > 1 then
    raise exception 'Hay varias jornadas abiertas. Revisión manual necesaria; no se modificaron datos.';
  end if;
  select * into s from public.pos_sales_sessions where status='open';
  if s.id is not null then
    if requested_date is not null and requested_date <> s.business_date then
      raise exception 'Ya existe una jornada abierta con otra fecha. Actualiza la pantalla; su fecha se conserva.';
    end if;
    return to_jsonb(s);
  end if;
  business_day := public.pos_validate_operational_date(coalesce(requested_date, public.pos_sales_business_date()));
  insert into public.pos_sales_sessions(session_label,business_date,opened_by_email,cutoff_hour)
    values('Jornada '||business_day,business_day,lower(auth.jwt()->>'email'),public.pos_sales_cutoff_hour()) returning * into s;
  insert into public.pos_order_status_logs(event_type,actor_email,after_data,notes)
    values('sales_session_opened',lower(auth.jwt()->>'email'),to_jsonb(s),'Jornada abierta: '||s.session_label);
  -- No cash register row here. Orders and payments can proceed without an initial base.
  return to_jsonb(s);
end;
$$;

create or replace function public.pos_cash_ensure_session() returns jsonb
language sql security definer set search_path = public as $$
  select public.pos_cash_get_or_create_session();
$$;

create or replace function public.pos_cash_command(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor text := lower(auth.jwt()->>'email'); action text := payload->>'action';
  sid uuid := (payload->>'session')::uuid; s public.pos_sales_sessions;
  c public.pos_cash_registers; m public.pos_cash_movements; previous public.pos_cash_audit;
  result jsonb; v_components jsonb; v_expected numeric; amount numeric; summary_payload jsonb;
begin
  if not public.pos_cash_allowed() then raise exception 'Acceso denegado a caja'; end if;
  if request_id is null or payload is null then raise exception 'Solicitud inválida'; end if;
  perform pg_advisory_xact_lock(9272026, 1);
  select * into previous from public.pos_cash_audit a where a.request_id=pos_cash_command.request_id;
  if found then
    if previous.actor <> actor or previous.payload <> payload then raise exception 'La solicitud ya existe con otros datos'; end if;
    return previous.result;
  end if;
  if action='open' and sid is null then sid := (public.pos_cash_get_or_create_session((payload->>'business_date')::date)->>'id')::uuid; end if;
  if action='void' then
    if not public.pos_cash_allowed(true) then raise exception 'Solo superadmin puede anular'; end if;
    select * into m from public.pos_cash_movements where id=(payload->>'movement')::uuid;
    if not found or m.voided_at is not null then raise exception 'Movimiento inexistente o ya anulado'; end if;
    sid := m.sales_session_id;
  end if;
  if sid is not null then
    select * into s from public.pos_sales_sessions where id=sid for update;
    if not found or s.status <> 'open' then raise exception 'La jornada debe estar abierta'; end if;
    if action='open' and payload->>'business_date' is not null and (payload->>'business_date')::date <> s.business_date then
      raise exception 'La fecha de una jornada existente no se puede cambiar al completar la base';
    end if;
    select * into c from public.pos_cash_registers where sales_session_id=sid;
    if c.closed_at is not null then raise exception 'Caja cerrada'; end if;
  end if;
  if action in ('open','movement','close') then
    amount := (payload->>'amount')::numeric;
    if amount is null or amount::text in ('NaN','Infinity','-Infinity') or amount < 0 or amount >= 1000000000000 or amount <> round(amount,2) then
      raise exception 'Importe inválido: máximo dos decimales';
    end if;
  end if;
  if action='open' then
    if c.sales_session_id is not null then raise exception 'La base inicial ya está registrada'; end if;
    insert into public.pos_cash_registers(sales_session_id,opening_amount,opened_by,opening_notes)
      values(sid,amount,actor,coalesce(payload->>'notes','')) returning to_jsonb(pos_cash_registers.*) into result;
  elsif action='movement' then
    if sid is not null and c.sales_session_id is null then raise exception 'Registra primero la base inicial'; end if;
    insert into public.pos_cash_movements(id,sales_session_id,kind,concept,category,amount,expense_date,method,origin,notes,created_by)
      values(request_id,sid,payload->>'kind',trim(payload->>'concept'),payload->>'category',amount,
        (payload->>'date')::date,payload->>'method',payload->>'origin',coalesce(payload->>'notes',''),actor)
      returning to_jsonb(pos_cash_movements.*) into result;
  elsif action='void' then
    if nullif(trim(payload->>'reason'),'') is null then raise exception 'Indica el motivo de anulación'; end if;
    update public.pos_cash_movements set voided_at=now(),voided_by=actor,void_reason=payload->>'reason' where id=m.id
      returning to_jsonb(pos_cash_movements.*) into result;
  elsif action='close' then
    if c.sales_session_id is null then raise exception 'Registra primero la base inicial'; end if;
    -- Do not silently reassign legacy accounts inferred from payments.
    if exists(select 1 from public.pos_payments p join public.pos_orders o on o.id=p.order_id
      where (p.sales_session_id=sid or o.sales_session_id=sid) and p.sales_session_id is distinct from o.sales_session_id) then
      raise exception 'Hay pagos y cuentas asociados a jornadas diferentes. Se requiere revisión; no se reasignaron registros.';
    end if;
    if exists(select 1 from public.pos_payments where sales_session_id=sid and status='pending') or exists(
      select 1 from public.pos_orders o where o.sales_session_id=sid and (o.closed_at is null or
        coalesce((select sum(total_price) from public.pos_order_items where order_id=o.id and operational_status <> 'cancelled' and financial_status <> 'cancelled'),0)
        > coalesce((select sum(amount_applied) from public.pos_payments where order_id=o.id and status='confirmed'),0))) then
      raise exception 'Cierra las cuentas y resuelve saldos y pagos por confirmar antes del arqueo';
    end if;
    v_components := public.pos_cash_components(sid);
    v_expected := (v_components->>'opening')::numeric + (v_components->>'cash')::numeric + (v_components->>'contributions')::numeric
      - (v_components->>'expenses')::numeric - (v_components->>'withdrawals')::numeric;
    if v_expected <> (payload->>'expected')::numeric or payload->>'expected' is null then
      raise exception 'Los componentes cambiaron. Actualiza y revisa el arqueo antes de cerrar';
    end if;
    if amount <> v_expected and nullif(trim(payload->>'reason'),'') is null then raise exception 'Explica el sobrante o faltante'; end if;
    summary_payload := public.pos_cash_sales_summary(sid);
    update public.pos_cash_registers set closed_at=now(),closed_by=actor,counted=amount,expected=v_expected,
      difference=amount-v_expected,closing_notes=coalesce(payload->>'notes',''),difference_reason=payload->>'reason',components=v_components
      where sales_session_id=sid returning to_jsonb(pos_cash_registers.*) into result;
    update public.pos_sales_sessions set status='closed',closed_at=now(),closed_by_email=actor,summary=summary_payload where id=sid;
    -- Operational log deliberately omits the new private cash amounts; those live in cash_audit.
    insert into public.pos_order_status_logs(event_type,actor_email,after_data,notes)
      values('sales_session_closed',actor,jsonb_build_object('sales_session_id',sid),'Jornada cerrada: '||s.session_label);
  else raise exception 'Operación desconocida'; end if;
  insert into public.pos_cash_audit(request_id,actor,payload,result) values(request_id,actor,payload,result);
  return result;
end;
$$;



-- A version-specific entry point prevents an old QA database from silently ignoring
-- the new manual date field. Missing migration produces an error, not a wrong date.
create function public.pos_cash_open(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if payload->>'action' is distinct from 'open' then raise exception 'Operación de apertura requerida'; end if;
  return public.pos_cash_command(request_id,payload);
end;
$$;

revoke all on function public.pos_cash_get_or_create_session(date), public.pos_validate_operational_date(date,timestamptz), public.pos_validate_new_operational_session() from public,anon,authenticated;
revoke all on function public.pos_sales_cutoff_hour(), public.pos_sales_business_date(timestamptz), public.pos_cash_open(uuid,jsonb) from public,anon;
grant execute on function public.pos_sales_cutoff_hour(), public.pos_sales_business_date(timestamptz), public.pos_cash_open(uuid,jsonb) to authenticated;
commit;
