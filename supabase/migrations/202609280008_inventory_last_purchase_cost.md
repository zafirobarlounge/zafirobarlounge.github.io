# Último costo real de inventario

Aplicar manualmente `202609280008_inventory_last_purchase_cost.sql` en **zafiro-pruebas**, después de las migraciones 006 y 007. No se ejecutó SQL remoto.

La migración conserva las cantidades, recepciones, movimientos y consumos existentes. Añade `last_unit_cost` al estado de cada artículo y lo completa con la recepción más reciente que tenga un costo conocido. Este backfill solo actualiza el estado vigente; no modifica las líneas históricas.

## Regla operativa

- Cada recepción con costo real conocido reemplaza `last_unit_cost` por su costo por unidad base.
- Una recepción sin costo no borra el último costo conocido.
- Conteos iniciales, correcciones y devoluciones no cambian el último costo real de compra.
- El costo sugerido de una presentación sigue siendo solo una referencia para precargar el formulario.
- Recetas y entregas POS nuevas usan `last_unit_cost`. Cada consumo guarda `last_unit_cost_snapshot` y `tracked_cost`; el campo legado `average_unit_cost_snapshot` conserva el promedio contable. Las devoluciones prefieren el nuevo snapshot y usan el legado como respaldo para ventas anteriores a 008.
- El promedio ponderado y el valor inventariable se conservan como datos contables/históricos de compatibilidad. Ya no determinan el costo operativo actual ni el costo de una venta nueva.

## Compatibilidad

Para recepciones creadas antes de la migración 006, el backfill usa `unit_cost` cuando `base_unit_cost` no existe. No se reconstruyen snapshots de ventas anteriores: permanecen exactamente como fueron registrados.

## QA manual

1. Abrir un artículo con recepciones anteriores y confirmar que “Último costo real” coincide con la compra conocida más reciente.
2. Cambiar el costo sugerido de su presentación y confirmar que el costo vigente no cambia.
3. Registrar una recepción con otro costo real y confirmar que “Último costo real” cambia sin alterar recepciones anteriores.
4. Entregar un producto con receta y confirmar que el consumo y movimiento POS congelan el nuevo costo.
5. Registrar otra compra y confirmar que el consumo POS anterior conserva su snapshot.
