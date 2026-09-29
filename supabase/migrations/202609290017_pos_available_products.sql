-- El POS consulta productos disponibles aunque estén ocultos del menú público.
begin;

create function public.pos_product_options() returns setof public.menu_items
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_pos_staff() then raise exception 'Acceso denegado al catálogo operativo'; end if;
  return query
    select * from public.menu_items
    where disponible=true
    order by tipo,subgrupo,orden,name;
end;
$$;

revoke all on function public.pos_product_options() from public,anon;
grant execute on function public.pos_product_options() to authenticated;

commit;
