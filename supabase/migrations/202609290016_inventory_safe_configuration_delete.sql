-- Elimina únicamente configuración de inventario sin uso ni historia.
begin;

create function public.inventory_delete_configuration(request_id uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare actor text:=public.inventory_actor_email(); action text:=payload->>'action'; previous public.inventory_command_audit; target_id uuid; area_code text; result jsonb;
begin
  if request_id is null or payload is null or not public.inventory_can_configure() then raise exception 'Solo administración puede eliminar configuración de inventario'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_delete_configuration.request_id;
  if found then if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if; return previous.result; end if;
  if action='delete_presentation' then
    target_id:=(payload->>'id')::uuid; select to_jsonb(p) into result from public.inventory_purchase_presentations p where p.id=target_id;
    if result is null then raise exception 'Presentación inexistente'; end if;
    if exists(select 1 from public.inventory_receipt_lines where presentation_id=target_id) or exists(select 1 from public.inventory_submission_lines where notes like '%'||target_id::text||'%') then raise exception 'No se puede eliminar: la presentación ya tiene historial. Puedes desactivarla.'; end if;
    delete from public.inventory_purchase_presentations where id=target_id;
  elsif action='delete_item' then
    target_id:=(payload->>'id')::uuid; select to_jsonb(i) into result from public.inventory_items i where i.id=target_id;
    if result is null then raise exception 'Artículo inexistente'; end if;
    if exists(select 1 from public.inventory_purchase_presentations where item_id=target_id) or exists(select 1 from public.inventory_menu_recipe_components where item_id=target_id) or exists(select 1 from public.inventory_submission_lines where item_id=target_id) or exists(select 1 from public.inventory_receipt_lines where item_id=target_id) or exists(select 1 from public.inventory_pos_consumption_lines where item_id=target_id) or exists(select 1 from public.inventory_movements where item_id=target_id) or exists(select 1 from public.inventory_item_valuations where item_id=target_id) then raise exception 'No se puede eliminar: el artículo tiene configuración o historial. Puedes desactivarlo.'; end if;
    delete from public.inventory_item_areas where item_id=target_id; delete from public.inventory_items where id=target_id;
  elsif action='delete_area' then
    area_code:=payload->>'code'; select to_jsonb(a) into result from public.inventory_areas a where a.code=area_code;
    if result is null then raise exception 'Área inexistente'; end if;
    if (result->>'system_protected')::boolean then raise exception 'El área está protegida por el POS'; end if;
    if exists(select 1 from public.inventory_item_areas where area=area_code) or exists(select 1 from public.inventory_submissions where area=area_code) then raise exception 'No se puede eliminar: el área está asignada o tiene historial. Puedes desactivarla.'; end if;
    delete from public.inventory_areas where code=area_code;
  else raise exception 'Operación de eliminación desconocida'; end if;
  insert into public.inventory_command_audit(request_id,actor,payload,result) values(request_id,actor,payload,result); return result;
end; $$;

revoke all on function public.inventory_delete_configuration(uuid,jsonb) from public,anon;
grant execute on function public.inventory_delete_configuration(uuid,jsonb) to authenticated;
commit;
