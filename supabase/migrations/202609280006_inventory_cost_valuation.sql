-- Costos y valoracion incremental para Inventario. Requiere 202609270005_inventory.sql.
-- Aplicacion manual en QA. No reconstruye costos de ventas historicas ni ejecuta cambios remotos.
begin;

alter table public.inventory_purchase_presentations
  add column suggested_package_cost numeric(18,2) check (suggested_package_cost is null or suggested_package_cost >= 0);

alter table public.inventory_receipt_lines
  add column actual_package_cost numeric(18,2) check (actual_package_cost is null or actual_package_cost >= 0),
  add column line_total_cost numeric(18,2) check (line_total_cost is null or line_total_cost >= 0),
  add column base_unit_cost numeric(24,10) check (base_unit_cost is null or base_unit_cost >= 0);

alter table public.inventory_pos_consumption_lines
  add column average_unit_cost_snapshot numeric(24,10) check (average_unit_cost_snapshot is null or average_unit_cost_snapshot >= 0),
  add column tracked_cost numeric(24,6) check (tracked_cost is null or tracked_cost >= 0);

alter table public.inventory_movements
  add column unit_cost_snapshot numeric(24,10) check (unit_cost_snapshot is null or unit_cost_snapshot >= 0),
  add column tracked_value_delta numeric(24,6),
  add column quantity_balance_after numeric(18,3),
  add column average_unit_cost_after numeric(24,10) check (average_unit_cost_after is null or average_unit_cost_after >= 0),
  add column inventory_value_after numeric(24,6);

create table public.inventory_item_valuations (
  item_id uuid primary key references public.inventory_items(id) on delete restrict,
  current_quantity numeric(18,3) not null default 0,
  average_unit_cost numeric(24,10) check (average_unit_cost is null or average_unit_cost >= 0),
  inventory_value numeric(24,6),
  updated_at timestamptz not null default now()
);

-- Existing 005 quantities are retained, but their valuation starts explicitly unknown.
-- A later receipt can establish a reliable average only after the prior balance is <= 0.
insert into public.inventory_item_valuations(item_id,current_quantity)
select i.id,case when i.tracking_started_at is null then 0 else coalesce(sum(m.quantity_delta),0) end
from public.inventory_items i left join public.inventory_movements m on m.item_id=i.id
group by i.id;

create function public.inventory_apply_valuation(item uuid, quantity_delta numeric, incoming_unit_cost numeric, operation_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare state public.inventory_item_valuations; old_qty numeric; old_avg numeric; next_qty numeric; next_avg numeric; next_value numeric; value_delta numeric;
begin
  if quantity_delta is null or operation_kind not in ('initial','receipt','return','outgoing','adjustment') then raise exception 'Movimiento de valoracion invalido'; end if;
  insert into public.inventory_item_valuations(item_id,current_quantity)
    values(item,coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.item_id=item),0))
    on conflict on constraint inventory_item_valuations_pkey do nothing;
  select * into state from public.inventory_item_valuations v where v.item_id=item for update;
  old_qty:=state.current_quantity; old_avg:=state.average_unit_cost; next_qty:=old_qty+quantity_delta;
  if operation_kind='initial' then
    next_avg:=incoming_unit_cost;
  elsif operation_kind in ('receipt','return') then
    if quantity_delta<=0 then raise exception 'La entrada de valoracion debe ser positiva'; end if;
    if incoming_unit_cost is null then
      next_avg:=null;
    elsif old_qty<=0 then
      next_avg:=incoming_unit_cost;
    elsif old_avg is null then
      next_avg:=null;
    else
      next_avg:=((old_qty*old_avg)+(quantity_delta*incoming_unit_cost))/(old_qty+quantity_delta);
    end if;
  else
    -- Salidas y ajustes conservan el ultimo promedio conocido, aun con saldo cero o negativo.
    next_avg:=old_avg;
  end if;
  next_avg:=case when next_avg is null then null else round(next_avg,10) end;
  next_value:=case when next_avg is null then null else round(next_qty*next_avg,6) end;
  value_delta:=case
    when operation_kind in ('initial','receipt','return') and incoming_unit_cost is not null then round(quantity_delta*incoming_unit_cost,6)
    when operation_kind in ('outgoing','adjustment') and old_avg is not null then round(quantity_delta*old_avg,6)
    else null end;
  update public.inventory_item_valuations set current_quantity=next_qty,average_unit_cost=next_avg,inventory_value=next_value,updated_at=now() where item_id=item;
  return jsonb_build_object('previous_quantity',old_qty,'previous_average_unit_cost',old_avg,'quantity_balance_after',next_qty,
    'average_unit_cost_after',next_avg,'inventory_value_after',next_value,'tracked_value_delta',value_delta);
end;
$$;

create or replace function public.inventory_deliver_pos_item(item_id uuid, direct_delivery boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); line public.pos_order_items; ord public.pos_orders; v_consumption_id uuid; component record; allowed text[]; cost_state public.inventory_item_valuations; valuation jsonb; consumption_line_id uuid;
begin
  if not public.inventory_is_active_staff() then raise exception 'Acceso operativo denegado'; end if;
  perform pg_advisory_xact_lock(hashtext(item_id::text));
  select * into line from public.pos_order_items where id=item_id for update;
  if not found then raise exception 'Producto del pedido inexistente'; end if;
  if line.operational_status='delivered' then return to_jsonb(line); end if;
  if line.operational_status='cancelled' then raise exception 'La linea esta cancelada'; end if;
  allowed:=case when direct_delivery then array['sent','pending_preparation','in_process','ready','picking_up'] else array['ready','picking_up'] end;
  if not line.operational_status=any(allowed) then raise exception 'La linea no esta lista para esta entrega'; end if;
  if direct_delivery and not exists(select 1 from public.pos_operational_flow_settings f where f.area=line.prep_area and f.use_direct_delivery) then raise exception 'La entrega directa no esta habilitada para esta area'; end if;
  select * into ord from public.pos_orders where id=line.order_id;
  insert into public.inventory_pos_consumptions(pos_order_item_id,order_id,sales_session_id,menu_item_source_key,menu_quantity,recipe_control_mode,consumed_by)
    values(line.id,line.order_id,ord.sales_session_id,line.menu_item_source_key,line.quantity,(select control_mode from public.inventory_menu_tracking where menu_item_source_key=line.menu_item_source_key),actor)
    on conflict(pos_order_item_id) do update set pos_order_item_id=excluded.pos_order_item_id returning id into v_consumption_id;
  for component in select r.item_id,r.quantity_base,i.name,i.base_unit,i.tracking_started_at from public.inventory_menu_recipe_components r join public.inventory_items i on i.id=r.item_id where r.menu_item_source_key=line.menu_item_source_key and r.active and i.active
  loop
    insert into public.inventory_item_valuations(item_id,current_quantity) values(component.item_id,coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.item_id=component.item_id),0)) on conflict on constraint inventory_item_valuations_pkey do nothing;
    select * into cost_state from public.inventory_item_valuations where inventory_item_valuations.item_id=component.item_id for update;
    insert into public.inventory_pos_consumption_lines(consumption_id,item_id,item_name_snapshot,base_unit_snapshot,quantity_per_menu_unit_snapshot,quantity_consumed,average_unit_cost_snapshot,tracked_cost)
      values(v_consumption_id,component.item_id,component.name,component.base_unit,component.quantity_base,component.quantity_base*line.quantity,
        case when component.tracking_started_at is null then null else cost_state.average_unit_cost end,
        case when component.tracking_started_at is null or cost_state.average_unit_cost is null then null else round(component.quantity_base*line.quantity*cost_state.average_unit_cost,6) end)
      returning id into consumption_line_id;
    if component.tracking_started_at is not null then
      valuation:=public.inventory_apply_valuation(component.item_id,-(component.quantity_base*line.quantity),null,'outgoing');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('pos:'||line.id||':'||consumption_line_id,component.item_id,'pos_consumption',-(component.quantity_base*line.quantity),component.base_unit,'Entrega POS',actor,ord.sales_session_id,line.order_id,line.id,consumption_line_id,
        jsonb_build_object('menu_item_source_key',line.menu_item_source_key,'quantity_per_menu_unit',component.quantity_base,'menu_quantity',line.quantity),cost_state.average_unit_cost,
        (valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
    end if;
  end loop;
  update public.pos_order_items set operational_status='delivered',delivered_at=now(),delivered_by_email=actor,ready_at=coalesce(ready_at,now()),updated_by_email=actor where id=line.id returning * into line;
  insert into public.pos_order_status_logs(order_id,order_item_id,event_type,actor_email,after_data,notes) values(line.order_id,line.id,case when direct_delivery then 'item_direct_delivered' else 'item_delivered' end,actor,to_jsonb(line),'Entrega, cantidad y costo rastreado de inventario atomicos');
  return to_jsonb(line);
end;
$$;

create or replace function public.inventory_read() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a inventario'; end if;
  select jsonb_build_object(
    'can_manage',costs,'can_configure',public.inventory_can_configure(),
    'items',coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('id',i.id,'name',i.name,'active',i.active,'base_unit',i.base_unit,'precision_scale',i.precision_scale,
        'minimum_quantity',i.minimum_quantity,'target_quantity',i.target_quantity,'tracking_started_at',i.tracking_started_at,
        'balance',case when i.tracking_started_at is null then null else coalesce(v.current_quantity,0) end,
        'pending_incoming',coalesce((select sum(greatest(coalesce(l.approved_quantity,0)-l.received_quantity,0)) from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.item_id=i.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received')),0),
        'last_unit_cost',case when costs then v.average_unit_cost else null end,'average_unit_cost',case when costs then v.average_unit_cost else null end,
        'inventory_value',case when costs then v.inventory_value else null end,
        'areas',coalesce((select jsonb_agg(a.area order by a.area) from public.inventory_item_areas a where a.item_id=i.id),'[]'::jsonb)) x
      from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where public.inventory_item_visible(i.id)
    ) q),'[]'::jsonb),
    'presentations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'item_id',p.item_id,'name',p.name,'content_per_package',p.content_per_package,'content_unit',p.content_unit,'active',p.active,'suggested_package_cost',case when costs then p.suggested_package_cost else null end) order by p.name) from public.inventory_purchase_presentations p where public.inventory_item_visible(p.item_id)),'[]'::jsonb),
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name,'tracked_component_cost',case when v.average_unit_cost is null then null else round(r.quantity_base*v.average_unit_cost,6) end) order by mi.name) from public.inventory_menu_recipe_components r join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key left join public.inventory_item_valuations v on v.item_id=r.item_id),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',source_key,'name',name) order by name) from public.menu_items),'[]'::jsonb) else '[]'::jsonb end,
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes)),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) order by s.created_at desc) from public.inventory_submissions s where costs or (lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))),'[]'::jsonb),
    'receipts',case when costs then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'supplier',r.supplier,'document_reference',r.document_reference,'expense_movement_id',r.expense_movement_id,'total_cost',r.total_cost,'received_at',r.received_at,'received_by',r.received_by,'notes',r.notes,'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from public.inventory_receipt_lines l where l.receipt_id=r.id)) order by r.received_at desc) from public.inventory_receipts r),'[]'::jsonb) else '[]'::jsonb end,
    'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'item_id',m.item_id,'item_name',i.name,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'base_unit_snapshot',m.base_unit_snapshot,'reason',m.reason,'actor',m.actor,'occurred_at',m.occurred_at,'sales_session_id',m.sales_session_id,'order_id',m.order_id,'order_item_id',m.order_item_id,'unit_cost_snapshot',case when costs then m.unit_cost_snapshot else null end,'tracked_value_delta',case when costs then m.tracked_value_delta else null end,'quantity_balance_after',m.quantity_balance_after,'average_unit_cost_after',case when costs then m.average_unit_cost_after else null end,'inventory_value_after',case when costs then m.inventory_value_after else null end,'metadata',case when costs then m.metadata else m.metadata-'cost'-'supplier'-'unit_cost'-'base_unit_cost'-'line_total_cost' end) order by m.occurred_at desc) from public.inventory_movements m join public.inventory_items i on i.id=m.item_id where public.inventory_item_visible(m.item_id)),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.inventory_void_processed_item(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); previous public.inventory_command_audit; line public.pos_order_items; cancelled public.pos_order_items; active_line public.pos_order_items; void_qty integer; reason text; next_total numeric; paid numeric; resolution jsonb; cl public.inventory_pos_consumption_lines; required_qty numeric; returned_qty numeric; waste_qty numeric; internal_qty numeric; client_qty numeric; result jsonb; valuation jsonb;
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
    for cl in select x.* from public.inventory_pos_consumptions c join public.inventory_pos_consumption_lines x on x.consumption_id=c.id where c.pos_order_item_id=line.id for update of x loop
      required_qty:=cl.quantity_per_menu_unit_snapshot*void_qty;
      select value into resolution from jsonb_array_elements(coalesce(payload->'resolutions','[]'::jsonb)) where value->>'consumption_line_id'=cl.id::text;
      if resolution is null then raise exception 'Indica el destino de cada componente consumido'; end if;
      returned_qty:=coalesce((resolution->>'returned_quantity')::numeric,0); waste_qty:=coalesce((resolution->>'waste_quantity')::numeric,0); internal_qty:=coalesce((resolution->>'internal_quantity')::numeric,0); client_qty:=coalesce((resolution->>'client_consumed_quantity')::numeric,0);
      if least(returned_qty,waste_qty,internal_qty,client_qty)<0 or returned_qty+waste_qty+internal_qty+client_qty<>required_qty or cl.returned_quantity+cl.waste_quantity+cl.internal_quantity+cl.client_consumed_quantity+required_qty>cl.quantity_consumed then raise exception 'La resolucion del componente no coincide con la cantidad anulada'; end if;
      update public.inventory_pos_consumption_lines set returned_quantity=returned_quantity+returned_qty,waste_quantity=waste_quantity+waste_qty,internal_quantity=internal_quantity+internal_qty,client_consumed_quantity=client_consumed_quantity+client_qty where id=cl.id;
      if returned_qty>0 then
        valuation:=public.inventory_apply_valuation(cl.item_id,returned_qty,cl.average_unit_cost_snapshot,'return');
        insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
        select 'void:return:'||request_id||':'||cl.id,cl.item_id,'recoverable_return',returned_qty,cl.base_unit_snapshot,reason,actor,c.sales_session_id,c.order_id,line.id,cl.id,jsonb_build_object('resolved_quantity',returned_qty,'original_consumption_cost',cl.tracked_cost),cl.average_unit_cost_snapshot,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric from public.inventory_pos_consumptions c where c.id=cl.consumption_id;
      end if;
      if waste_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata) values('void:waste:'||request_id||':'||cl.id,cl.item_id,'waste',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',waste_qty,'already_consumed',true)); end if;
      if internal_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata) values('void:internal:'||request_id||':'||cl.id,cl.item_id,'internal_consumption',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',internal_qty,'already_consumed',true)); end if;
      resolution:=null;
    end loop;
  end if;
  if void_qty=line.quantity then
    update public.pos_order_items set cancellation_reason=reason,cancelled_at=now(),cancelled_by_email=actor,financial_status='cancelled',operational_status='cancelled',updated_by_email=actor where id=line.id returning * into cancelled; result:=jsonb_build_array(to_jsonb(cancelled));
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

create or replace function public.inventory_command(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); action text:=payload->>'action'; previous public.inventory_command_audit; result jsonb; item public.inventory_items; pres public.inventory_purchase_presentations; sub public.inventory_submissions; subline public.inventory_submission_lines; line jsonb; receipt public.inventory_receipts; receipt_line_id uuid; qty numeric; current_balance numeric; target_balance numeric; expense public.pos_cash_movements; valuation jsonb; actual_package_cost numeric; line_total numeric; base_cost numeric; derived_total numeric:=0; all_costs_known boolean:=true; initial_cost numeric;
begin
  if request_id is null or payload is null or not public.inventory_is_active_staff() then raise exception 'Solicitud de inventario invalida o no autorizada'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_command.request_id;
  if found then if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if; return previous.result; end if;
  if action='save_item' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura articulos'; end if;
    if payload->>'id' is null then insert into public.inventory_items(name,active,base_unit,precision_scale,minimum_quantity,target_quantity,created_by,updated_by) values(trim(payload->>'name'),coalesce((payload->>'active')::boolean,true),payload->>'base_unit',coalesce((payload->>'precision_scale')::smallint,0),(payload->>'minimum_quantity')::numeric,(payload->>'target_quantity')::numeric,actor,actor) returning * into item;
    else update public.inventory_items set name=trim(payload->>'name'),active=coalesce((payload->>'active')::boolean,active),minimum_quantity=(payload->>'minimum_quantity')::numeric,target_quantity=(payload->>'target_quantity')::numeric,updated_at=now(),updated_by=actor where id=(payload->>'id')::uuid returning * into item; if not found then raise exception 'Articulo inexistente'; end if; end if;
    delete from public.inventory_item_areas where item_id=item.id; insert into public.inventory_item_areas(item_id,area) select item.id,value from jsonb_array_elements_text(coalesce(payload->'areas','[]'::jsonb)) where value in ('bar','kitchen') on conflict do nothing; result:=to_jsonb(item);
  elsif action='save_presentation' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura presentaciones'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid;
    if not found or payload->>'content_unit'<>item.base_unit then raise exception 'La unidad de la presentacion debe coincidir con la unidad base; no se convierten gramos y mililitros'; end if;
    if payload->>'id' is null then insert into public.inventory_purchase_presentations(item_id,name,content_per_package,content_unit,suggested_package_cost,created_by,updated_by) values(item.id,trim(payload->>'name'),(payload->>'content_per_package')::numeric,payload->>'content_unit',(payload->>'suggested_package_cost')::numeric,actor,actor) returning * into pres;
    else update public.inventory_purchase_presentations set name=trim(payload->>'name'),content_per_package=(payload->>'content_per_package')::numeric,suggested_package_cost=(payload->>'suggested_package_cost')::numeric,active=coalesce((payload->>'active')::boolean,active),updated_at=now(),updated_by=actor where id=(payload->>'id')::uuid and item_id=item.id returning * into pres; end if; result:=to_jsonb(pres);
  elsif action='save_recipe' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura consumo del menu'; end if;
    insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by) values(payload->>'menu_item_source_key',coalesce(payload->>'control_mode','partial'),actor) on conflict(menu_item_source_key) do update set control_mode=excluded.control_mode,updated_at=now(),updated_by=actor;
    update public.inventory_menu_recipe_components set active=false,updated_at=now(),updated_by=actor where menu_item_source_key=payload->>'menu_item_source_key';
    for line in select value from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) loop insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,quantity_base,active,created_by,updated_by) values(payload->>'menu_item_source_key',(line->>'item_id')::uuid,(line->>'quantity_base')::numeric,true,actor,actor) on conflict(menu_item_source_key,item_id) do update set quantity_base=excluded.quantity_base,active=true,updated_at=now(),updated_by=actor; end loop; result:=jsonb_build_object('menu_item_source_key',payload->>'menu_item_source_key');
  elsif action='initial_count' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja activa el conteo inicial'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid for update; if item.tracking_started_at is not null then raise exception 'El articulo ya tiene conteo inicial'; end if;
    qty:=(payload->>'quantity')::numeric; initial_cost:=(payload->>'initial_unit_cost')::numeric; if qty<0 or initial_cost<0 then raise exception 'Cantidad o costo inicial invalido'; end if;
    update public.inventory_items set tracking_started_at=now(),updated_at=now(),updated_by=actor where id=item.id;
    valuation:=public.inventory_apply_valuation(item.id,qty,initial_cost,'initial');
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('initial:'||request_id,item.id,'initial_count',qty,item.base_unit,coalesce(nullif(trim(payload->>'reason'),''),'Conteo inicial'),actor,jsonb_build_object('counted_quantity',qty,'cost_known',initial_cost is not null),initial_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric) returning to_jsonb(inventory_movements.*) into result;
  elsif action='submit' then
    if not (public.inventory_can_manage() or public.has_staff_role(payload->>'area')) or payload->>'area' not in ('bar','kitchen') then raise exception 'Area no autorizada'; end if;
    insert into public.inventory_submissions(request_id,kind,area,status,sales_session_id,notes,submitted_at,created_by) values(request_id,payload->>'kind',payload->>'area',coalesce(payload->>'status','sent'),(payload->>'sales_session_id')::uuid,coalesce(payload->>'notes',''),case when coalesce(payload->>'status','sent')='sent' then now() end,actor) returning * into sub;
    for line in select value from jsonb_array_elements(payload->'lines') loop if not public.inventory_item_visible((line->>'item_id')::uuid) or not exists(select 1 from public.inventory_item_areas a where a.item_id=(line->>'item_id')::uuid and a.area=payload->>'area') then raise exception 'Articulo no autorizado para el area'; end if; select case when i.tracking_started_at is null then null else v.current_quantity end into current_balance from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where i.id=(line->>'item_id')::uuid; insert into public.inventory_submission_lines(submission_id,item_id,requested_quantity,observed_quantity,reference_balance,reference_at,notes) values(sub.id,(line->>'item_id')::uuid,(line->>'requested_quantity')::numeric,(line->>'observed_quantity')::numeric,current_balance,now(),coalesce(line->>'notes','')); end loop; result:=to_jsonb(sub);
  elsif action='send_submission' then
    select * into sub from public.inventory_submissions where id=(payload->>'submission_id')::uuid for update; if not found or sub.status<>'draft' or (lower(sub.created_by)<>actor and not public.inventory_can_manage()) then raise exception 'Borrador no disponible'; end if; update public.inventory_submissions set status='sent',submitted_at=now() where id=sub.id returning to_jsonb(inventory_submissions.*) into result;
  elsif action='review_submission' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja revisa solicitudes'; end if;
    select * into sub from public.inventory_submissions where id=(payload->>'submission_id')::uuid for update; if not found or sub.status not in ('sent','partially_approved') then raise exception 'Solicitud no disponible para revision'; end if;
    for line in select value from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) loop
      update public.inventory_submission_lines set approved_quantity=(line->>'approved_quantity')::numeric where id=(line->>'line_id')::uuid and submission_id=sub.id;
      if sub.kind in ('damage','count') and coalesce((line->>'approved_quantity')::numeric,0)>=0 then
        select i.* into item from public.inventory_items i where i.id=(select item_id from public.inventory_submission_lines where id=(line->>'line_id')::uuid); if item.tracking_started_at is null then raise exception 'El articulo requiere conteo inicial'; end if;
        if sub.kind='damage' then qty:=-(line->>'approved_quantity')::numeric; else select l.observed_quantity + coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.item_id=l.item_id and m.occurred_at>l.reference_at),0) into target_balance from public.inventory_submission_lines l where l.id=(line->>'line_id')::uuid; select current_quantity into current_balance from public.inventory_item_valuations where item_id=item.id; qty:=target_balance-current_balance; end if;
        if qty<>0 then valuation:=public.inventory_apply_valuation(item.id,qty,null,'adjustment'); insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,submission_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after) values('review:'||request_id||':'||(line->>'line_id'),item.id,case when sub.kind='damage' then 'waste' else 'count_adjustment' end,qty,item.base_unit,coalesce(nullif(trim(payload->>'notes'),''),case when sub.kind='damage' then 'Merma aprobada' else 'Ajuste por conteo' end),actor,sub.id,jsonb_build_object('reference_at',(select reference_at from public.inventory_submission_lines where id=(line->>'line_id')::uuid),'target_balance',target_balance),(valuation->>'previous_average_unit_cost')::numeric,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric); end if;
      end if;
    end loop;
    update public.inventory_submissions set status=payload->>'status',reviewed_at=now(),reviewed_by=actor,review_notes=payload->>'notes' where id=sub.id returning to_jsonb(inventory_submissions.*) into result;
  elsif action='receive' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja recibe compras'; end if;
    if coalesce(jsonb_array_length(payload->'lines'),0)=0 then raise exception 'La recepcion requiere lineas'; end if;
    derived_total:=0; all_costs_known:=true;
    for line in select value from jsonb_array_elements(payload->'lines') loop
      select * into item from public.inventory_items where id=(line->>'item_id')::uuid;
      if not found then raise exception 'Articulo inexistente'; end if;
      pres:=null; actual_package_cost:=null; line_total:=null; base_cost:=null;
      if line->>'presentation_id' is not null then
        select * into pres from public.inventory_purchase_presentations where id=(line->>'presentation_id')::uuid and item_id=item.id and active; if not found then raise exception 'Presentacion inexistente o inactiva'; end if;
        qty:=pres.content_per_package*(line->>'package_quantity')::numeric; actual_package_cost:=coalesce((line->>'actual_package_cost')::numeric,case when line->>'unit_cost' is not null then round((line->>'unit_cost')::numeric*pres.content_per_package,2) end);
        if actual_package_cost is not null then line_total:=round((line->>'package_quantity')::numeric*actual_package_cost,2); end if;
      else
        qty:=(line->>'base_quantity')::numeric;
        if line->>'line_total_cost' is not null then line_total:=round((line->>'line_total_cost')::numeric,2);
        elsif line->>'base_unit_cost' is not null then line_total:=round(qty*(line->>'base_unit_cost')::numeric,2);
        elsif line->>'unit_cost' is not null then line_total:=round(qty*(line->>'unit_cost')::numeric,2); end if;
        if line->>'line_total_cost' is not null and line->>'base_unit_cost' is not null and round(qty*(line->>'base_unit_cost')::numeric,2)<>line_total then raise exception 'El costo total y el costo unitario de la linea no coinciden'; end if;
      end if;
      if qty<=0 then raise exception 'Cantidad recibida invalida'; end if;
      if line_total is null then all_costs_known:=false; else derived_total:=derived_total+line_total; end if;
    end loop;
    derived_total:=case when all_costs_known then round(derived_total,2) else null end;
    if payload->>'total_cost' is not null and (derived_total is null or (payload->>'total_cost')::numeric<>derived_total) then raise exception 'El costo total de la recepcion no coincide con la suma de sus lineas'; end if;
    if payload->>'expense_movement_id' is not null then select * into expense from public.pos_cash_movements where id=(payload->>'expense_movement_id')::uuid; if not found or expense.kind<>'expense' or expense.voided_at is not null then raise exception 'El gasto vinculado no es valido'; end if; if derived_total is null or expense.amount<>derived_total then raise exception 'El importe del gasto vinculado no coincide con el costo de la recepcion'; end if; end if;
    insert into public.inventory_receipts(request_id,supplier,document_reference,expense_movement_id,total_cost,received_at,received_by,notes) values(request_id,nullif(trim(payload->>'supplier'),''),nullif(trim(payload->>'document_reference'),''),(payload->>'expense_movement_id')::uuid,derived_total,coalesce((payload->>'received_at')::timestamptz,now()),actor,coalesce(payload->>'notes','')) returning * into receipt;
    for line in select value from jsonb_array_elements(payload->'lines') loop
      select * into item from public.inventory_items where id=(line->>'item_id')::uuid for update; if item.tracking_started_at is null then raise exception 'Registra primero el conteo inicial de %',item.name; end if;
      pres:=null; actual_package_cost:=null; line_total:=null; base_cost:=null;
      if line->>'presentation_id' is not null then select * into pres from public.inventory_purchase_presentations where id=(line->>'presentation_id')::uuid and item_id=item.id and active; qty:=pres.content_per_package*(line->>'package_quantity')::numeric; actual_package_cost:=coalesce((line->>'actual_package_cost')::numeric,case when line->>'unit_cost' is not null then round((line->>'unit_cost')::numeric*pres.content_per_package,2) end); if actual_package_cost is not null then line_total:=round((line->>'package_quantity')::numeric*actual_package_cost,2); end if;
      else qty:=(line->>'base_quantity')::numeric; if line->>'line_total_cost' is not null then line_total:=round((line->>'line_total_cost')::numeric,2); elsif line->>'base_unit_cost' is not null then line_total:=round(qty*(line->>'base_unit_cost')::numeric,2); elsif line->>'unit_cost' is not null then line_total:=round(qty*(line->>'unit_cost')::numeric,2); end if; end if;
      if line_total is not null then base_cost:=round(line_total/qty,10); end if;
      subline:=null;
      if line->>'submission_line_id' is not null then select l.* into subline from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.id=(line->>'submission_line_id')::uuid and l.item_id=item.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received') for update of l; if not found or subline.approved_quantity is null or subline.received_quantity+qty>subline.approved_quantity then raise exception 'La recepcion supera la cantidad aprobada o no corresponde a la solicitud'; end if; end if;
      insert into public.inventory_receipt_lines(receipt_id,item_id,presentation_id,presentation_name_snapshot,content_per_package_snapshot,content_unit_snapshot,package_quantity,base_quantity,unit_cost,submission_line_id,actual_package_cost,line_total_cost,base_unit_cost)
        values(receipt.id,item.id,pres.id,pres.name,pres.content_per_package,pres.content_unit,(line->>'package_quantity')::numeric,qty,case when base_cost is null then null else round(base_cost,4) end,(line->>'submission_line_id')::uuid,actual_package_cost,line_total,base_cost) returning id into receipt_line_id;
      valuation:=public.inventory_apply_valuation(item.id,qty,base_cost,'receipt');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,receipt_id,submission_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
        values('receipt-line:'||receipt_line_id,item.id,'purchase_receipt',qty,item.base_unit,'Recepcion de compra',actor,receipt.id,subline.submission_id,jsonb_build_object('presentation_name',pres.name,'content_per_package',pres.content_per_package,'package_quantity',line->>'package_quantity','actual_package_cost',actual_package_cost,'line_total_cost',line_total,'base_unit_cost',base_cost),base_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
      if line->>'submission_line_id' is not null then update public.inventory_submission_lines set received_quantity=received_quantity+qty where id=(line->>'submission_line_id')::uuid; end if;
      if subline.submission_id is not null then update public.inventory_submissions s set status=case when not exists(select 1 from public.inventory_submission_lines l where l.submission_id=s.id and coalesce(l.approved_quantity,0)>l.received_quantity) then 'received' else 'partially_received' end where s.id=subline.submission_id; end if;
    end loop; result:=to_jsonb(receipt);
  elsif action='correction' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja registra correcciones'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid; qty:=(payload->>'quantity_delta')::numeric; if qty=0 or nullif(trim(payload->>'reason'),'') is null then raise exception 'Correccion invalida'; end if;
    valuation:=public.inventory_apply_valuation(item.id,qty,null,'adjustment');
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('correction:'||request_id,item.id,'correction',qty,item.base_unit,payload->>'reason',actor,payload-'action',(valuation->>'previous_average_unit_cost')::numeric,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric) returning to_jsonb(inventory_movements.*) into result;
  else raise exception 'Operacion de inventario desconocida'; end if;
  insert into public.inventory_command_audit(request_id,actor,payload,result) values(request_id,actor,payload,result); return result;
end;
$$;

alter table public.inventory_item_valuations enable row level security;
revoke all on public.inventory_item_valuations from public,anon,authenticated;
revoke all on function public.inventory_apply_valuation(uuid,numeric,numeric,text) from public,anon,authenticated;
commit;
