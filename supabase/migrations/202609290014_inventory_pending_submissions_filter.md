# Migración 014: filtro de solicitudes pendientes

Aplicar manualmente `202609290014_inventory_pending_submissions_filter.sql` después de `202609290013_inventory_recipe_cost_quantity.sql`.

La migración amplía el parámetro `requested_status` de `inventory_submissions_page` con el valor agregado `pending`. Este valor devuelve únicamente:

- `sent`
- `partially_approved`
- `approved`
- `partially_received`

`draft`, `received` y `rejected` quedan fuera de **Pendientes** y siguen disponibles mediante sus filtros exactos al usar la vista **Todos**. La consulta conserva la paginación de 20 registros, el cursor compuesto por fecha y UUID, el filtro de área y las mismas reglas de autorización.

