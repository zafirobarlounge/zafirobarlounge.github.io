-- Review and apply manually AFTER 001 and 002. No data updates/backfill.
begin;
create function public.pos_session_report() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.pos_cash_allowed() then raise exception 'Acceso denegado al reporte financiero'; end if;
  return jsonb_build_object(
    'reconciled_session_ids',(select coalesce(jsonb_agg(sales_session_id),'[]') from public.pos_cash_registers where closed_at is not null),
    'sessions',(select coalesce(jsonb_agg(s order by opened_at desc),'[]') from public.pos_sales_sessions s),
    'orders',(select coalesce(jsonb_agg(o),'[]') from public.pos_orders o),
    'payments',(select coalesce(jsonb_agg(p),'[]') from public.pos_payments p),
    'items',(select coalesce(jsonb_agg(i),'[]') from public.pos_order_items i),
    'tables',(select coalesce(jsonb_agg(t),'[]') from public.pos_tables t)
  );
end;
$$;
revoke all on function public.pos_session_report() from public,anon;
grant execute on function public.pos_session_report() to authenticated;

-- Existing staff policies allowed ordinary clients to edit historical records directly.
-- Preserve operational order/payment writes, but gate administrative changes in the DB.
create function public.pos_report_write_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare oid uuid;
begin
  if public.pos_cash_allowed(true) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_table_name='pos_sales_sessions' then
    if tg_op='INSERT' and new.status='open' then return new; end if;
    if tg_op='UPDATE' and old.status='open' and new.status='closed'
      and exists(select 1 from public.pos_cash_registers where sales_session_id=old.id and closed_at is not null)
      and new.business_date=old.business_date and new.opened_at=old.opened_at then return new; end if;
    raise exception 'Solo superadmin puede administrar jornadas';
  elsif tg_table_name='pos_orders' then
    if tg_op <> 'INSERT' then
      if old.closed_at is not null then raise exception 'Solo superadmin puede modificar ventas cerradas'; end if;
      if tg_op='UPDATE' and old.sales_session_id is not null and new.sales_session_id is distinct from old.sales_session_id then
        raise exception 'Solo superadmin puede reasignar cuentas';
      end if;
    end if;
  else
    for oid in select distinct x from unnest(array[(to_jsonb(old)->>'order_id')::uuid,(to_jsonb(new)->>'order_id')::uuid]) x loop
      if exists(select 1 from public.pos_orders where id=oid and closed_at is not null) then
        raise exception 'Solo superadmin puede modificar ventas cerradas';
      end if;
    end loop;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.pos_report_write_guard() from public,anon,authenticated;
create trigger pos_report_write_guard before insert or update or delete on public.pos_sales_sessions for each row execute function public.pos_report_write_guard();
create trigger pos_report_write_guard before insert or update or delete on public.pos_orders for each row execute function public.pos_report_write_guard();
create trigger pos_report_write_guard before insert or update or delete on public.pos_order_items for each row execute function public.pos_report_write_guard();
create trigger pos_report_write_guard before insert or update or delete on public.pos_payments for each row execute function public.pos_report_write_guard();

create or replace function public.delete_pos_sales_session(
  sales_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  target_session public.pos_sales_sessions%rowtype;
  deleted_at timestamptz := timezone('utc', now());
begin
  if actor_email = '' then
    raise exception 'No hay una sesion valida para eliminar jornadas.';
  end if;

  if not public.pos_cash_allowed(true) then
    raise exception 'Solo superadmin puede eliminar jornadas POS.';
  end if;

  select *
  into target_session
  from public.pos_sales_sessions
  where id = sales_session_id
  for update;

  if not found then
    raise exception 'No se encontro la jornada indicada.';
  end if;

  if target_session.status = 'open' then
    raise exception 'No puedes eliminar una jornada abierta. Cierrala primero.';
  end if;

  insert into public.pos_order_status_logs (
    actor_email,
    actor_role,
    before_data,
    event_type,
    notes
  )
  values (
    actor_email,
    'superadmin',
    jsonb_build_object(
      'deletedAt', deleted_at,
      'salesSession', to_jsonb(target_session)
    ),
    'sales_session_deleted',
    'Jornada eliminada del historial: ' || target_session.session_label
  );

  delete from public.pos_sales_sessions
  where id = target_session.id;

  return jsonb_build_object(
    'deletedAt', deleted_at,
    'salesSession', to_jsonb(target_session)
  );
end;
$$;

create or replace function public.rebuild_pos_sales_session_summary(
  target_sales_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  summary_payload jsonb;
begin
  if actor_email = '' then
    raise exception 'No hay una sesion valida para recalcular jornadas.';
  end if;

  if not public.pos_cash_allowed(true) then
    raise exception 'Solo superadmin puede recalcular jornadas POS.';
  end if;

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

  update public.pos_sales_sessions
  set summary = summary_payload
  where id = target_sales_session_id;

  return summary_payload;
end;
$$;

create or replace function public.reassign_pos_order_sales_session(
  target_order_id uuid,
  destination_sales_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  target_order public.pos_orders%rowtype;
  source_session public.pos_sales_sessions%rowtype;
  destination_session public.pos_sales_sessions%rowtype;
  source_sales_session_id uuid;
  moved_at timestamptz := timezone('utc', now());
  source_summary jsonb;
  destination_summary jsonb;
begin
  if actor_email = '' then
    raise exception 'No hay una sesion valida para mover cuentas entre jornadas.';
  end if;

  if not public.pos_cash_allowed(true) then
    raise exception 'Solo superadmin puede mover cuentas entre jornadas.';
  end if;

  select *
  into target_order
  from public.pos_orders
  where id = target_order_id
  for update;

  if not found then
    raise exception 'No se encontro la cuenta indicada.';
  end if;

  if target_order.closed_at is null then
    raise exception 'Solo puedes mover cuentas cerradas entre jornadas.';
  end if;

  source_sales_session_id := target_order.sales_session_id;

  if source_sales_session_id = destination_sales_session_id then
    raise exception 'La cuenta ya pertenece a esa jornada.';
  end if;

  if source_sales_session_id is not null then
    select *
    into source_session
    from public.pos_sales_sessions
    where id = source_sales_session_id
    for update;
  end if;

  select *
  into destination_session
  from public.pos_sales_sessions
  where id = destination_sales_session_id
  for update;

  if not found then
    raise exception 'No se encontro la jornada destino.';
  end if;

  update public.pos_orders
  set sales_session_id = destination_session.id
  where id = target_order.id;

  update public.pos_payments
  set sales_session_id = destination_session.id
  where order_id = target_order.id;

  if source_sales_session_id is not null then
    source_summary := public.rebuild_pos_sales_session_summary(source_sales_session_id);
  end if;

  destination_summary := public.rebuild_pos_sales_session_summary(destination_session.id);

  insert into public.pos_order_status_logs (
    actor_email,
    actor_role,
    after_data,
    before_data,
    event_type,
    notes,
    order_id,
    table_id
  )
  values (
    actor_email,
    'superadmin',
    jsonb_build_object(
      'movedAt', moved_at,
      'destinationSalesSession', to_jsonb(destination_session),
      'destinationSummary', destination_summary,
      'sourceSummary', source_summary
    ),
    jsonb_build_object(
      'order', to_jsonb(target_order),
      'sourceSalesSession', case when source_sales_session_id is null then null else to_jsonb(source_session) end
    ),
    'order_sales_session_reassigned',
    'Cuenta movida a jornada ' || destination_session.session_label,
    target_order.id,
    target_order.table_id
  );

  return jsonb_build_object(
    'movedAt', moved_at,
    'destinationSalesSession', to_jsonb(destination_session),
    'destinationSummary', destination_summary,
    'orderId', target_order.id,
    'sourceSalesSessionId', source_sales_session_id,
    'sourceSummary', source_summary
  );
end;
$$;

create or replace function public.create_pos_sales_session_manual(
  manual_business_date date,
  manual_opened_at timestamptz,
  manual_closed_at timestamptz,
  manual_session_label text default null,
  manual_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  created_session public.pos_sales_sessions%rowtype;
  normalized_label text;
begin
  if actor_email = '' then
    raise exception 'No hay una sesion valida para crear jornadas manuales.';
  end if;

  if not public.pos_cash_allowed(true) then
    raise exception 'Solo superadmin puede crear jornadas POS manuales.';
  end if;

  if manual_closed_at <= manual_opened_at then
    raise exception 'La fecha de cierre debe ser posterior a la fecha de apertura.';
  end if;

  normalized_label := coalesce(nullif(trim(manual_session_label), ''), 'Jornada ' || manual_business_date::text);

  insert into public.pos_sales_sessions (
    business_date,
    closed_at,
    closed_by_email,
    cutoff_hour,
    notes,
    opened_at,
    opened_by_email,
    session_label,
    status,
    summary
  )
  values (
    manual_business_date,
    manual_closed_at,
    actor_email,
    18,
    coalesce(manual_notes, ''),
    manual_opened_at,
    actor_email,
    normalized_label,
    'closed',
    '{}'::jsonb
  )
  returning * into created_session;

  perform public.rebuild_pos_sales_session_summary(created_session.id);

  insert into public.pos_order_status_logs (
    actor_email,
    actor_role,
    after_data,
    event_type,
    notes
  )
  values (
    actor_email,
    'superadmin',
    to_jsonb(created_session),
    'sales_session_manual_created',
    'Jornada manual creada: ' || created_session.session_label
  );

  return to_jsonb(created_session);
end;
$$;

create or replace function public.update_pos_sales_session_window(
  sales_session_id uuid,
  manual_business_date date,
  manual_opened_at timestamptz,
  manual_closed_at timestamptz,
  manual_session_label text default null,
  manual_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  before_session public.pos_sales_sessions%rowtype;
  updated_session public.pos_sales_sessions%rowtype;
  normalized_label text;
begin
  if actor_email = '' then
    raise exception 'No hay una sesion valida para ajustar jornadas.';
  end if;

  if not public.pos_cash_allowed(true) then
    raise exception 'Solo superadmin puede ajustar jornadas POS.';
  end if;

  if manual_closed_at <= manual_opened_at then
    raise exception 'La fecha de cierre debe ser posterior a la fecha de apertura.';
  end if;

  select *
  into before_session
  from public.pos_sales_sessions
  where id = sales_session_id
  for update;

  if not found then
    raise exception 'No se encontro la jornada indicada.';
  end if;

  normalized_label := coalesce(nullif(trim(manual_session_label), ''), before_session.session_label, 'Jornada ' || manual_business_date::text);

  update public.pos_sales_sessions
  set
    business_date = manual_business_date,
    closed_at = manual_closed_at,
    closed_by_email = coalesce(closed_by_email, actor_email),
    notes = coalesce(manual_notes, notes),
    opened_at = manual_opened_at,
    session_label = normalized_label,
    status = 'closed'
  where id = before_session.id
  returning * into updated_session;

  perform public.rebuild_pos_sales_session_summary(updated_session.id);

  insert into public.pos_order_status_logs (
    actor_email,
    actor_role,
    after_data,
    before_data,
    event_type,
    notes
  )
  values (
    actor_email,
    'superadmin',
    to_jsonb(updated_session),
    to_jsonb(before_session),
    'sales_session_window_updated',
    'Fechas de jornada ajustadas: ' || updated_session.session_label
  );

  return to_jsonb(updated_session);
end;
$$;
commit;
