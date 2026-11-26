# Migración 013: cantidades de receta para costo

Aplicar manualmente `202609290013_inventory_recipe_cost_quantity.sql` después de `202609290012_inventory_recipe_component_control.sql`.

Esta migración separa la medición de una receta de su descuento automático:

- `controls_inventory = true` exige `quantity_base > 0` y genera movimientos POS.
- `controls_inventory = false` permite `quantity_base > 0` para calcular costo sin mover existencias.
- `controls_inventory = false` también permite `quantity_base = NULL` para componentes puramente descriptivos.
- Una cantidad definida en cero o negativa queda rechazada.

`inventory_read()` calcula `tracked_component_cost` para todo componente activo con cantidad definida y último costo real conocido. `inventory_deliver_pos_item()` e `inventory_menu_alerts()` conservan el filtro de la migración 012 y solo consideran componentes activos con descuento automático.

No se actualizan recetas existentes, movimientos ni consumos históricos. Los clientes anteriores que omiten `controls_inventory` mantienen el comportamiento controlado por defecto.

## Verificación manual sugerida en QA

1. Guardar un componente con descuento automático y cantidad positiva.
2. Guardar otro sin descuento, con cantidad positiva y costo conocido; comprobar que suma al costo calculado y no genera movimiento al entregar el producto.
3. Guardar un componente sin descuento y sin cantidad; comprobar que el costo aparece como parcial.
4. Confirmar que una cantidad cero y un componente controlado sin cantidad son rechazados.

