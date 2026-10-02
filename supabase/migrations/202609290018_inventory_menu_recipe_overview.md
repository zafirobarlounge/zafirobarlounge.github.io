# Inventario: lectura para administración de recetas

Aplicar manualmente `202609290018_inventory_menu_recipe_overview.sql` después de `202609290017_pos_available_products.sql`.

La migración no modifica datos. Conserva la autorización de `inventory_read(text,text)` y añade `price`, tomado de `menu_items.precio_venta`, a cada elemento de `menu_items` en su respuesta. Esto permite calcular el margen estimado en la pestaña **Consumo del menú** sin ampliar permisos directos sobre el catálogo.
