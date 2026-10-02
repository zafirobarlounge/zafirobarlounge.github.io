# 015 · Tipo de uso de artículos de inventario

Aplicar después de `202609290014_inventory_pending_submissions_filter.sql`.

Esta migración:

- añade `inventory_items.usage_type` con valores `consumable` y `operational`;
- conserva todos los artículos existentes como `consumable`;
- permite filtrar `inventory_read` por tipo y área desde PostgreSQL;
- impide asociar artículos operativos a recetas o cambiar a operativo un artículo con receta activa;
- excluye defensivamente los operativos del consumo y las alertas del POS;
- mantiene compatible el importador: si `usage_type` no llega, usa `consumable`.

No cambia existencias, costos, movimientos, entradas, solicitudes, presentaciones ni recetas existentes.

## Aplicación manual en QA

Ejecutar el contenido completo de:

`supabase/migrations/202609290015_inventory_item_usage_type.sql`

como una sola operación. El archivo incluye `begin;` y `commit;`.
