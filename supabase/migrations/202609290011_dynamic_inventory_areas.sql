-- Incremental upgrade AFTER 202609290010_inventory_history_pagination.sql. Manual review/application in QA.
-- Makes inventory areas configurable while preserving stable area codes in existing history.
begin;

create table public.inventory_areas (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (nullif(trim(name),'') is not null),
  active boolean not null default true,
  operational boolean not null default false,
  system_protected boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
create unique index inventory_areas_name_key on public.inventory_areas(lower(trim(name)));
insert into public.inventory_areas(code,name,active,operational,system_protected,created_by,updated_by) values
  ('bar','Barra',true,true,true,'migration-011','migration-011'),
  ('kitchen','Cocina',true,true,true,'migration-011','migration-011'),
  ('operations','Operación general',true,false,false,'migration-011','migration-011');

alter table public.inventory_item_areas drop constraint if exists inventory_item_areas_area_check;
alter table public.inventory_submissions drop constraint if exists inventory_submissions_area_check;
alter table public.inventory_item_areas add constraint inventory_item_areas_area_fkey foreign key(area) references public.inventory_areas(code) on update restrict on delete restrict;
alter table public.inventory_submissions add constraint inventory_submissions_area_fkey foreign key(area) references public.inventory_areas(code) on update restrict on delete restrict;
create index inventory_item_areas_area_idx on public.inventory_item_areas(area,item_id);
create index inventory_submissions_area_status_cursor_idx on public.inventory_submissions(area,status,created_at desc,id desc);

create function public.inventory_normalize_area_label(value text) returns text language sql immutable set search_path=public as $$ select regexp_replace(translate(lower(trim(coalesce(value,''))),'áéíóúüñ','aeiouun'),'\s+',' ','g'); $$;
create unique index inventory_areas_normalized_name_key on public.inventory_areas(public.inventory_normalize_area_label(name));
create function public.inventory_resolve_area_codes(area_spec text,require_active boolean default true) returns text[] language plpgsql stable security definer set search_path=public as $$
declare token text; normalized text; resolved text; result text[]:='{}';
begin
  normalized:=public.inventory_normalize_area_label(area_spec); if normalized in ('ambas','both') then return array['bar','kitchen']; end if;
  for token in select trim(value) from regexp_split_to_table(coalesce(area_spec,''),'\s*[+,;]\s*') value where trim(value)<>'' loop
    normalized:=public.inventory_normalize_area_label(token); if normalized='barra' then normalized:='bar'; elsif normalized='cocina' then normalized:='kitchen'; end if;
    select a.code into resolved from public.inventory_areas a where (public.inventory_normalize_area_label(a.code)=normalized or public.inventory_normalize_area_label(a.name)=normalized) and (not require_active or a.active);
    if resolved is null then raise exception 'Area de inventario desconocida o inactiva: %',token; end if; if not resolved=any(result) then result:=array_append(result,resolved); end if;
  end loop;
  if cardinality(result)=0 then raise exception 'El area de inventario es obligatoria'; end if; return result;
end; $$;

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
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name,'tracked_component_cost',case when v.last_unit_cost is null then null else round(r.quantity_base*v.last_unit_cost,6) end) order by mi.name) from public.inventory_menu_recipe_components r join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key left join public.inventory_item_valuations v on v.item_id=r.item_id),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',source_key,'name',name) order by name) from public.menu_items),'[]'::jsonb) else '[]'::jsonb end,
    'submissions','[]'::jsonb,'receipts','[]'::jsonb,'movements','[]'::jsonb
  ) into result;
  return result;
end;
$$;

create or replace function public.inventory_import_preview(payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  article jsonb; presentation jsonb; recipe jsonb; menu_key text; existing public.inventory_items;
  item_unit text; v_item_id uuid; existing_presentation public.inventory_purchase_presentations;
  new_articles jsonb := '[]'; existing_articles jsonb := '[]'; new_presentations jsonb := '[]'; existing_presentations jsonb := '[]';
  new_recipes jsonb := '[]'; existing_recipes jsonb := '[]'; errors jsonb := '[]'; warnings jsonb := '[]';
  area_count integer; expected_count integer; actual_count integer; costs_without_count integer:=0; valid_associations integer:=0; area_codes text[]; existing_area_codes text[];
begin
  if payload is null or not public.inventory_can_configure() then raise exception 'Solo administración puede previsualizar importaciones de inventario'; end if;
  if jsonb_typeof(payload->'articles') <> 'array' or jsonb_typeof(payload->'presentations') <> 'array' or jsonb_typeof(payload->'menu_consumption') <> 'array' then
    raise exception 'Formato de importación inválido';
  end if;

  if exists(select 1 from jsonb_array_elements(payload->'articles') a group by upper(trim(a->>'code')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay códigos de artículo duplicados en el archivo.');
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'presentations') p group by upper(trim(p->>'item_code')), lower(trim(p->>'name')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay presentaciones duplicadas en el archivo.');
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'menu_consumption') r group by r->>'menu_item_source_key', upper(trim(r->>'item_code')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay asociaciones de menú duplicadas en el archivo.');
  end if;

  for article in select value from jsonb_array_elements(payload->'articles') loop
    if nullif(trim(article->>'code'),'') is null or article->>'code' !~ '^[A-Z0-9_]+$' or nullif(trim(article->>'name'),'') is null then
      errors := errors || jsonb_build_array('Artículo inválido: código y nombre son obligatorios; el código admite A-Z, 0-9 y _.'); continue;
    end if;
    if article->>'base_unit' not in ('unit','gram','milliliter') then errors := errors || jsonb_build_array('Articulo '||(article->>'code')||': unidad invalida.'); continue; end if;
    begin area_codes:=public.inventory_resolve_area_codes(article->>'area',true); exception when others then errors:=errors||jsonb_build_array('Articulo '||(article->>'code')||': '||sqlerrm); continue; end;
    if (article->>'initial_quantity')::numeric < 0 or (article->>'initial_unit_cost')::numeric < 0
      or (article->>'minimum_quantity')::numeric < 0 or (article->>'target_quantity')::numeric < 0
      or (article->>'target_quantity')::numeric < (article->>'minimum_quantity')::numeric then
      errors := errors || jsonb_build_array('Artículo '||(article->>'code')||': cantidades o costos inválidos.'); continue;
    end if;
    if (article->>'initial_quantity') is null and (article->>'initial_unit_cost') is not null then
      costs_without_count:=costs_without_count+1;
    end if;
    select * into existing from public.inventory_items where import_code=article->>'code';
    if found then
      select coalesce(array_agg(a.area order by a.area),'{}'::text[]) into existing_area_codes from public.inventory_item_areas a where a.item_id=existing.id;
      select array_agg(code order by code) into area_codes from unnest(area_codes) code;
      if not existing.active or existing.name is distinct from trim(article->>'name') or existing.base_unit is distinct from article->>'base_unit'
        or existing.minimum_quantity is distinct from (article->>'minimum_quantity')::numeric
        or existing.target_quantity is distinct from (article->>'target_quantity')::numeric
        or existing.import_notes is distinct from coalesce(article->>'notes','')
        or existing_area_codes is distinct from area_codes then
        errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': ya existe con otra configuración; no se sobrescribirá.');
      elsif (article->>'initial_quantity') is not null and existing.tracking_started_at is not null then
        errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': ya tiene conteo inicial.');
      else existing_articles := existing_articles || jsonb_build_array(article->>'code'); end if;
    elsif exists(select 1 from public.inventory_items i where lower(trim(i.name))=lower(trim(article->>'name'))) then
      errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': el nombre ya existe sin ese código de importación.');
    else new_articles := new_articles || jsonb_build_array(article->>'code'); end if;
  end loop;
  if costs_without_count>0 then warnings:=warnings||jsonb_build_array(costs_without_count||' artículo(s) tienen costo de referencia sin existencia; no se generará conteo para ellos.'); end if;

  for presentation in select value from jsonb_array_elements(payload->'presentations') loop
    select i.id,i.base_unit into v_item_id,item_unit from public.inventory_items i where i.import_code=presentation->>'item_code';
    if v_item_id is null then
      select nullif(a->>'base_unit','') into item_unit from jsonb_array_elements(payload->'articles') a where a->>'code'=presentation->>'item_code' limit 1;
    end if;
    if item_unit is null then errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': artículo '||(presentation->>'item_code')||' inexistente.'); continue; end if;
    if presentation->>'content_unit' is distinct from item_unit then
      errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': la unidad no coincide con la base; no se aplican conversiones automáticas.'); continue;
    end if;
    if (presentation->>'content_per_package')::numeric <= 0 or (presentation->>'suggested_package_cost')::numeric < 0 then
      errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': contenido o costo inválido.'); continue;
    end if;
    if v_item_id is not null then
      select * into existing_presentation from public.inventory_purchase_presentations p where p.item_id=v_item_id and lower(trim(p.name))=lower(trim(presentation->>'name'));
    else existing_presentation.id := null; end if;
    if existing_presentation.id is not null then
      if existing_presentation.content_per_package is distinct from (presentation->>'content_per_package')::numeric
        or existing_presentation.content_unit is distinct from presentation->>'content_unit'
        or existing_presentation.suggested_package_cost is distinct from (presentation->>'suggested_package_cost')::numeric
        or existing_presentation.import_notes is distinct from coalesce(presentation->>'notes','') or not existing_presentation.active then
        errors := errors || jsonb_build_array('Conflicto en presentación '||(presentation->>'item_code')||' / '||(presentation->>'name')||'.');
      else existing_presentations := existing_presentations || jsonb_build_array((presentation->>'item_code')||' / '||(presentation->>'name')); end if;
    else new_presentations := new_presentations || jsonb_build_array((presentation->>'item_code')||' / '||(presentation->>'name')); end if;
  end loop;

  for recipe in select value from jsonb_array_elements(payload->'menu_consumption') loop
    select i.id,i.base_unit into v_item_id,item_unit from public.inventory_items i where i.import_code=recipe->>'item_code';
    if v_item_id is null then select nullif(a->>'base_unit','') into item_unit from jsonb_array_elements(payload->'articles') a where a->>'code'=recipe->>'item_code' limit 1; end if;
    if not exists(select 1 from public.menu_items m where m.source_key=recipe->>'menu_item_source_key') then
      errors := errors || jsonb_build_array('Producto de menú no resuelto por clave estable: '||(recipe->>'menu_item_source_key')||'.');
    elsif item_unit is null then errors := errors || jsonb_build_array('Asociación de menú: artículo '||(recipe->>'item_code')||' inexistente.');
    elsif recipe->>'unit' is distinct from item_unit then errors := errors || jsonb_build_array('Asociación '||(recipe->>'item_code')||': unidad incompatible; no se convierten tajadas, tiras, hojas o rodajas.');
    elsif recipe->>'control_mode' <> 'partial' or (recipe->>'quantity_base')::numeric <= 0 then errors := errors || jsonb_build_array('Asociación de menú inválida para '||(recipe->>'item_code')||'.');
    elsif v_item_id is not null and not exists(select 1 from public.inventory_item_areas a where a.item_id=v_item_id and a.area in ('bar','kitchen')) then errors:=errors||jsonb_build_array('Asociacion '||(recipe->>'item_code')||': el articulo no pertenece a Barra o Cocina.');
    elsif v_item_id is null and not (public.inventory_resolve_area_codes((select a->>'area' from jsonb_array_elements(payload->'articles') a where a->>'code'=recipe->>'item_code' limit 1),true) && array['bar','kitchen']::text[]) then errors:=errors||jsonb_build_array('Asociacion '||(recipe->>'item_code')||': el articulo no pertenece a Barra o Cocina.');
    else valid_associations:=valid_associations+1;
    end if;
  end loop;

  for menu_key in select distinct value->>'menu_item_source_key' from jsonb_array_elements(payload->'menu_consumption') loop
    if exists(select 1 from public.inventory_menu_tracking t where t.menu_item_source_key=menu_key) then
      select count(*) into expected_count from jsonb_array_elements(payload->'menu_consumption') r where r->>'menu_item_source_key'=menu_key;
      select count(*) into actual_count from public.inventory_menu_recipe_components c where c.menu_item_source_key=menu_key and c.active;
      if expected_count<>actual_count or exists(
        select 1 from jsonb_array_elements(payload->'menu_consumption') r
        left join public.inventory_items i on i.import_code=r->>'item_code'
        left join public.inventory_menu_recipe_components c on c.menu_item_source_key=menu_key and c.item_id=i.id and c.active
        where r->>'menu_item_source_key'=menu_key and (c.id is null or c.quantity_base is distinct from (r->>'quantity_base')::numeric)
      ) or exists(select 1 from public.inventory_menu_tracking t where t.menu_item_source_key=menu_key and t.control_mode<>'partial') then
        errors := errors || jsonb_build_array('Conflicto en receta '||menu_key||': ya existe con otra configuración; no se sobrescribirá.');
      else existing_recipes := existing_recipes || jsonb_build_array(menu_key); end if;
    else new_recipes := new_recipes || jsonb_build_array(menu_key); end if;
  end loop;

  return jsonb_build_object(
    'new_articles',new_articles,'existing_articles',existing_articles,
    'new_presentations',new_presentations,'existing_presentations',existing_presentations,
    'new_menu_products',new_recipes,'existing_menu_products',existing_recipes,
    'menu_association_count',valid_associations,
    'initial_count_count',(select count(*) from jsonb_array_elements(payload->'articles') a where (a->>'initial_quantity') is not null),
    'warnings',warnings,'errors',errors
  );
end;
$$;

create or replace function public.inventory_import_commit(request_id uuid, fingerprint text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor text:=public.inventory_actor_email(); previous public.inventory_import_batches; preview jsonb; article jsonb; presentation jsonb; recipe jsonb;
  imported_item public.inventory_items; v_item_id uuid; valuation jsonb; result jsonb;
  created_articles integer:=0; created_presentations integer:=0; created_associations integer:=0; created_counts integer:=0;
begin
  if request_id is null or fingerprint !~ '^[0-9a-f]{64}$' or not public.inventory_can_configure() then raise exception 'Solo administración puede importar inventario'; end if;
  perform pg_advisory_xact_lock(9272026,7);
  select * into previous from public.inventory_import_batches b where b.request_id=inventory_import_commit.request_id or b.fingerprint=inventory_import_commit.fingerprint order by (b.request_id=inventory_import_commit.request_id) desc limit 1;
  if found then
    if previous.actor<>actor or previous.payload<>payload or previous.fingerprint<>fingerprint then raise exception 'La importación ya existe con otros datos'; end if;
    return previous.result;
  end if;
  preview:=public.inventory_import_preview(payload);
  if jsonb_array_length(preview->'errors')>0 then raise exception 'La importación tiene conflictos: %',preview->'errors'; end if;

  for article in select value from jsonb_array_elements(payload->'articles') loop
    select * into imported_item from public.inventory_items where import_code=article->>'code';
    if not found then
      insert into public.inventory_items(import_code,name,active,base_unit,precision_scale,minimum_quantity,target_quantity,import_notes,created_by,updated_by)
      values(article->>'code',trim(article->>'name'),true,article->>'base_unit',case when article->>'base_unit'='unit' then 0 else 3 end,
        (article->>'minimum_quantity')::numeric,(article->>'target_quantity')::numeric,coalesce(article->>'notes',''),actor,actor) returning * into imported_item;
      insert into public.inventory_item_areas(item_id,area) select imported_item.id,unnest(public.inventory_resolve_area_codes(article->>'area',true));
      created_articles:=created_articles+1;
    end if;
    if (article->>'initial_quantity') is not null then
      update public.inventory_items set tracking_started_at=now(),updated_at=now(),updated_by=actor where id=imported_item.id;
      valuation:=public.inventory_apply_valuation(imported_item.id,(article->>'initial_quantity')::numeric,(article->>'initial_unit_cost')::numeric,'initial');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('import-initial:'||fingerprint||':'||(article->>'code'),imported_item.id,'initial_count',(article->>'initial_quantity')::numeric,imported_item.base_unit,'Conteo inicial importado',actor,
        jsonb_build_object('import_request_id',request_id,'counted_quantity',(article->>'initial_quantity')::numeric,'cost_known',(article->>'initial_unit_cost') is not null),
        (article->>'initial_unit_cost')::numeric,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
      created_counts:=created_counts+1;
    end if;
  end loop;

  for presentation in select value from jsonb_array_elements(payload->'presentations') loop
    select id into v_item_id from public.inventory_items where import_code=presentation->>'item_code';
    if not exists(select 1 from public.inventory_purchase_presentations p where p.item_id=v_item_id and lower(trim(p.name))=lower(trim(presentation->>'name'))) then
      insert into public.inventory_purchase_presentations(item_id,name,content_per_package,content_unit,suggested_package_cost,import_notes,created_by,updated_by)
      values(v_item_id,trim(presentation->>'name'),(presentation->>'content_per_package')::numeric,presentation->>'content_unit',(presentation->>'suggested_package_cost')::numeric,coalesce(presentation->>'notes',''),actor,actor);
      created_presentations:=created_presentations+1;
    end if;
  end loop;

  for recipe in select value from jsonb_array_elements(payload->'menu_consumption') loop
    insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by) values(recipe->>'menu_item_source_key','partial',actor) on conflict do nothing;
    select id into v_item_id from public.inventory_items where import_code=recipe->>'item_code';
    if not exists(select 1 from public.inventory_menu_recipe_components c where c.menu_item_source_key=recipe->>'menu_item_source_key' and c.item_id=v_item_id and c.active) then
      insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,quantity_base,active,created_by,updated_by)
      values(recipe->>'menu_item_source_key',v_item_id,(recipe->>'quantity_base')::numeric,true,actor,actor);
      created_associations:=created_associations+1;
    end if;
  end loop;

  result:=jsonb_build_object('created_articles',created_articles,'created_presentations',created_presentations,'created_menu_associations',created_associations,'created_initial_counts',created_counts,'preview',preview);
  insert into public.inventory_import_batches(request_id,fingerprint,actor,payload,result) values(request_id,fingerprint,actor,payload,result);
  return result;
end;
$$;

drop function public.inventory_submissions_page(text,text,timestamptz,uuid);
create function public.inventory_submissions_page(requested_kind text default null,requested_status text default null,before_created_at timestamptz default null,before_id uuid default null,requested_area text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a solicitudes'; end if;
  if requested_kind is not null and requested_kind not in ('replenishment','count','damage') then raise exception 'Tipo de solicitud invalido'; end if;
  if requested_status is not null and requested_status not in ('draft','sent','partially_approved','approved','partially_received','received','rejected') then raise exception 'Estado de solicitud invalido'; end if;
  if requested_area is not null and not exists(select 1 from public.inventory_areas a where a.code=requested_area) then raise exception 'Area de solicitud invalida'; end if;
  if (before_created_at is null)<>(before_id is null) then raise exception 'Cursor de solicitudes invalido'; end if;
  with candidates as (
    select s.created_at,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes) order by l.id),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) row_data
    from public.inventory_submissions s
    where (requested_kind is null or s.kind=requested_kind) and (requested_status is null or s.status=requested_status) and (requested_area is null or s.area=requested_area)
      and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))
      and (before_created_at is null or (s.created_at,s.id)<(before_created_at,before_id))
    order by s.created_at desc,s.id desc limit 21
  ), numbered as (select *,row_number() over(order by created_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by created_at desc,id desc) filter(where rn<=20),'[]'::jsonb),'has_more',count(*)>20) into result from numbered;
  return result;
end;
$$;

alter table public.inventory_areas enable row level security;
revoke all on table public.inventory_areas from public,anon,authenticated;
revoke all on function public.inventory_normalize_area_label(text),public.inventory_resolve_area_codes(text,boolean) from public,anon,authenticated;
revoke all on function public.inventory_submissions_page(text,text,timestamptz,uuid,text) from public,anon;
grant execute on function public.inventory_submissions_page(text,text,timestamptz,uuid,text) to authenticated;
commit;
