-- Incremental upgrade AFTER 202609280008_inventory_last_purchase_cost.sql. Manual review/application in QA.
-- Records the part of a real receipt that covers a replenishment request without truncating the received stock or cost.
begin;

alter table public.inventory_receipt_lines
  add column applied_submission_quantity numeric;

-- Before this migration linked receipts were rejected when their full base quantity
-- exceeded the pending approved quantity, so the full historical base quantity was applied.
alter table public.inventory_receipt_lines disable trigger inventory_receipt_lines_immutable;
update public.inventory_receipt_lines
set applied_submission_quantity=base_quantity
where submission_line_id is not null;
alter table public.inventory_receipt_lines enable trigger inventory_receipt_lines_immutable;

alter table public.inventory_receipt_lines
  add constraint inventory_receipt_lines_submission_application_check check (
    (submission_line_id is null and applied_submission_quantity is null)
    or
    (submission_line_id is not null and applied_submission_quantity is not null
      and applied_submission_quantity >= 0
      and applied_submission_quantity <= base_quantity)
  );

create or replace function public.inventory_command(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); action text:=payload->>'action'; previous public.inventory_command_audit; result jsonb; item public.inventory_items; pres public.inventory_purchase_presentations; sub public.inventory_submissions; subline public.inventory_submission_lines; line jsonb; receipt public.inventory_receipts; receipt_line_id uuid; qty numeric; current_balance numeric; target_balance numeric; expense public.pos_cash_movements; valuation jsonb; actual_package_cost numeric; line_total numeric; base_cost numeric; derived_total numeric:=0; all_costs_known boolean:=true; initial_cost numeric; pending_qty numeric; applied_qty numeric;
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

commit;
