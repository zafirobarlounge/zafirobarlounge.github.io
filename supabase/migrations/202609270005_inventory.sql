-- Inventario incremental para ZAFIRO. Requiere schema.sql, pos-schema.sql y migraciones 001-004.
-- Aplicacion manual en QA. No crea existencias ni descuenta ventas historicas.
begin;

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (nullif(trim(name), '') is not null),
  active boolean not null default true,
  base_unit text not null check (base_unit in ('unit','gram','milliliter')),
  precision_scale smallint not null default 0 check (precision_scale between 0 and 3),
  minimum_quantity numeric(18,3) check (minimum_quantity is null or minimum_quantity >= 0),
  target_quantity numeric(18,3) check (target_quantity is null or target_quantity >= 0),
  tracking_started_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  check (target_quantity is null or minimum_quantity is null or target_quantity >= minimum_quantity)
);

create table public.inventory_item_areas (
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  area text not null check (area in ('bar','kitchen')),
  primary key (item_id, area)
);

create table public.inventory_purchase_presentations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  name text not null check (nullif(trim(name), '') is not null),
  content_per_package numeric(18,3) not null check (content_per_package > 0),
  content_unit text not null check (content_unit in ('unit','gram','milliliter')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  unique (item_id, name)
);

create table public.inventory_menu_tracking (
  menu_item_source_key text primary key references public.menu_items(source_key) on delete restrict,
  control_mode text not null default 'partial' check (control_mode in ('partial','complete')),
  updated_at timestamptz not null default now(),
  updated_by text not null
);

create table public.inventory_menu_recipe_components (
  id uuid primary key default gen_random_uuid(),
  menu_item_source_key text not null references public.menu_items(source_key) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_base numeric(18,3) not null check (quantity_base > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  unique (menu_item_source_key, item_id)
);

create table public.inventory_submissions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  kind text not null check (kind in ('replenishment','count','damage')),
  area text not null check (area in ('bar','kitchen')),
  status text not null check (status in ('draft','sent','partially_approved','approved','partially_received','received','rejected')),
  sales_session_id uuid references public.pos_sales_sessions(id) on delete restrict,
  notes text not null default '',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text not null,
  reviewed_at timestamptz,
  reviewed_by text,
  review_notes text
);

create table public.inventory_submission_lines (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.inventory_submissions(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  requested_quantity numeric(18,3),
  observed_quantity numeric(18,3),
  approved_quantity numeric(18,3),
  received_quantity numeric(18,3) not null default 0,
  reference_balance numeric(18,3),
  reference_at timestamptz,
  notes text not null default '',
  unique (submission_id, item_id),
  check (requested_quantity is null or requested_quantity >= 0),
  check (observed_quantity is null or observed_quantity >= 0),
  check (approved_quantity is null or approved_quantity >= 0),
  check (received_quantity >= 0)
);

create table public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  supplier text,
  document_reference text,
  expense_movement_id uuid unique references public.pos_cash_movements(id) on delete restrict,
  total_cost numeric(18,2) check (total_cost is null or total_cost >= 0),
  received_at timestamptz not null,
  received_by text not null,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table public.inventory_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.inventory_receipts(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  presentation_id uuid references public.inventory_purchase_presentations(id) on delete restrict,
  presentation_name_snapshot text,
  content_per_package_snapshot numeric(18,3),
  content_unit_snapshot text,
  package_quantity numeric(18,3),
  base_quantity numeric(18,3) not null check (base_quantity > 0),
  unit_cost numeric(18,4) check (unit_cost is null or unit_cost >= 0),
  submission_line_id uuid references public.inventory_submission_lines(id) on delete restrict,
  check ((presentation_id is null and package_quantity is null) or (presentation_id is not null and package_quantity > 0))
);

create table public.inventory_pos_consumptions (
  id uuid primary key default gen_random_uuid(),
  pos_order_item_id uuid not null unique references public.pos_order_items(id) on delete restrict,
  order_id uuid not null references public.pos_orders(id) on delete restrict,
  sales_session_id uuid references public.pos_sales_sessions(id) on delete restrict,
  menu_item_source_key text,
  menu_quantity numeric(18,3) not null,
  recipe_control_mode text,
  consumed_at timestamptz not null default now(),
  consumed_by text not null
);

create table public.inventory_pos_consumption_lines (
  id uuid primary key default gen_random_uuid(),
  consumption_id uuid not null references public.inventory_pos_consumptions(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  item_name_snapshot text not null,
  base_unit_snapshot text not null,
  quantity_per_menu_unit_snapshot numeric(18,3) not null,
  quantity_consumed numeric(18,3) not null check (quantity_consumed > 0),
  returned_quantity numeric(18,3) not null default 0,
  waste_quantity numeric(18,3) not null default 0,
  internal_quantity numeric(18,3) not null default 0,
  client_consumed_quantity numeric(18,3) not null default 0,
  check (returned_quantity + waste_quantity + internal_quantity + client_consumed_quantity <= quantity_consumed)
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  movement_type text not null check (movement_type in ('initial_count','purchase_receipt','pos_consumption','recoverable_return','waste','internal_consumption','count_adjustment','correction')),
  quantity_delta numeric(18,3) not null check (quantity_delta <> 0 or movement_type in ('initial_count','waste','internal_consumption')),
  base_unit_snapshot text not null,
  reason text not null,
  actor text not null,
  occurred_at timestamptz not null default now(),
  sales_session_id uuid references public.pos_sales_sessions(id) on delete restrict,
  order_id uuid references public.pos_orders(id) on delete restrict,
  order_item_id uuid references public.pos_order_items(id) on delete restrict,
  submission_id uuid references public.inventory_submissions(id) on delete restrict,
  receipt_id uuid references public.inventory_receipts(id) on delete restrict,
  consumption_line_id uuid references public.inventory_pos_consumption_lines(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb
);

create table public.inventory_command_audit (
  request_id uuid primary key,
  actor text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index inventory_movements_item_time_idx on public.inventory_movements(item_id, occurred_at, id);
create index inventory_submissions_status_idx on public.inventory_submissions(status, created_at desc);
create index inventory_receipts_time_idx on public.inventory_receipts(received_at desc);
create index inventory_recipe_menu_idx on public.inventory_menu_recipe_components(menu_item_source_key) where active;

create function public.inventory_actor_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt()->>'email',''));
$$;

create function public.inventory_is_active_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.inventory_actor_email() <> '' and
    (not exists(select 1 from public.staff_profiles p where lower(p.email)=public.inventory_actor_email())
      or exists(select 1 from public.staff_profiles p where lower(p.email)=public.inventory_actor_email() and p.is_active)) and
    (public.is_catalog_admin() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email()));
$$;

create function public.inventory_can_manage() returns boolean
language sql stable security definer set search_path = public as $$
  select public.inventory_is_active_staff() and (public.is_catalog_admin() or public.has_staff_role('superadmin') or public.has_staff_role('cashier'));
$$;

create function public.inventory_can_configure() returns boolean
language sql stable security definer set search_path = public as $$
  select public.inventory_is_active_staff() and (public.is_catalog_admin() or public.has_staff_role('superadmin'));
$$;

create function public.inventory_item_visible(item uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.inventory_can_manage() or (public.inventory_is_active_staff() and exists(
    select 1 from public.inventory_item_areas a join public.staff_role_assignments r on r.role=a.area
    where a.item_id=item and lower(r.email)=public.inventory_actor_email() and r.role in ('bar','kitchen')
  ));
$$;

create function public.inventory_prevent_history_change() returns trigger
language plpgsql set search_path = public as $$
begin raise exception 'El historial de inventario es inmutable; registra un movimiento compensatorio'; end;
$$;

create trigger inventory_movements_immutable before update or delete on public.inventory_movements
for each row execute function public.inventory_prevent_history_change();
create trigger inventory_receipt_lines_immutable before update or delete on public.inventory_receipt_lines
for each row execute function public.inventory_prevent_history_change();
create trigger inventory_consumption_lines_immutable before delete on public.inventory_pos_consumption_lines
for each row execute function public.inventory_prevent_history_change();

create function public.inventory_deliver_pos_item(item_id uuid, direct_delivery boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); line public.pos_order_items; ord public.pos_orders; v_consumption_id uuid; component record; allowed text[];
begin
  if not public.inventory_is_active_staff() then raise exception 'Acceso operativo denegado'; end if;
  perform pg_advisory_xact_lock(hashtext(item_id::text));
  select * into line from public.pos_order_items where id=item_id for update;
  if not found then raise exception 'Producto del pedido inexistente'; end if;
  if line.operational_status='delivered' then return to_jsonb(line); end if;
  if line.operational_status='cancelled' then raise exception 'La linea esta cancelada'; end if;
  allowed:=case when direct_delivery then array['sent','pending_preparation','in_process','ready','picking_up'] else array['ready','picking_up'] end;
  if not line.operational_status=any(allowed) then raise exception 'La linea no esta lista para esta entrega'; end if;
  if direct_delivery and not exists(select 1 from public.pos_operational_flow_settings f where f.area=line.prep_area and f.use_direct_delivery) then
    raise exception 'La entrega directa no esta habilitada para esta area';
  end if;
  select * into ord from public.pos_orders where id=line.order_id;
  insert into public.inventory_pos_consumptions(pos_order_item_id,order_id,sales_session_id,menu_item_source_key,menu_quantity,recipe_control_mode,consumed_by)
    values(line.id,line.order_id,ord.sales_session_id,line.menu_item_source_key,line.quantity,
      (select control_mode from public.inventory_menu_tracking where menu_item_source_key=line.menu_item_source_key),actor)
    on conflict(pos_order_item_id) do update set pos_order_item_id=excluded.pos_order_item_id returning id into v_consumption_id;
  for component in
    select r.item_id,r.quantity_base,i.name,i.base_unit,i.tracking_started_at
    from public.inventory_menu_recipe_components r join public.inventory_items i on i.id=r.item_id
    where r.menu_item_source_key=line.menu_item_source_key and r.active and i.active
  loop
    insert into public.inventory_pos_consumption_lines(consumption_id,item_id,item_name_snapshot,base_unit_snapshot,quantity_per_menu_unit_snapshot,quantity_consumed)
      values(v_consumption_id,component.item_id,component.name,component.base_unit,component.quantity_base,component.quantity_base*line.quantity)
      on conflict do nothing;
    if component.tracking_started_at is not null then
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata)
      select 'pos:'||line.id||':'||cl.id,component.item_id,'pos_consumption',-cl.quantity_consumed,component.base_unit,'Entrega POS',actor,ord.sales_session_id,line.order_id,line.id,cl.id,
        jsonb_build_object('menu_item_source_key',line.menu_item_source_key,'quantity_per_menu_unit',component.quantity_base,'menu_quantity',line.quantity)
      from public.inventory_pos_consumption_lines cl where cl.consumption_id=v_consumption_id and cl.item_id=component.item_id
      on conflict(operation_key) do nothing;
    end if;
  end loop;
  update public.pos_order_items set operational_status='delivered',delivered_at=now(),delivered_by_email=actor,
    ready_at=coalesce(ready_at,now()),updated_by_email=actor where id=line.id returning * into line;
  insert into public.pos_order_status_logs(order_id,order_item_id,event_type,actor_email,after_data,notes)
    values(line.order_id,line.id,case when direct_delivery then 'item_direct_delivered' else 'item_delivered' end,actor,to_jsonb(line),'Entrega y consumo de inventario atomicos');
  return to_jsonb(line);
end;
$$;

create function public.inventory_read() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a inventario'; end if;
  select jsonb_build_object(
    'can_manage',costs,'can_configure',public.inventory_can_configure(),
    'items',coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('id',i.id,'name',i.name,'active',i.active,'base_unit',i.base_unit,'precision_scale',i.precision_scale,
        'minimum_quantity',i.minimum_quantity,'target_quantity',i.target_quantity,'tracking_started_at',i.tracking_started_at,
        'balance',case when i.tracking_started_at is null then null else coalesce(sum(m.quantity_delta),0) end,
        'pending_incoming',coalesce((select sum(greatest(coalesce(l.approved_quantity,0)-l.received_quantity,0)) from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.item_id=i.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received')),0),
        'last_unit_cost',case when costs then (select rl.unit_cost from public.inventory_receipt_lines rl join public.inventory_receipts rr on rr.id=rl.receipt_id where rl.item_id=i.id and rl.unit_cost is not null order by rr.received_at desc,rl.id desc limit 1) else null end,
        'areas',coalesce((select jsonb_agg(a.area order by a.area) from public.inventory_item_areas a where a.item_id=i.id),'[]'::jsonb)) x
      from public.inventory_items i left join public.inventory_movements m on m.item_id=i.id where public.inventory_item_visible(i.id) group by i.id
    ) q),'[]'::jsonb),
    'presentations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'item_id',p.item_id,'name',p.name,'content_per_package',p.content_per_package,'content_unit',p.content_unit,'active',p.active) order by p.name)
      from public.inventory_purchase_presentations p where public.inventory_item_visible(p.item_id)),'[]'::jsonb),
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name) order by mi.name)
      from public.inventory_menu_recipe_components r join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',source_key,'name',name) order by name) from public.menu_items),'[]'::jsonb) else '[]'::jsonb end,
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes)),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) order by s.created_at desc)
      from public.inventory_submissions s where costs or (lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))),'[]'::jsonb),
    'receipts',case when costs then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'supplier',r.supplier,'document_reference',r.document_reference,'expense_movement_id',r.expense_movement_id,'total_cost',r.total_cost,'received_at',r.received_at,'received_by',r.received_by,'notes',r.notes,
      'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from public.inventory_receipt_lines l where l.receipt_id=r.id)) order by r.received_at desc) from public.inventory_receipts r),'[]'::jsonb) else '[]'::jsonb end,
    'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'item_id',m.item_id,'item_name',i.name,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'base_unit_snapshot',m.base_unit_snapshot,'reason',m.reason,'actor',m.actor,'occurred_at',m.occurred_at,'sales_session_id',m.sales_session_id,'order_id',m.order_id,'order_item_id',m.order_item_id,'metadata',case when costs then m.metadata else m.metadata-'cost'-'supplier' end) order by m.occurred_at desc)
      from public.inventory_movements m join public.inventory_items i on i.id=m.item_id where public.inventory_item_visible(m.item_id)),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create function public.inventory_get_pos_consumption(item_id uuid, void_quantity integer default 1) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare line public.pos_order_items; result jsonb;
begin
  if not public.inventory_can_manage() then raise exception 'Acceso denegado'; end if;
  select * into line from public.pos_order_items where id=item_id;
  if not found or line.operational_status<>'delivered' then return jsonb_build_object('item_id',item_id,'lines','[]'::jsonb); end if;
  select jsonb_build_object('item_id',line.id,'product_name',line.product_name,'void_quantity',void_quantity,'lines',coalesce(jsonb_agg(jsonb_build_object(
    'consumption_line_id',cl.id,'item_id',cl.item_id,'item_name',cl.item_name_snapshot,'base_unit',cl.base_unit_snapshot,
    'quantity',cl.quantity_per_menu_unit_snapshot*void_quantity,'already_resolved',cl.returned_quantity+cl.waste_quantity+cl.internal_quantity+cl.client_consumed_quantity
  ) order by cl.item_name_snapshot),'[]'::jsonb)) into result
  from public.inventory_pos_consumptions c join public.inventory_pos_consumption_lines cl on cl.consumption_id=c.id where c.pos_order_item_id=line.id;
  return result;
end;
$$;

create function public.inventory_void_processed_item(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); previous public.inventory_command_audit; line public.pos_order_items; cancelled public.pos_order_items; active_line public.pos_order_items; void_qty integer; reason text; next_total numeric; paid numeric; resolution jsonb; cl public.inventory_pos_consumption_lines; required_qty numeric; returned_qty numeric; waste_qty numeric; internal_qty numeric; client_qty numeric; result jsonb;
begin
  if request_id is null or not public.inventory_can_manage() then raise exception 'Acceso denegado para anular producto'; end if;
  reason:=nullif(trim(payload->>'reason'),''); void_qty:=coalesce((payload->>'void_quantity')::integer,1);
  if reason is null or void_qty<1 then raise exception 'Motivo y cantidad de anulacion obligatorios'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_void_processed_item.request_id;
  if found then if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if; return previous.result; end if;
  select * into line from public.pos_order_items where id=(payload->>'item_id')::uuid for update;
  if not found or line.operational_status in ('draft','sent','pending_preparation','cancelled') or void_qty>line.quantity then raise exception 'Producto no disponible para anulacion extraordinaria'; end if;
  select coalesce(sum(i.total_price),0)-line.unit_price*void_qty into next_total from public.pos_order_items i where i.order_id=line.order_id and i.operational_status<>'cancelled' and i.financial_status<>'cancelled';
  select coalesce(sum(p.amount_applied),0) into paid from public.pos_payments p where p.order_id=line.order_id and p.status='confirmed';
  if exists(select 1 from public.pos_payments p where p.order_id=line.order_id and p.status='pending') then raise exception 'Resuelve los pagos pendientes antes de anular'; end if;
  if paid>next_total then raise exception 'La anulacion dejaria la cuenta sobrepagada'; end if;

  if line.operational_status='delivered' then
    for cl in select x.* from public.inventory_pos_consumptions c join public.inventory_pos_consumption_lines x on x.consumption_id=c.id where c.pos_order_item_id=line.id for update of x
    loop
      required_qty:=cl.quantity_per_menu_unit_snapshot*void_qty;
      select value into resolution from jsonb_array_elements(coalesce(payload->'resolutions','[]'::jsonb)) where value->>'consumption_line_id'=cl.id::text;
      if resolution is null then raise exception 'Indica el destino de cada componente consumido'; end if;
      returned_qty:=coalesce((resolution->>'returned_quantity')::numeric,0); waste_qty:=coalesce((resolution->>'waste_quantity')::numeric,0);
      internal_qty:=coalesce((resolution->>'internal_quantity')::numeric,0); client_qty:=coalesce((resolution->>'client_consumed_quantity')::numeric,0);
      if least(returned_qty,waste_qty,internal_qty,client_qty)<0 or returned_qty+waste_qty+internal_qty+client_qty<>required_qty or cl.returned_quantity+cl.waste_quantity+cl.internal_quantity+cl.client_consumed_quantity+required_qty>cl.quantity_consumed then
        raise exception 'La resolucion del componente no coincide con la cantidad anulada';
      end if;
      update public.inventory_pos_consumption_lines set returned_quantity=returned_quantity+returned_qty,waste_quantity=waste_quantity+waste_qty,internal_quantity=internal_quantity+internal_qty,client_consumed_quantity=client_consumed_quantity+client_qty where id=cl.id;
      if returned_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata)
        select 'void:return:'||request_id||':'||cl.id,cl.item_id,'recoverable_return',returned_qty,cl.base_unit_snapshot,reason,actor,c.sales_session_id,c.order_id,line.id,cl.id,jsonb_build_object('resolved_quantity',returned_qty)
        from public.inventory_pos_consumptions c where c.id=cl.consumption_id; end if;
      if waste_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata)
        values('void:waste:'||request_id||':'||cl.id,cl.item_id,'waste',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',waste_qty,'already_consumed',true)); end if;
      if internal_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata)
        values('void:internal:'||request_id||':'||cl.id,cl.item_id,'internal_consumption',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',internal_qty,'already_consumed',true)); end if;
      resolution:=null;
    end loop;
  end if;

  if void_qty=line.quantity then
    update public.pos_order_items set cancellation_reason=reason,cancelled_at=now(),cancelled_by_email=actor,financial_status='cancelled',operational_status='cancelled',updated_by_email=actor where id=line.id returning * into cancelled;
    result:=jsonb_build_array(to_jsonb(cancelled));
  else
    update public.pos_order_items set quantity=quantity-void_qty,total_price=unit_price*(quantity-void_qty),updated_by_email=actor where id=line.id returning * into active_line;
    insert into public.pos_order_items(order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,service_round,operational_status,financial_status,notes,replacement_for_item_id,created_by_email,updated_by_email,sent_at,preparation_started_at,ready_at,picking_up_at,picking_up_by_email,delivered_at,delivered_by_email,cancelled_at,cancelled_by_email,cancellation_reason)
      values(line.order_id,line.menu_item_source_key,line.product_name,line.product_slug,line.prep_area,void_qty,line.unit_price,line.unit_price*void_qty,line.service_round,'cancelled','cancelled',line.notes,line.id,actor,actor,line.sent_at,line.preparation_started_at,line.ready_at,line.picking_up_at,line.picking_up_by_email,line.delivered_at,line.delivered_by_email,now(),actor,reason) returning * into cancelled;
    result:=jsonb_build_array(to_jsonb(active_line),to_jsonb(cancelled));
  end if;
  update public.pos_orders o set financial_status=case when not exists(select 1 from public.pos_order_items i where i.order_id=o.id and i.operational_status<>'cancelled') then 'cancelled' when paid=0 then 'pending_payment' when paid>=next_total then 'paid_total' else 'partially_paid' end,updated_at=now() where o.id=line.order_id;
  insert into public.pos_order_status_logs(order_id,order_item_id,event_type,actor_email,before_data,after_data,notes) values(line.order_id,line.id,'item_voided_after_process',actor,to_jsonb(line),result,reason);
  insert into public.inventory_command_audit(request_id,actor,payload,result) values(request_id,actor,payload,result);
  return result;
end;
$$;

create function public.inventory_menu_alerts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() then raise exception 'Acceso denegado'; end if;
  with balances as (
    select i.id,i.tracking_started_at,case when i.tracking_started_at is null then null else coalesce(sum(m.quantity_delta),0) end balance
    from public.inventory_items i left join public.inventory_movements m on m.item_id=i.id group by i.id
  ), alerts as (
    select t.menu_item_source_key,t.control_mode,
      bool_or(b.balance is null) as has_uncounted,
      bool_or(b.balance is not null and b.balance < r.quantity_base) as cannot_make_one,
      min(case when b.balance is null then null else floor(b.balance/r.quantity_base) end) as controlled_units_available
    from public.inventory_menu_tracking t join public.inventory_menu_recipe_components r on r.menu_item_source_key=t.menu_item_source_key and r.active
    join public.inventory_items i on i.id=r.item_id and i.active join balances b on b.id=i.id group by t.menu_item_source_key,t.control_mode
  )
  select coalesce(jsonb_agg(jsonb_build_object('menu_item_source_key',menu_item_source_key,'control_mode',control_mode,'has_uncounted',has_uncounted,'cannot_make_one',cannot_make_one,'controlled_units_available',controlled_units_available)),'[]'::jsonb) into result from alerts;
  return result;
end;
$$;

create function public.inventory_command(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); action text:=payload->>'action'; previous public.inventory_command_audit; result jsonb; item public.inventory_items; pres public.inventory_purchase_presentations; sub public.inventory_submissions; subline public.inventory_submission_lines; line jsonb; receipt public.inventory_receipts; receipt_line_id uuid; qty numeric; current_balance numeric; target_balance numeric; expense public.pos_cash_movements;
begin
  if request_id is null or payload is null or not public.inventory_is_active_staff() then raise exception 'Solicitud de inventario invalida o no autorizada'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_command.request_id;
  if found then if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if; return previous.result; end if;

  if action='save_item' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura articulos'; end if;
    if payload->>'id' is null then
      insert into public.inventory_items(name,active,base_unit,precision_scale,minimum_quantity,target_quantity,created_by,updated_by)
      values(trim(payload->>'name'),coalesce((payload->>'active')::boolean,true),payload->>'base_unit',coalesce((payload->>'precision_scale')::smallint,0),(payload->>'minimum_quantity')::numeric,(payload->>'target_quantity')::numeric,actor,actor) returning * into item;
    else
      update public.inventory_items set name=trim(payload->>'name'),active=coalesce((payload->>'active')::boolean,active),minimum_quantity=(payload->>'minimum_quantity')::numeric,target_quantity=(payload->>'target_quantity')::numeric,updated_at=now(),updated_by=actor
      where id=(payload->>'id')::uuid returning * into item;
      if not found then raise exception 'Articulo inexistente'; end if;
    end if;
    delete from public.inventory_item_areas where item_id=item.id;
    insert into public.inventory_item_areas(item_id,area) select item.id,value from jsonb_array_elements_text(coalesce(payload->'areas','[]'::jsonb)) where value in ('bar','kitchen') on conflict do nothing;
    result:=to_jsonb(item);
  elsif action='save_presentation' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura presentaciones'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid;
    if not found or payload->>'content_unit'<>item.base_unit then raise exception 'La unidad de la presentacion debe coincidir con la unidad base; no se convierten gramos y mililitros'; end if;
    if payload->>'id' is null then
      insert into public.inventory_purchase_presentations(item_id,name,content_per_package,content_unit,created_by,updated_by)
      values(item.id,trim(payload->>'name'),(payload->>'content_per_package')::numeric,payload->>'content_unit',actor,actor) returning * into pres;
    else
      update public.inventory_purchase_presentations set name=trim(payload->>'name'),content_per_package=(payload->>'content_per_package')::numeric,active=coalesce((payload->>'active')::boolean,active),updated_at=now(),updated_by=actor where id=(payload->>'id')::uuid and item_id=item.id returning * into pres;
    end if; result:=to_jsonb(pres);
  elsif action='save_recipe' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura consumo del menu'; end if;
    insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by) values(payload->>'menu_item_source_key',coalesce(payload->>'control_mode','partial'),actor)
      on conflict(menu_item_source_key) do update set control_mode=excluded.control_mode,updated_at=now(),updated_by=actor;
    update public.inventory_menu_recipe_components set active=false,updated_at=now(),updated_by=actor where menu_item_source_key=payload->>'menu_item_source_key';
    for line in select value from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) loop
      insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,quantity_base,active,created_by,updated_by)
      values(payload->>'menu_item_source_key',(line->>'item_id')::uuid,(line->>'quantity_base')::numeric,true,actor,actor)
      on conflict(menu_item_source_key,item_id) do update set quantity_base=excluded.quantity_base,active=true,updated_at=now(),updated_by=actor;
    end loop; result:=jsonb_build_object('menu_item_source_key',payload->>'menu_item_source_key');
  elsif action='initial_count' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja activa el conteo inicial'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid for update;
    if item.tracking_started_at is not null then raise exception 'El articulo ya tiene conteo inicial'; end if;
    qty:=(payload->>'quantity')::numeric; if qty<0 then raise exception 'Cantidad invalida'; end if;
    update public.inventory_items set tracking_started_at=now(),updated_at=now(),updated_by=actor where id=item.id;
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata)
      values('initial:'||request_id,item.id,'initial_count',qty,item.base_unit,coalesce(nullif(trim(payload->>'reason'),''),'Conteo inicial'),actor,jsonb_build_object('counted_quantity',qty)) returning to_jsonb(inventory_movements.*) into result;
  elsif action='submit' then
    if not (public.inventory_can_manage() or public.has_staff_role(payload->>'area')) or payload->>'area' not in ('bar','kitchen') then raise exception 'Area no autorizada'; end if;
    insert into public.inventory_submissions(request_id,kind,area,status,sales_session_id,notes,submitted_at,created_by)
      values(request_id,payload->>'kind',payload->>'area',coalesce(payload->>'status','sent'),(payload->>'sales_session_id')::uuid,coalesce(payload->>'notes',''),case when coalesce(payload->>'status','sent')='sent' then now() end,actor) returning * into sub;
    for line in select value from jsonb_array_elements(payload->'lines') loop
      if not public.inventory_item_visible((line->>'item_id')::uuid) or not exists(select 1 from public.inventory_item_areas a where a.item_id=(line->>'item_id')::uuid and a.area=payload->>'area') then raise exception 'Articulo no autorizado para el area'; end if;
      select case when i.tracking_started_at is null then null else coalesce(sum(m.quantity_delta),0) end into current_balance from public.inventory_items i left join public.inventory_movements m on m.item_id=i.id where i.id=(line->>'item_id')::uuid group by i.id;
      insert into public.inventory_submission_lines(submission_id,item_id,requested_quantity,observed_quantity,reference_balance,reference_at,notes)
      values(sub.id,(line->>'item_id')::uuid,(line->>'requested_quantity')::numeric,(line->>'observed_quantity')::numeric,current_balance,now(),coalesce(line->>'notes',''));
    end loop; result:=to_jsonb(sub);
  elsif action='send_submission' then
    select * into sub from public.inventory_submissions where id=(payload->>'submission_id')::uuid for update;
    if not found or sub.status<>'draft' or (lower(sub.created_by)<>actor and not public.inventory_can_manage()) then raise exception 'Borrador no disponible'; end if;
    update public.inventory_submissions set status='sent',submitted_at=now() where id=sub.id returning to_jsonb(inventory_submissions.*) into result;
  elsif action='review_submission' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja revisa solicitudes'; end if;
    select * into sub from public.inventory_submissions where id=(payload->>'submission_id')::uuid for update;
    if not found or sub.status not in ('sent','partially_approved') then raise exception 'Solicitud no disponible para revision'; end if;
    for line in select value from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) loop
      update public.inventory_submission_lines set approved_quantity=(line->>'approved_quantity')::numeric where id=(line->>'line_id')::uuid and submission_id=sub.id;
      if sub.kind in ('damage','count') and coalesce((line->>'approved_quantity')::numeric,0)>=0 then
        select i.* into item from public.inventory_items i
        where i.id=(select item_id from public.inventory_submission_lines where id=(line->>'line_id')::uuid);
        if item.tracking_started_at is null then raise exception 'El articulo requiere conteo inicial'; end if;
        if sub.kind='damage' then qty:=-(line->>'approved_quantity')::numeric;
        else
          select l.observed_quantity + coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.item_id=l.item_id and m.occurred_at>l.reference_at),0) into target_balance from public.inventory_submission_lines l where l.id=(line->>'line_id')::uuid;
          select coalesce(sum(quantity_delta),0) into current_balance from public.inventory_movements where item_id=item.id; qty:=target_balance-current_balance;
        end if;
        if qty<>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,submission_id,metadata)
          values('review:'||request_id||':'||(line->>'line_id'),item.id,case when sub.kind='damage' then 'waste' else 'count_adjustment' end,qty,item.base_unit,coalesce(nullif(trim(payload->>'notes'),''),case when sub.kind='damage' then 'Merma aprobada' else 'Ajuste por conteo' end),actor,sub.id,jsonb_build_object('reference_at',(select reference_at from public.inventory_submission_lines where id=(line->>'line_id')::uuid),'target_balance',target_balance)); end if;
      end if;
    end loop;
    update public.inventory_submissions set status=payload->>'status',reviewed_at=now(),reviewed_by=actor,review_notes=payload->>'notes' where id=sub.id returning to_jsonb(inventory_submissions.*) into result;
  elsif action='receive' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja recibe compras'; end if;
    if payload->>'expense_movement_id' is not null then
      select * into expense from public.pos_cash_movements where id=(payload->>'expense_movement_id')::uuid;
      if not found or expense.kind<>'expense' or expense.voided_at is not null then raise exception 'El gasto vinculado no es valido'; end if;
      if payload->>'total_cost' is not null and expense.amount<>(payload->>'total_cost')::numeric then raise exception 'El importe del gasto vinculado no coincide con el costo de la recepcion'; end if;
    end if;
    insert into public.inventory_receipts(request_id,supplier,document_reference,expense_movement_id,total_cost,received_at,received_by,notes)
      values(request_id,nullif(trim(payload->>'supplier'),''),nullif(trim(payload->>'document_reference'),''),(payload->>'expense_movement_id')::uuid,(payload->>'total_cost')::numeric,coalesce((payload->>'received_at')::timestamptz,now()),actor,coalesce(payload->>'notes','')) returning * into receipt;
    for line in select value from jsonb_array_elements(payload->'lines') loop
      select * into item from public.inventory_items where id=(line->>'item_id')::uuid for update;
      if item.tracking_started_at is null then raise exception 'Registra primero el conteo inicial de %',item.name; end if;
      if line->>'presentation_id' is not null then
        select * into pres from public.inventory_purchase_presentations where id=(line->>'presentation_id')::uuid and item_id=item.id and active;
        if not found then raise exception 'Presentacion inexistente o inactiva'; end if;
        qty:=pres.content_per_package*(line->>'package_quantity')::numeric;
      else qty:=(line->>'base_quantity')::numeric; end if;
      if qty<=0 then raise exception 'Cantidad recibida invalida'; end if;
      subline:=null;
      if line->>'submission_line_id' is not null then
        select l.* into subline from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id
        where l.id=(line->>'submission_line_id')::uuid and l.item_id=item.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received') for update of l;
        if not found or subline.approved_quantity is null or subline.received_quantity+qty>subline.approved_quantity then raise exception 'La recepcion supera la cantidad aprobada o no corresponde a la solicitud'; end if;
      end if;
      insert into public.inventory_receipt_lines(receipt_id,item_id,presentation_id,presentation_name_snapshot,content_per_package_snapshot,content_unit_snapshot,package_quantity,base_quantity,unit_cost,submission_line_id)
      values(receipt.id,item.id,pres.id,pres.name,pres.content_per_package,pres.content_unit,(line->>'package_quantity')::numeric,qty,(line->>'unit_cost')::numeric,(line->>'submission_line_id')::uuid) returning id into receipt_line_id;
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,receipt_id,submission_id,metadata)
      values('receipt-line:'||receipt_line_id,item.id,'purchase_receipt',qty,item.base_unit,'Recepcion de compra',actor,receipt.id,subline.submission_id,jsonb_build_object('presentation_name',pres.name,'content_per_package',pres.content_per_package,'package_quantity',line->>'package_quantity','unit_cost',line->>'unit_cost'));
      if line->>'submission_line_id' is not null then update public.inventory_submission_lines set received_quantity=received_quantity+qty where id=(line->>'submission_line_id')::uuid; end if;
      if subline.submission_id is not null then
        update public.inventory_submissions s set status=case when not exists(select 1 from public.inventory_submission_lines l where l.submission_id=s.id and coalesce(l.approved_quantity,0)>l.received_quantity) then 'received' else 'partially_received' end where s.id=subline.submission_id;
      end if;
      pres:=null;
    end loop; result:=to_jsonb(receipt);
  elsif action='correction' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja registra correcciones'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid;
    qty:=(payload->>'quantity_delta')::numeric; if qty=0 or nullif(trim(payload->>'reason'),'') is null then raise exception 'Correccion invalida'; end if;
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata)
      values('correction:'||request_id,item.id,'correction',qty,item.base_unit,payload->>'reason',actor,payload-'action') returning to_jsonb(inventory_movements.*) into result;
  else raise exception 'Operacion de inventario desconocida'; end if;
  insert into public.inventory_command_audit(request_id,actor,payload,result) values(request_id,actor,payload,result);
  return result;
end;
$$;

alter table public.inventory_items enable row level security;
alter table public.inventory_item_areas enable row level security;
alter table public.inventory_purchase_presentations enable row level security;
alter table public.inventory_menu_tracking enable row level security;
alter table public.inventory_menu_recipe_components enable row level security;
alter table public.inventory_submissions enable row level security;
alter table public.inventory_submission_lines enable row level security;
alter table public.inventory_receipts enable row level security;
alter table public.inventory_receipt_lines enable row level security;
alter table public.inventory_pos_consumptions enable row level security;
alter table public.inventory_pos_consumption_lines enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_command_audit enable row level security;

revoke all on public.inventory_items,public.inventory_item_areas,public.inventory_purchase_presentations,public.inventory_menu_tracking,public.inventory_menu_recipe_components,public.inventory_submissions,public.inventory_submission_lines,public.inventory_receipts,public.inventory_receipt_lines,public.inventory_pos_consumptions,public.inventory_pos_consumption_lines,public.inventory_movements,public.inventory_command_audit from public,anon,authenticated;
revoke all on function public.inventory_actor_email(),public.inventory_is_active_staff(),public.inventory_can_manage(),public.inventory_can_configure(),public.inventory_item_visible(uuid),public.inventory_deliver_pos_item(uuid,boolean),public.inventory_read(),public.inventory_menu_alerts(),public.inventory_get_pos_consumption(uuid,integer),public.inventory_void_processed_item(uuid,jsonb),public.inventory_command(uuid,jsonb) from public,anon;
grant execute on function public.inventory_deliver_pos_item(uuid,boolean),public.inventory_read(),public.inventory_menu_alerts(),public.inventory_get_pos_consumption(uuid,integer),public.inventory_void_processed_item(uuid,jsonb),public.inventory_command(uuid,jsonb) to authenticated;

commit;
