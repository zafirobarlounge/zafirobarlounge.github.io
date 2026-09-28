# Guía operativa de Inventario

Ruta: `/admin/inventory`. La navegación **Existencias y solicitudes** también aparece en el POS para administración, caja, barra y cocina.

## Administración

1. Crea el artículo con una unidad base estable: unidad, gramo o mililitro; asigna barra/cocina, mínimo y objetivo.
2. Añade todas las presentaciones reales de compra, por ejemplo paquete x4 y paquete x6. El contenido siempre se expresa en la unidad base.
3. Registra el primer conteo físico. Hasta entonces se muestra “Sin conteo inicial”; no se inventa un cero.
4. Configura el consumo de cada producto del menú con uno o más artículos. Marca “Control parcial” cuando solo se miden algunos componentes.
5. Revisa solicitudes, conteos y daños. Aprobar una reposición no aumenta stock; la recepción sí.

## Caja

Caja consulta existencias y costos, registra conteos iniciales/correcciones compensatorias, recibe compras y revisa reportes. Al recibir, selecciona una presentación y paquetes o usa unidad base; la conversión aparece antes de guardar. Puede enlazar un gasto existente por UUID. La recepción nunca genera el gasto automáticamente.

## Barra y cocina

Cada área ve solo sus artículos y no ve costos. El recorrido es: consultar existencia → crear solicitud/conteo/daño → guardar borrador o enviar → ver estado. Enviar no cambia la existencia. Administración o caja decide la aprobación.

## POS

Al entregar, el POS descuenta una sola vez la receta vigente y guarda una copia de sus componentes. El producto sin receta se entrega normalmente y se identifica como sin seguimiento. Una alerta de posible agotado o control parcial informa, pero no oculta productos ni bloquea ventas.

Si se anula una unidad ya entregada, se debe distribuir cada componente entre devolución disponible, merma, consumo interno/cortesía y consumo del cliente. Solo la parte recuperable vuelve a existencias; las demás clasificaciones no descuentan por segunda vez. Antes de entregar, una cancelación normal no devuelve stock. Un daño físico en preparación se reporta como daño separado.

## Correcciones

El historial no se edita. Un error se corrige con un movimiento compensatorio y motivo. Las ventas anteriores a la activación no se recalculan. Los archivos `data/inventory-initial-suggestions.*` son material de revisión, no una carga automática.
