-- Adds the existing menu sale price to the inventory read model for recipe administration.
-- No data changes: inventory quantities, recipes, costs and POS behavior remain unchanged.
begin;

create or replace function public.inventory_read(requested_usage_type text default null, requested_area text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a inventario'; end if;
  if requested_usage_type is not null and requested_usage_type not in ('consumable','operational') then raise exception 'Tipo de uso invalido'; end if;
  if requested_area is not null and not exists(select 1 from public.inventory_areas a where a.code=requested_area and a.active) then raise exception 'Area de inventario invalida'; end if;
  if requested_area is not null and not (costs or (requested_area in ('bar','kitchen') and public.has_staff_role(requested_area))) then raise exception 'Area no autorizada'; end if;
  select jsonb_build_object(
    'can_manage',costs,'can_configure',public.inventory_can_configure(),
    'areas',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'active',a.active,'operational',a.operational,'system_protected',a.system_protected) order by a.name) from public.inventory_areas a where a.active or public.inventory_can_configure()),'[]'::jsonb),
    'pending_review_count',(select count(*) from public.inventory_submissions s where s.status in ('sent','partially_approved') and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))),
    'items',coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('id',i.id,'import_code',i.import_code,'name',i.name,'active',i.active,'usage_type',i.usage_type,'base_unit',i.base_unit,'precision_scale',i.precision_scale,
        'minimum_quantity',i.minimum_quantity,'target_quantity',i.target_quantity,'tracking_started_at',i.tracking_started_at,
        'balance',case when i.tracking_started_at is null then null else coalesce(v.current_quantity,0) end,
        'pending_incoming',coalesce((select sum(greatest(coalesce(l.approved_quantity,0)-l.received_quantity,0)) from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.item_id=i.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received')),0),
        'last_unit_cost',case when costs then v.last_unit_cost else null end,'average_unit_cost',case when costs then v.average_unit_cost else null end,
        'inventory_value',case when costs then v.inventory_value else null end,
        'areas',coalesce((select jsonb_agg(a.area order by a.area) from public.inventory_item_areas a where a.item_id=i.id),'[]'::jsonb)) x
      from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where public.inventory_item_visible(i.id) and (requested_usage_type is null or i.usage_type=requested_usage_type) and (requested_area is null or exists(select 1 from public.inventory_item_areas ia where ia.item_id=i.id and ia.area=requested_area))
    ) q),'[]'::jsonb),
    'presentations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'item_id',p.item_id,'name',p.name,'content_per_package',p.content_per_package,'content_unit',p.content_unit,'active',p.active,'suggested_package_cost',case when costs then p.suggested_package_cost else null end) order by p.name) from public.inventory_purchase_presentations p join public.inventory_items pi on pi.id=p.item_id where public.inventory_item_visible(p.item_id) and (requested_usage_type is null or pi.usage_type=requested_usage_type) and (requested_area is null or exists(select 1 from public.inventory_item_areas ia where ia.item_id=pi.id and ia.area=requested_area))),'[]'::jsonb),
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'controls_inventory',r.controls_inventory,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name,'tracked_component_cost',case when r.quantity_base is null or v.last_unit_cost is null then null else round(r.quantity_base*v.last_unit_cost,6) end) order by mi.name) from public.inventory_menu_recipe_components r join public.inventory_items ri on ri.id=r.item_id and ri.usage_type='consumable' join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key left join public.inventory_item_valuations v on v.item_id=r.item_id),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',mi.source_key,'name',mi.name,'price',mi.precio_venta) order by mi.name) from public.menu_items mi),'[]'::jsonb) else '[]'::jsonb end,
    'submissions','[]'::jsonb,'receipts','[]'::jsonb,'movements','[]'::jsonb
  ) into result;
  return result;
end;
$$;

revoke all on function public.inventory_read(text,text) from public,anon;
grant execute on function public.inventory_read(text,text) to authenticated;

commit;
