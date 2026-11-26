-- Incremental upgrade AFTER 202609290018_inventory_menu_recipe_overview.sql. Manual review/application in QA.
-- Keeps delivered-item courtesy distinct from internal consumption without changing inventory quantities.
begin;

-- A. Preserve courtesy as a structured, queryable resolution. Existing history remains internal or zero.
alter table public.inventory_pos_consumption_lines
  add column courtesy_quantity numeric(18,3) not null default 0;

alter table public.inventory_pos_consumption_lines
  drop constraint if exists inventory_pos_consumption_lines_check;

alter table public.inventory_pos_consumption_lines
  add constraint inventory_pos_consumption_lines_resolution_total_check check (
    least(returned_quantity,waste_quantity,courtesy_quantity,internal_quantity,client_consumed_quantity)>=0
    and returned_quantity+waste_quantity+courtesy_quantity+internal_quantity+client_consumed_quantity<=quantity_consumed
  );

alter table public.inventory_movements
  drop constraint if exists inventory_movements_movement_type_check;

alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check check (movement_type in (
    'initial_count','purchase_receipt','pos_consumption','recoverable_return','waste',
    'courtesy_consumption','internal_consumption','count_adjustment','correction'
  ));

alter table public.inventory_movements
  drop constraint if exists inventory_movements_quantity_delta_check;

-- The original inline quantity check from migration 005 was auto-named
-- inventory_movements_check by PostgreSQL.
alter table public.inventory_movements
  drop constraint if exists inventory_movements_check;

alter table public.inventory_movements
  add constraint inventory_movements_quantity_delta_check check (
    quantity_delta<>0 or movement_type in ('initial_count','waste','courtesy_consumption','internal_consumption')
  );

-- B. Return only measured, resolvable consumption lines to the delivered-item dialog.
create or replace function public.inventory_get_pos_consumption(item_id uuid, void_quantity integer default 1) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare line public.pos_order_items; result jsonb;
begin
  if not public.inventory_can_manage() then raise exception 'Acceso denegado'; end if;
  if void_quantity<1 then raise exception 'Cantidad de anulacion invalida'; end if;
  select * into line from public.pos_order_items where id=item_id;
  if not found or line.operational_status<>'delivered' then return jsonb_build_object('item_id',item_id,'lines','[]'::jsonb); end if;
  select jsonb_build_object('item_id',line.id,'product_name',line.product_name,'void_quantity',void_quantity,'lines',coalesce(jsonb_agg(jsonb_build_object(
    'consumption_line_id',cl.id,'item_id',cl.item_id,'item_name',cl.item_name_snapshot,'base_unit',cl.base_unit_snapshot,
    'quantity',cl.quantity_per_menu_unit_snapshot*void_quantity,
    'already_resolved',cl.returned_quantity+cl.waste_quantity+cl.courtesy_quantity+cl.internal_quantity+cl.client_consumed_quantity
  ) order by cl.item_name_snapshot),'[]'::jsonb)) into result
  from public.inventory_pos_consumptions c
  join public.inventory_pos_consumption_lines cl on cl.consumption_id=c.id
  where c.pos_order_item_id=line.id
    and cl.quantity_per_menu_unit_snapshot is not null
    and cl.quantity_per_menu_unit_snapshot>0;
  return result;
end;
$$;

-- C. Resolve courtesy separately while retaining the existing cost snapshots and idempotency contract.
create or replace function public.inventory_void_processed_item(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); previous public.inventory_command_audit; line public.pos_order_items; cancelled public.pos_order_items; active_line public.pos_order_items; void_qty integer; reason text; next_total numeric; paid numeric; resolution jsonb; classification text; cl public.inventory_pos_consumption_lines; required_qty numeric; returned_qty numeric; waste_qty numeric; courtesy_qty numeric; internal_qty numeric; client_qty numeric; result jsonb; valuation jsonb; original_unit_cost numeric;
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
    for cl in select x.* from public.inventory_pos_consumptions c join public.inventory_pos_consumption_lines x on x.consumption_id=c.id where c.pos_order_item_id=line.id and x.quantity_per_menu_unit_snapshot is not null and x.quantity_per_menu_unit_snapshot>0 for update of x loop
      required_qty:=cl.quantity_per_menu_unit_snapshot*void_qty;
      select value into resolution from jsonb_array_elements(coalesce(payload->'resolutions','[]'::jsonb)) where value->>'consumption_line_id'=cl.id::text;
      if resolution is null then raise exception 'Indica el destino de cada componente consumido'; end if;
      classification:=nullif(resolution->>'classification','');
      returned_qty:=coalesce((resolution->>'returned_quantity')::numeric,0);
      waste_qty:=coalesce((resolution->>'waste_quantity')::numeric,0);
      courtesy_qty:=coalesce((resolution->>'courtesy_quantity')::numeric,0);
      internal_qty:=coalesce((resolution->>'internal_quantity')::numeric,0);
      client_qty:=coalesce((resolution->>'client_consumed_quantity')::numeric,0);
      if least(returned_qty,waste_qty,courtesy_qty,internal_qty,client_qty)<0
        or returned_qty+waste_qty+courtesy_qty+internal_qty+client_qty<>required_qty
        or cl.returned_quantity+cl.waste_quantity+cl.courtesy_quantity+cl.internal_quantity+cl.client_consumed_quantity+required_qty>cl.quantity_consumed then
        raise exception 'La resolucion del componente no coincide con la cantidad anulada';
      end if;
      if classification is not null and not (
        (classification='returned' and returned_qty=required_qty and waste_qty=0 and courtesy_qty=0 and internal_qty=0 and client_qty=0)
        or (classification='waste' and returned_qty=0 and waste_qty=required_qty and courtesy_qty=0 and internal_qty=0 and client_qty=0)
        or (classification='courtesy' and returned_qty=0 and waste_qty=0 and courtesy_qty=required_qty and internal_qty=0 and client_qty=0)
        or (classification='internal' and returned_qty=0 and waste_qty=0 and courtesy_qty=0 and internal_qty=required_qty and client_qty=0)
      ) then raise exception 'La clasificacion no coincide con el destino del componente'; end if;
      if courtesy_qty>0 and classification is distinct from 'courtesy' then raise exception 'La cortesia requiere clasificacion explicita'; end if;
      update public.inventory_pos_consumption_lines set returned_quantity=returned_quantity+returned_qty,waste_quantity=waste_quantity+waste_qty,courtesy_quantity=courtesy_quantity+courtesy_qty,internal_quantity=internal_quantity+internal_qty,client_consumed_quantity=client_consumed_quantity+client_qty where id=cl.id;
      if returned_qty>0 then
        original_unit_cost:=coalesce(cl.last_unit_cost_snapshot,cl.average_unit_cost_snapshot);
        valuation:=public.inventory_apply_valuation(cl.item_id,returned_qty,original_unit_cost,'return');
        insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,sales_session_id,order_id,order_item_id,consumption_line_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
        select 'void:return:'||request_id||':'||cl.id,cl.item_id,'recoverable_return',returned_qty,cl.base_unit_snapshot,reason,actor,c.sales_session_id,c.order_id,line.id,cl.id,jsonb_build_object('resolved_quantity',returned_qty,'original_consumption_cost',cl.tracked_cost),original_unit_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric from public.inventory_pos_consumptions c where c.id=cl.consumption_id;
      end if;
      if waste_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata) values('void:waste:'||request_id||':'||cl.id,cl.item_id,'waste',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',waste_qty,'already_consumed',true,'classification','waste')); end if;
      if courtesy_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata) values('void:courtesy:'||request_id||':'||cl.id,cl.item_id,'courtesy_consumption',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',courtesy_qty,'already_consumed',true,'classification','courtesy')); end if;
      if internal_qty>0 then insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,order_id,order_item_id,consumption_line_id,metadata) values('void:internal:'||request_id||':'||cl.id,cl.item_id,'internal_consumption',0,cl.base_unit_snapshot,reason,actor,line.order_id,line.id,cl.id,jsonb_build_object('classified_quantity',internal_qty,'already_consumed',true,'classification','internal')); end if;
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

commit;
