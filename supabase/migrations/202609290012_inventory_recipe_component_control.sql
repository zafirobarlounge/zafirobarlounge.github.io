-- Incremental upgrade AFTER 202609290011_dynamic_inventory_areas.sql. Manual review/application in QA.
-- Separates descriptive recipe components from components that control POS inventory.
begin;

-- A. Component-level inventory control. Existing recipes remain controlled.
alter table public.inventory_menu_recipe_components
  add column controls_inventory boolean not null default true;

alter table public.inventory_menu_recipe_components
  alter column quantity_base drop not null;

alter table public.inventory_menu_recipe_components
  drop constraint if exists inventory_menu_recipe_components_quantity_base_check;

alter table public.inventory_menu_recipe_components
  add constraint inventory_menu_recipe_components_control_quantity_check check (
    (controls_inventory and quantity_base is not null and quantity_base > 0)
    or
    (not controls_inventory and quantity_base is null)
  );

-- B. POS consumes, values and snapshots only controlled components.
create or replace function public.inventory_deliver_pos_item(item_id uuid, direct_delivery boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); line public.pos_order_items; ord public.pos_orders; v_consumption_id uuid; component record; allowed text[]; cost_state public.inventory_item_valuations; valuation jsonb; consumption_line_id uuid; operational_cost numeric; operational_value_delta numeric;
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
  for component in select r.item_id,r.quantity_base,i.name,i.base_unit,i.tracking_started_at from public.inventory_menu_recipe_components r join public.inventory_items i on i.id=r.item_id where r.menu_item_source_key=line.menu_item_source_key and r.active and r.controls_inventory and i.active
  loop
    insert into public.inventory_item_valuations(item_id,current_quantity) values(component.item_id,coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.item_id=component.item_id),0)) on conflict on constraint inventory_item_valuations_pkey do nothing;
    select * into cost_state from public.inventory_item_valuations where inventory_item_valuations.item_id=component.item_id for update;
    operational_cost:=case when component.tracking_started_at is null then null else cost_state.last_unit_cost end;
    operational_value_delta:=case when operational_cost is null then null else round(-(component.quantity_base*line.quantity)*operational_cost,6) end;
    insert into public.inventory_pos_consumption_lines(consumption_id,item_id,item_name_snapshot,base_unit_snapshot,quantity_per_menu_unit_snapshot,quantity_consumed,average_unit_cost_snapshot,last_unit_cost_snapshot,tracked_cost)
      values(v_consumption_id,component.item_id,component.name,component.base_unit,component.quantity_base,component.quantity_base*line.quantity,
        case when component.tracking_started_at is null then null else cost_state.average_unit_cost end,operational_cost,
        case when operational_cost is null then null else round(component.quantity_base*line.quantity*operational_cost,6) end)
      returning id into consumption_line_id;
    if component.tracking_started_at is not null then
      valuation:=public.inventory_apply_valuation(component.item_id,-(component.quantity_base*line.quantity),null,'outgoing');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('pos:'||line.id||':'||consumption_line_id,component.item_id,'pos_consumption',-(component.quantity_base*line.quantity),component.base_unit,'Entrega POS',actor,ord.sales_session_id,line.order_id,line.id,consumption_line_id,
        jsonb_build_object('menu_item_source_key',line.menu_item_source_key,'quantity_per_menu_unit',component.quantity_base,'menu_quantity',line.quantity,'cost_basis','last_actual_purchase'),operational_cost,
        operational_value_delta,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
    end if;
  end loop;
  update public.pos_order_items set operational_status='delivered',delivered_at=now(),delivered_by_email=actor,ready_at=coalesce(ready_at,now()),updated_by_email=actor where id=line.id returning * into line;
  insert into public.pos_order_status_logs(order_id,order_item_id,event_type,actor_email,after_data,notes) values(line.order_id,line.id,case when direct_delivery then 'item_direct_delivered' else 'item_delivered' end,actor,to_jsonb(line),'Entrega, cantidad y ultimo costo real de inventario atomicos');
  return to_jsonb(line);
end;
$$;

-- C. Availability alerts ignore descriptive-only components.
create or replace function public.inventory_menu_alerts() returns jsonb
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
    from public.inventory_menu_tracking t join public.inventory_menu_recipe_components r on r.menu_item_source_key=t.menu_item_source_key and r.active and r.controls_inventory
    join public.inventory_items i on i.id=r.item_id and i.active join balances b on b.id=i.id group by t.menu_item_source_key,t.control_mode
  )
  select coalesce(jsonb_agg(jsonb_build_object('menu_item_source_key',menu_item_source_key,'control_mode',control_mode,'has_uncounted',has_uncounted,'cannot_make_one',cannot_make_one,'controlled_units_available',controlled_units_available)),'[]'::jsonb) into result from alerts;
  return result;
end;
$$;

-- D. Recipe writes validate and persist the component-level flag.
-- control_mode remains stored for historical compatibility but no longer drives behavior.
create or replace function public.inventory_command(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); action text:=payload->>'action'; previous public.inventory_command_audit; result jsonb; item public.inventory_items; pres public.inventory_purchase_presentations; sub public.inventory_submissions; subline public.inventory_submission_lines; line jsonb; receipt public.inventory_receipts; receipt_line_id uuid; qty numeric; current_balance numeric; target_balance numeric; expense public.pos_cash_movements; valuation jsonb; actual_package_cost numeric; line_total numeric; base_cost numeric; derived_total numeric:=0; all_costs_known boolean:=true; initial_cost numeric; pending_qty numeric; applied_qty numeric; area_code text; requested_areas text[];
begin
  if request_id is null or payload is null or not public.inventory_is_active_staff() then raise exception 'Solicitud de inventario invalida o no autorizada'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_command.request_id;
  if found then if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if; return previous.result; end if;
  if action='save_area' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura areas'; end if;
    if payload->>'id' is null then
      area_code:=lower(trim(payload->>'code'));
      if area_code is null or area_code !~ '^[a-z][a-z0-9_]*$' then raise exception 'Codigo de area invalido'; end if;
      insert into public.inventory_areas(code,name,active,operational,system_protected,created_by,updated_by) values(area_code,trim(payload->>'name'),coalesce((payload->>'active')::boolean,true),false,false,actor,actor) returning code into area_code;
    else
      select code into area_code from public.inventory_areas where id=(payload->>'id')::uuid for update;
      if not found then raise exception 'Area inexistente'; end if;
      if area_code in ('bar','kitchen') and coalesce((payload->>'active')::boolean,true)=false then raise exception 'Barra y Cocina son areas protegidas del POS y no pueden desactivarse'; end if;
      update public.inventory_areas set name=trim(payload->>'name'),active=case when system_protected then true else coalesce((payload->>'active')::boolean,active) end,updated_at=now(),updated_by=actor where code=area_code;
    end if;
    select to_jsonb(a) into result from public.inventory_areas a where a.code=area_code;
  elsif action='save_item' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura articulos'; end if;
    if payload->>'id' is null then insert into public.inventory_items(name,active,base_unit,precision_scale,minimum_quantity,target_quantity,created_by,updated_by) values(trim(payload->>'name'),coalesce((payload->>'active')::boolean,true),payload->>'base_unit',coalesce((payload->>'precision_scale')::smallint,0),(payload->>'minimum_quantity')::numeric,(payload->>'target_quantity')::numeric,actor,actor) returning * into item;
    else update public.inventory_items set name=trim(payload->>'name'),active=coalesce((payload->>'active')::boolean,active),minimum_quantity=(payload->>'minimum_quantity')::numeric,target_quantity=(payload->>'target_quantity')::numeric,updated_at=now(),updated_by=actor where id=(payload->>'id')::uuid returning * into item; if not found then raise exception 'Articulo inexistente'; end if; end if;
    requested_areas:=array(select distinct value from jsonb_array_elements_text(coalesce(payload->'areas','[]'::jsonb)));
    if coalesce(cardinality(requested_areas),0)=0 then raise exception 'Selecciona al menos un area responsable'; end if;
    if exists(select 1 from unnest(requested_areas) requested(code) left join public.inventory_areas a on a.code=requested.code where a.code is null or (not a.active and not exists(select 1 from public.inventory_item_areas current_area where current_area.item_id=item.id and current_area.area=requested.code))) then raise exception 'Area inexistente o inactiva'; end if;
    if exists(select 1 from public.inventory_menu_recipe_components r where r.item_id=item.id and r.active) and not (requested_areas && array['bar','kitchen']::text[]) then raise exception 'Un articulo con receta activa debe conservar Barra o Cocina'; end if;
    delete from public.inventory_item_areas where item_id=item.id; insert into public.inventory_item_areas(item_id,area) select item.id,unnest(requested_areas) on conflict do nothing; result:=to_jsonb(item);
  elsif action='save_presentation' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura presentaciones'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid;
    if not found or payload->>'content_unit'<>item.base_unit then raise exception 'La unidad de la presentacion debe coincidir con la unidad base; no se convierten gramos y mililitros'; end if;
    if payload->>'id' is null then insert into public.inventory_purchase_presentations(item_id,name,content_per_package,content_unit,suggested_package_cost,created_by,updated_by) values(item.id,trim(payload->>'name'),(payload->>'content_per_package')::numeric,payload->>'content_unit',(payload->>'suggested_package_cost')::numeric,actor,actor) returning * into pres;
    else update public.inventory_purchase_presentations set name=trim(payload->>'name'),content_per_package=(payload->>'content_per_package')::numeric,suggested_package_cost=(payload->>'suggested_package_cost')::numeric,active=coalesce((payload->>'active')::boolean,active),updated_at=now(),updated_by=actor where id=(payload->>'id')::uuid and item_id=item.id returning * into pres; end if; result:=to_jsonb(pres);
  elsif action='save_recipe' then
    if not public.inventory_can_configure() then raise exception 'Solo administracion configura consumo del menu'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) component where not exists(select 1 from public.inventory_item_areas a where a.item_id=(component->>'item_id')::uuid and a.area in ('bar','kitchen'))) then raise exception 'Las recetas POS solo admiten articulos asignados a Barra o Cocina'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) component where coalesce((component->>'controls_inventory')::boolean,true) and (component->>'quantity_base' is null or (component->>'quantity_base')::numeric<=0)) then raise exception 'Los componentes controlados requieren una cantidad mayor que cero'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) component where not coalesce((component->>'controls_inventory')::boolean,true) and component->>'quantity_base' is not null) then raise exception 'Los componentes descriptivos no deben tener cantidad de consumo'; end if;
    insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by)
      values(payload->>'menu_item_source_key',coalesce((select control_mode from public.inventory_menu_tracking where menu_item_source_key=payload->>'menu_item_source_key'),'partial'),actor)
      on conflict(menu_item_source_key) do update set updated_at=now(),updated_by=actor;
    update public.inventory_menu_recipe_components set active=false,updated_at=now(),updated_by=actor where menu_item_source_key=payload->>'menu_item_source_key';
    for line in select value from jsonb_array_elements(coalesce(payload->'components','[]'::jsonb)) loop
      insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,controls_inventory,quantity_base,active,created_by,updated_by)
      values(payload->>'menu_item_source_key',(line->>'item_id')::uuid,coalesce((line->>'controls_inventory')::boolean,true),case when coalesce((line->>'controls_inventory')::boolean,true) then (line->>'quantity_base')::numeric else null end,true,actor,actor)
      on conflict(menu_item_source_key,item_id) do update set controls_inventory=excluded.controls_inventory,quantity_base=excluded.quantity_base,active=true,updated_at=now(),updated_by=actor;
    end loop; result:=jsonb_build_object('menu_item_source_key',payload->>'menu_item_source_key');
  elsif action='initial_count' then
    if not public.inventory_can_manage() then raise exception 'Solo administracion o caja activa el conteo inicial'; end if;
    select * into item from public.inventory_items where id=(payload->>'item_id')::uuid for update; if item.tracking_started_at is not null then raise exception 'El articulo ya tiene conteo inicial'; end if;
    qty:=(payload->>'quantity')::numeric; initial_cost:=(payload->>'initial_unit_cost')::numeric; if qty<0 or initial_cost<0 then raise exception 'Cantidad o costo inicial invalido'; end if;
    update public.inventory_items set tracking_started_at=now(),updated_at=now(),updated_by=actor where id=item.id;
    valuation:=public.inventory_apply_valuation(item.id,qty,initial_cost,'initial');
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('initial:'||request_id,item.id,'initial_count',qty,item.base_unit,coalesce(nullif(trim(payload->>'reason'),''),'Conteo inicial'),actor,jsonb_build_object('counted_quantity',qty,'cost_known',initial_cost is not null),initial_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric) returning to_jsonb(inventory_movements.*) into result;
  elsif action='submit' then
    area_code:=payload->>'area';
    if not exists(select 1 from public.inventory_areas a where a.code=area_code and a.active) then raise exception 'Area inexistente o inactiva'; end if;
    if not (public.inventory_can_manage() or (area_code in ('bar','kitchen') and public.has_staff_role(area_code))) then raise exception 'Area no autorizada'; end if;
    insert into public.inventory_submissions(request_id,kind,area,status,sales_session_id,notes,submitted_at,created_by) values(request_id,payload->>'kind',payload->>'area',coalesce(payload->>'status','sent'),(payload->>'sales_session_id')::uuid,coalesce(payload->>'notes',''),case when coalesce(payload->>'status','sent')='sent' then now() end,actor) returning * into sub;
    for line in select value from jsonb_array_elements(payload->'lines') loop if not public.inventory_item_visible((line->>'item_id')::uuid) or not exists(select 1 from public.inventory_item_areas a where a.item_id=(line->>'item_id')::uuid and a.area=payload->>'area') then raise exception 'Articulo no autorizado para el area'; end if; select case when i.tracking_started_at is null then null else v.current_quantity end into current_balance from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where i.id=(line->>'item_id')::uuid; insert into public.inventory_submission_lines(submission_id,item_id,requested_quantity,observed_quantity,reference_balance,reference_at,notes) values(sub.id,(line->>'item_id')::uuid,(line->>'requested_quantity')::numeric,(line->>'observed_quantity')::numeric,current_balance,now(),coalesce(line->>'notes','')); end loop; result:=to_jsonb(sub);
  elsif action='send_submission' then
    select * into sub from public.inventory_submissions where id=(payload->>'submission_id')::uuid for update; if not found or sub.status<>'draft' or (lower(sub.created_by)<>actor and not public.inventory_can_manage()) then raise exception 'Borrador no disponible'; end if; if not exists(select 1 from public.inventory_areas a where a.code=sub.area and a.active) then raise exception 'El area del borrador esta inactiva'; end if; update public.inventory_submissions set status='sent',submitted_at=now() where id=sub.id returning to_jsonb(inventory_submissions.*) into result;
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
      subline:=null; applied_qty:=null; pending_qty:=null;
      if line->>'submission_line_id' is not null then
        select l.* into subline from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.id=(line->>'submission_line_id')::uuid and l.item_id=item.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received') for update of l;
        if not found or subline.approved_quantity is null then raise exception 'La recepcion no corresponde a una solicitud aprobada'; end if;
        pending_qty:=greatest(subline.approved_quantity-subline.received_quantity,0);
        if pending_qty<=0 then raise exception 'La solicitud vinculada ya no tiene cantidad pendiente'; end if;
        applied_qty:=least(pending_qty,qty);
      end if;
      insert into public.inventory_receipt_lines(receipt_id,item_id,presentation_id,presentation_name_snapshot,content_per_package_snapshot,content_unit_snapshot,package_quantity,base_quantity,unit_cost,submission_line_id,applied_submission_quantity,actual_package_cost,line_total_cost,base_unit_cost)
        values(receipt.id,item.id,pres.id,pres.name,pres.content_per_package,pres.content_unit,(line->>'package_quantity')::numeric,qty,case when base_cost is null then null else round(base_cost,4) end,(line->>'submission_line_id')::uuid,applied_qty,actual_package_cost,line_total,base_cost) returning id into receipt_line_id;
      valuation:=public.inventory_apply_valuation(item.id,qty,base_cost,'receipt');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,receipt_id,submission_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
        values('receipt-line:'||receipt_line_id,item.id,'purchase_receipt',qty,item.base_unit,'Recepcion de compra',actor,receipt.id,subline.submission_id,jsonb_build_object('presentation_name',pres.name,'content_per_package',pres.content_per_package,'package_quantity',line->>'package_quantity','actual_package_cost',actual_package_cost,'line_total_cost',line_total,'base_unit_cost',base_cost,'applied_submission_quantity',applied_qty,'excess_quantity',case when applied_qty is null then null else qty-applied_qty end),base_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
      if applied_qty is not null then update public.inventory_submission_lines set received_quantity=least(approved_quantity,received_quantity+applied_qty) where id=(line->>'submission_line_id')::uuid; end if;
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

-- E. Current recipe configuration exposes nullable quantities and the control flag.
create or replace function public.inventory_read() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a inventario'; end if;
  select jsonb_build_object(
    'can_manage',costs,'can_configure',public.inventory_can_configure(),
    'areas',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'active',a.active,'operational',a.operational,'system_protected',a.system_protected) order by a.name) from public.inventory_areas a where a.active or public.inventory_can_configure()),'[]'::jsonb),
    'pending_review_count',(select count(*) from public.inventory_submissions s where s.status in ('sent','partially_approved') and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))),
    'items',coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('id',i.id,'name',i.name,'active',i.active,'base_unit',i.base_unit,'precision_scale',i.precision_scale,
        'minimum_quantity',i.minimum_quantity,'target_quantity',i.target_quantity,'tracking_started_at',i.tracking_started_at,
        'balance',case when i.tracking_started_at is null then null else coalesce(v.current_quantity,0) end,
        'pending_incoming',coalesce((select sum(greatest(coalesce(l.approved_quantity,0)-l.received_quantity,0)) from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.item_id=i.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received')),0),
        'last_unit_cost',case when costs then v.last_unit_cost else null end,'average_unit_cost',case when costs then v.average_unit_cost else null end,
        'inventory_value',case when costs then v.inventory_value else null end,
        'areas',coalesce((select jsonb_agg(a.area order by a.area) from public.inventory_item_areas a where a.item_id=i.id),'[]'::jsonb)) x
      from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where public.inventory_item_visible(i.id)
    ) q),'[]'::jsonb),
    'presentations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'item_id',p.item_id,'name',p.name,'content_per_package',p.content_per_package,'content_unit',p.content_unit,'active',p.active,'suggested_package_cost',case when costs then p.suggested_package_cost else null end) order by p.name) from public.inventory_purchase_presentations p where public.inventory_item_visible(p.item_id)),'[]'::jsonb),
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'controls_inventory',r.controls_inventory,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name,'tracked_component_cost',case when not r.controls_inventory or v.last_unit_cost is null then null else round(r.quantity_base*v.last_unit_cost,6) end) order by mi.name) from public.inventory_menu_recipe_components r join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key left join public.inventory_item_valuations v on v.item_id=r.item_id),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',source_key,'name',name) order by name) from public.menu_items),'[]'::jsonb) else '[]'::jsonb end,
    'submissions','[]'::jsonb,'receipts','[]'::jsonb,'movements','[]'::jsonb
  ) into result;
  return result;
end;
$$;

commit;
