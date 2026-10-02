# 202609290012 · Control de inventario por componente de receta

Aplicar después de `202609290011_dynamic_inventory_areas.sql`.

Esta migración separa los componentes descriptivos de una receta de los componentes que descuentan inventario. No reescribe movimientos, consumos POS, costos congelados ni anulaciones históricas.

## Compatibilidad

- Cada componente existente recibe `controls_inventory = true` mediante el valor predeterminado de la nueva columna.
- Los clientes anteriores que omitan `controls_inventory` se interpretan como componentes controlados.
- `inventory_menu_tracking.control_mode` se conserva para los consumos y datos históricos, pero deja de decidir el descuento futuro.
- Los archivos XLSX anteriores continúan creando asociaciones controladas.

## Reglas nuevas

- Un componente controlado exige `quantity_base > 0`.
- Un componente descriptivo exige `quantity_base IS NULL`.
- Solo los componentes activos y controlados generan líneas de consumo, movimientos, alertas, disponibilidad y costo automático.
- Los artículos exclusivos de áreas ajenas al POS continúan excluidos de todas las recetas.

## Aplicación manual en QA

Ejecutar el archivo SQL completo dentro de una única sesión. La migración ya contiene `begin` y `commit`.
