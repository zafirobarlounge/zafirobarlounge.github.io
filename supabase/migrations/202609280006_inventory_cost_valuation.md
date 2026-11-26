# Costos y valoración de inventario

Aplicar manualmente `202609280006_inventory_cost_valuation.sql` en **zafiro-pruebas**, después de `202609270005_inventory.sql`. No se ejecutó SQL remoto. Esta migración no modifica 005, no recalcula ventas anteriores y no crea movimientos, recepciones ni gastos.

## Modelo

- La presentación guarda un `suggested_package_cost` opcional. Solo sirve para precargar futuras recepciones.
- Cada nueva línea de recepción congela presentación, conversión, paquetes, cantidad base, costo real por presentación, total real y costo por unidad base. `unit_cost` se conserva como columna legada de compatibilidad; los cálculos nuevos usan `base_unit_cost`.
- `inventory_item_valuations` mantiene cantidad, promedio móvil y valor rastreado por artículo. Los movimientos guardan el saldo, promedio y valor posteriores para auditoría.
- El consumo POS congela el promedio aplicado y el costo rastreado por componente. Una nueva compra no recalcula consumos anteriores.

El servidor calcula el costo de una presentación como:

`cantidad base = paquetes × contenido de la presentación`

`total de línea = paquetes × costo real por presentación`

`costo base = total de línea / cantidad base`

Para recepción directa se registra cantidad base y se elige entre total de línea o costo base. PostgreSQL vuelve a calcular los derivados y valida que `receipt.total_cost = SUM(line_total_cost)`. Si se enlaza un gasto vigente, su importe debe coincidir con ese total derivado. El gasto sigue siendo independiente y sus cambios posteriores no alteran inventario.

## Promedio móvil

Con saldo previo positivo y costo conocido:

`nuevo promedio = ((Q anterior × C anterior) + (Q entrada × C entrada)) / (Q anterior + Q entrada)`

Las salidas conservan el último promedio conocido aunque el saldo llegue a cero o negativo. Si una recepción encuentra saldo previo menor o igual a cero, el nuevo promedio pasa a ser el costo real de esa recepción. Si existe cantidad positiva sin costo histórico conocido, la valoración permanece desconocida; nunca se sustituye por cero.

Una devolución recuperable reincorpora cantidad usando el costo snapshot de la salida original. Merma, consumo interno/cortesía y consumo del cliente solo clasifican una cantidad ya descontada y no generan otro costo de salida.

## Compatibilidad con 005

Las cantidades existentes se copian al estado de valoración. Como 005 no congelaba todos los datos necesarios para reconstruir de forma fiable el promedio de cada salida, su valoración inicial queda explícitamente desconocida. Las líneas antiguas conservan `unit_cost`; no se reescriben por el trigger de historial inmutable. La primera entrada fiable después de un saldo `<= 0` establece el promedio nuevo.

## QA manual

1. Crear una presentación x6 con sugerido $7.000; recibir tres paquetes y confirmar 18 unidades, $21.000 y $1.166,67 por unidad en la vista previa y el histórico.
2. Cambiar nombre, conversión y costo sugerido; confirmar que la recepción anterior no cambia.
3. Registrar conteo inicial con y sin costo. Confirmar que el segundo muestra “Sin costo conocido”.
4. Entregar un producto con receta parcial; confirmar “Costo de componentes controlados”, un solo consumo y costo snapshot. Recibir a otro precio y comprobar que el consumo anterior permanece.
5. Hacer una devolución recuperable y comprobar que usa el costo original. Clasificar otra parte como merma y confirmar que no descuenta ni valora dos veces.

