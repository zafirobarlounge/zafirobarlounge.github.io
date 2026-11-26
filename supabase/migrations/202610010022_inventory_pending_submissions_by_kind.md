# Migración 022: pendientes de inventario según tipo

Aplicar manualmente `202610010022_inventory_pending_submissions_by_kind.sql` después de `202609290021_inventory_linked_purchases.sql`.

La vista **Pendientes** conserva:

- solicitudes, conteos y daños `sent` o `partially_approved` porque aún requieren revisión;
- reposiciones `approved` o `partially_received` porque aún requieren compra o recepción.

Los conteos y daños `approved` quedan fuera de **Pendientes** porque ya fueron revisados y aplicados. Continúan visibles en **Todos**. La migración no modifica registros, cantidades ni movimientos.
