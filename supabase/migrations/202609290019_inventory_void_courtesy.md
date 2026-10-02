# 019 · Destinos de anulación entregada

Aplicar manualmente después de `202609290018_inventory_menu_recipe_overview.sql`.

- Añade `courtesy_quantity` a `inventory_pos_consumption_lines` con cero para todo el historial existente.
- Añade `courtesy_consumption` como movimiento clasificatorio sin cambio de existencia.
- Mantiene `internal_consumption` para consumo interno histórico y nuevo.
- Conserva devolución, costo snapshot, idempotencia y cantidades existentes.
- Excluye de la resolución cualquier componente sin cantidad medible.

No ejecuta anulaciones ni modifica saldos durante la migración.
