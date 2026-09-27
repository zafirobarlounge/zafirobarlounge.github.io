-- REVIEW BEFORE APPLICATION. No backfill and no existing-row transformations.
-- Apply once, after pos-schema.sql, in a reviewed maintenance window.
begin;

create function public.pos_cash_allowed(admin_only boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->>'email','') <> '' and (
    public.is_catalog_admin() or (exists (
      select 1 from public.staff_profiles where lower(email)=lower(auth.jwt()->>'email') and is_active
    ) and (public.has_staff_role('superadmin') or (not admin_only and public.has_staff_role('cashier'))))
  );
$$;

create table public.pos_cash_registers (
  sales_session_id uuid primary key references public.pos_sales_sessions(id) on delete restrict,
  opening_amount numeric(14,2) not null check (opening_amount >= 0 and opening_amount < 1000000000000),
  opened_at timestamptz not null default now(),
  opened_by text not null,
  opening_notes text not null default '',
  closed_at timestamptz,
  closed_by text,
  counted numeric(14,2),
  expected numeric(14,2),
  difference numeric(14,2),
  closing_notes text,
  difference_reason text,
  components jsonb,
  check (closed_at is null or (closed_by is not null and counted >= 0 and expected is not null
    and difference = counted - expected and components is not null
    and (difference = 0 or length(trim(difference_reason)) > 0)))
);

create table public.pos_cash_movements (
  id uuid primary key,
  sales_session_id uuid references public.pos_sales_sessions(id) on delete restrict,
  kind text not null check (kind in ('expense','contribution','withdrawal')),
  concept text not null check (length(trim(concept)) between 1 and 500),
  category text check (category in ('personal','supplies','rent','utilities','transport','maintenance','other')),
  amount numeric(14,2) not null check (amount > 0 and amount < 1000000000000),
  expense_date date not null,
  method text not null check (method in ('cash','nequi','bank_transfer','card','other')),
  origin text not null check (origin in ('register','business','owner')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  check ((kind = 'expense' and category is not null) or (kind <> 'expense' and category is null and origin = 'register')),
  check (origin <> 'register' or (method = 'cash' and sales_session_id is not null)),
  check (voided_at is null or (voided_by is not null and length(trim(void_reason)) > 0))
);
create index pos_cash_movements_session on public.pos_cash_movements(sales_session_id);
create index pos_cash_movements_date on public.pos_cash_movements(expense_date);

-- A request UUID and exact payload make network retries idempotent, including opening/closing.
create table public.pos_cash_audit (
  request_id uuid primary key,
  actor text not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null,
  result jsonb not null
);

alter table public.pos_cash_registers enable row level security;
alter table public.pos_cash_movements enable row level security;
alter table public.pos_cash_audit enable row level security;
create policy cash_read on public.pos_cash_registers for select to authenticated using (public.pos_cash_allowed());
create policy cash_read on public.pos_cash_movements for select to authenticated using (public.pos_cash_allowed());
create policy cash_read on public.pos_cash_audit for select to authenticated using (public.pos_cash_allowed());
revoke all on public.pos_cash_registers, public.pos_cash_movements, public.pos_cash_audit from anon, authenticated;
grant select on public.pos_cash_registers, public.pos_cash_movements, public.pos_cash_audit to authenticated;

-- All affected POS writes and cash commands take the same transaction lock. Deliberately
-- coarse for one venue: avoids a payment/line/account racing with a closing snapshot.
create function public.pos_cash_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare old_sid uuid; new_sid uuid; sid uuid;
begin
  perform pg_advisory_xact_lock(9272026, 1);
  if tg_table_name = 'pos_sales_sessions' then
    if tg_op <> 'INSERT' then old_sid := old.id; end if;
    if tg_op <> 'DELETE' then new_sid := new.id; end if;
    if tg_op = 'INSERT' and new.status = 'open' and exists(select 1 from public.pos_sales_sessions where status='open') then
      raise exception 'Ya existe una jornada abierta. Actualiza la pantalla.';
    end if;
    if tg_op = 'UPDATE' and old.status='closed' and new.status='open' then
      raise exception 'No se permite reabrir jornadas históricas.';
    end if;
    if tg_op = 'UPDATE' and old.status='open' and new.status='closed' then
      if not exists(select 1 from public.pos_cash_registers where sales_session_id=old.id and closed_at is not null) then
        raise exception 'Cierra la jornada desde Caja y gastos, registrando el arqueo.';
      end if;
      return new;
    end if;
  elsif tg_table_name = 'pos_order_items' then
    if tg_op <> 'INSERT' then select sales_session_id into old_sid from public.pos_orders where id=old.order_id; end if;
    if tg_op <> 'DELETE' then select sales_session_id into new_sid from public.pos_orders where id=new.order_id; end if;
  else
    if tg_op <> 'INSERT' then old_sid := old.sales_session_id; end if;
    if tg_op <> 'DELETE' then new_sid := new.sales_session_id; end if;
  end if;
  for sid in select distinct x from unnest(array[old_sid,new_sid]) x where x is not null loop
    if exists(select 1 from public.pos_cash_registers where sales_session_id=sid and closed_at is not null) then
      raise exception 'Caja cerrada: no se permite alterar cuentas, pagos, productos ni la jornada.';
    end if;
    if tg_table_name='pos_sales_sessions' and tg_op='DELETE' and (
      exists(select 1 from public.pos_cash_registers where sales_session_id=sid) or
      exists(select 1 from public.pos_cash_movements where sales_session_id=sid)) then
      raise exception 'La jornada tiene registros financieros y no se puede eliminar.';
    end if;
  end loop;
  -- A payment can refer to an account independently of its session column.
  if tg_table_name='pos_payments' then
    if exists(select 1 from public.pos_orders o join public.pos_cash_registers c on c.sales_session_id=o.sales_session_id
      where c.closed_at is not null and o.id in (
        case when tg_op <> 'INSERT' then old.order_id end, case when tg_op <> 'DELETE' then new.order_id end)) then
      raise exception 'La cuenta pertenece a una caja cerrada.';
    end if;
  end if;
  if tg_table_name in ('pos_orders','pos_order_items') then
    if exists(select 1 from public.pos_payments p join public.pos_cash_registers c on c.sales_session_id=p.sales_session_id
      where c.closed_at is not null and p.order_id in (
        case when tg_table_name='pos_orders' then coalesce(to_jsonb(old)->>'id',to_jsonb(new)->>'id')::uuid
             else (to_jsonb(old)->>'order_id')::uuid end,
        case when tg_table_name='pos_orders' then (to_jsonb(new)->>'id')::uuid
             else (to_jsonb(new)->>'order_id')::uuid end)) then
      raise exception 'Caja cerrada: la cuenta tiene pagos incluidos en un arqueo.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger pos_cash_guard before insert or update or delete on public.pos_sales_sessions for each row execute function public.pos_cash_guard();
create trigger pos_cash_guard before insert or update or delete on public.pos_orders for each row execute function public.pos_cash_guard();
create trigger pos_cash_guard before insert or update or delete on public.pos_payments for each row execute function public.pos_cash_guard();
create trigger pos_cash_guard before insert or update or delete on public.pos_order_items for each row execute function public.pos_cash_guard();

create function public.pos_cash_ensure_session() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.pos_sales_sessions; business_day date;
begin
  if not public.is_pos_staff() then raise exception 'Acceso denegado'; end if;
  perform pg_advisory_xact_lock(9272026, 1);
  if (select count(*) from public.pos_sales_sessions where status='open') > 1 then
    raise exception 'Hay varias jornadas abiertas. Revisión manual necesaria; no se modificaron datos.';
  end if;
  select * into s from public.pos_sales_sessions where status='open';
  if s.id is null then
    business_day := ((now() at time zone 'America/Bogota') - interval '18 hours')::date;
    insert into public.pos_sales_sessions(session_label,business_date,opened_by_email)
      values ('Jornada '||business_day, business_day, lower(auth.jwt()->>'email')) returning * into s;
    insert into public.pos_order_status_logs(event_type,actor_email,after_data,notes)
      values('sales_session_opened',lower(auth.jwt()->>'email'),to_jsonb(s),'Jornada abierta: '||s.session_label);
  end if;
  return to_jsonb(s);
end;
$$;

create function public.pos_cash_components(sid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'opening', (select opening_amount from public.pos_cash_registers where sales_session_id=sid),
    'cash', coalesce((select sum(amount_applied) from public.pos_payments where sales_session_id=sid and method='cash' and status='confirmed'),0),
    'contributions', coalesce(sum(amount) filter(where kind='contribution'),0),
    'withdrawals', coalesce(sum(amount) filter(where kind='withdrawal'),0),
    'expenses', coalesce(sum(amount) filter(where kind='expense' and origin='register'),0)
  ) from public.pos_cash_movements where sales_session_id=sid and voided_at is null;
$$;

create function public.pos_cash_sales_summary(target_sales_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare summary_payload jsonb;
begin
  with session_orders as (
    select *
    from public.pos_orders
    where sales_session_id = target_sales_session_id
  ),
  order_totals as (
    select
      o.id,
      o.closed_at,
      coalesce(sum(
        case
          when i.operational_status <> 'cancelled'
            and i.financial_status <> 'cancelled'
          then i.total_price
          else 0
        end
      ), 0) as total_due
    from session_orders o
    left join public.pos_order_items i on i.order_id = o.id
    group by o.id, o.closed_at
  ),
  payment_totals as (
    select
      o.id,
      coalesce(sum(case when p.status = 'confirmed' then p.amount_applied else 0 end), 0) as total_paid,
      count(p.id) filter (where p.status = 'pending') as pending_payments,
      count(p.id) filter (where p.status = 'confirmed') as confirmed_payments
    from session_orders o
    left join public.pos_payments p
      on p.order_id = o.id
      and p.sales_session_id = target_sales_session_id
    group by o.id
  ),
  products as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'menuItemSourceKey', product_rows.menu_item_source_key,
        'prepArea', product_rows.prep_area,
        'productName', product_rows.product_name,
        'quantity', product_rows.quantity,
        'totalAmount', product_rows.total_amount
      )
      order by product_rows.quantity desc, product_rows.total_amount desc
    ), '[]'::jsonb) as products_json
    from (
      select
        i.menu_item_source_key,
        i.prep_area,
        i.product_name,
        sum(i.quantity)::integer as quantity,
        sum(i.total_price) as total_amount
      from session_orders o
      join public.pos_order_items i on i.order_id = o.id
      where i.operational_status <> 'cancelled'
        and i.financial_status <> 'cancelled'
      group by i.menu_item_source_key, i.prep_area, i.product_name
    ) product_rows
  ),
  payment_methods as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'method', method_rows.method,
        'paymentCount', method_rows.payment_count,
        'totalAmount', method_rows.total_amount
      )
      order by method_rows.total_amount desc
    ), '[]'::jsonb) as methods_json
    from (
      select
        p.method,
        count(*)::integer as payment_count,
        sum(p.amount_applied) as total_amount
      from public.pos_payments p
      where p.sales_session_id = target_sales_session_id
        and p.status = 'confirmed'
      group by p.method
    ) method_rows
  )
  select jsonb_build_object(
    'confirmedPayments', coalesce((select sum(confirmed_payments) from payment_totals), 0),
    'deliveredProducts', coalesce((
      select sum(i.quantity)
      from session_orders o
      join public.pos_order_items i on i.order_id = o.id
      where i.operational_status = 'delivered'
        and i.financial_status <> 'cancelled'
    ), 0),
    'grossSales', coalesce((select sum(total_due) from order_totals), 0),
    'openOrders', coalesce((select count(*) from session_orders where closed_at is null), 0),
    'orderCount', coalesce((select count(*) from session_orders), 0),
    'paymentMethods', (select methods_json from payment_methods),
    'pendingBalance', coalesce((
      select sum(greatest(order_totals.total_due - payment_totals.total_paid, 0))
      from order_totals
      join payment_totals on payment_totals.id = order_totals.id
    ), 0),
    'pendingPayments', coalesce((select sum(pending_payments) from payment_totals), 0),
    'products', (select products_json from products),
    'totalCollected', coalesce((select sum(total_paid) from payment_totals), 0)
  )
  into summary_payload;

  return summary_payload;
end;
$$;
revoke all on function public.pos_cash_sales_summary(uuid) from public, anon, authenticated;

create function public.pos_cash_command(request_id uuid, payload jsonb) returns jsonb
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
  if action='open' and sid is null then sid := (public.pos_cash_ensure_session()->>'id')::uuid; end if;
  if action='void' then
    if not public.pos_cash_allowed(true) then raise exception 'Solo superadmin puede anular'; end if;
    select * into m from public.pos_cash_movements where id=(payload->>'movement')::uuid;
    if not found or m.voided_at is not null then raise exception 'Movimiento inexistente o ya anulado'; end if;
    sid := m.sales_session_id;
  end if;
  if sid is not null then
    select * into s from public.pos_sales_sessions where id=sid for update;
    if not found or s.status <> 'open' then raise exception 'La jornada debe estar abierta'; end if;
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

create function public.pos_cash_read() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.pos_cash_allowed() then raise exception 'Acceso denegado a caja'; end if;
  return jsonb_build_object(
    'sessions', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('components', public.pos_cash_components(s.id)) order by s.opened_at desc),'[]') from public.pos_sales_sessions s),
    'registers', (select coalesce(jsonb_agg(c order by opened_at desc),'[]') from public.pos_cash_registers c),
    'movements', (select coalesce(jsonb_agg(m order by created_at desc),'[]') from public.pos_cash_movements m)
  );
end;
$$;

revoke all on function public.pos_cash_guard(), public.pos_cash_components(uuid) from public, anon, authenticated;
revoke all on function public.pos_cash_allowed(boolean), public.pos_cash_ensure_session(), public.pos_cash_command(uuid,jsonb), public.pos_cash_read() from public, anon;
grant execute on function public.pos_cash_allowed(boolean), public.pos_cash_ensure_session(), public.pos_cash_command(uuid,jsonb), public.pos_cash_read() to authenticated;
commit;
