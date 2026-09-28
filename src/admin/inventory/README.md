# Guía operativa de Inventario

Ruta: `/admin/inventory`. La navegación **Existencias y solicitudes** también aparece en el POS para administración, caja, barra y cocina.

## Administración

1. Crea el artículo con una unidad base estable: unidad, gramo o mililitro; asigna barra/cocina, mínimo y objetivo.
2. Añade todas las presentaciones reales de compra, por ejemplo paquete x4 y paquete x6. El contenido siempre se expresa en la unidad base. El costo sugerido es opcional y solo precarga recepciones futuras.
3. Registra el primer conteo físico. Hasta entonces se muestra “Sin conteo inicial”; no se inventa un cero. Si conoces el costo unitario inicial puedes registrarlo; si no, la valoración queda “Sin costo conocido”.
4. Configura el consumo de cada producto del menú con uno o más artículos. Marca “Control parcial” cuando solo se miden algunos componentes.
5. Revisa solicitudes, conteos y daños. Aprobar una reposición no aumenta stock; la recepción sí.

## Caja

Caja consulta existencias, costo promedio y valor rastreado, registra conteos iniciales/correcciones compensatorias, recibe compras y revisa reportes. Al recibir, selecciona una presentación, cantidad de paquetes y costo real por paquete; también puede usar unidad base con total de línea o costo unitario. La vista previa muestra conversión, total y costo base. Puede enlazar un gasto existente por UUID. La recepción nunca genera el gasto automáticamente.

## Barra y cocina

Cada área ve solo sus artículos y no ve costos. El recorrido es: consultar existencia → crear solicitud/conteo/daño → guardar borrador o enviar → ver estado. Enviar no cambia la existencia. Administración o caja decide la aprobación.

## POS

Al entregar, el POS descuenta una sola vez la receta vigente y guarda una copia de sus componentes y del costo promedio aplicado. El producto sin receta se entrega normalmente y se identifica como sin seguimiento. Una alerta de posible agotado o control parcial informa, pero no oculta productos ni bloquea ventas. En recetas parciales se habla de “Costo de componentes controlados” y solo se incluyen los componentes configurados.

Si se anula una unidad ya entregada, se debe distribuir cada componente entre devolución disponible, merma, consumo interno/cortesía y consumo del cliente. Solo la parte recuperable vuelve a existencias usando el costo snapshot original; las demás clasificaciones no descuentan ni valoran por segunda vez. Antes de entregar, una cancelación normal no devuelve stock. Un daño físico en preparación se reporta como daño separado.

El promedio ponderado móvil solo se calcula con costos conocidos. Las salidas conservan el último promedio aunque el saldo quede en cero o negativo. Una recepción con saldo previo `<= 0` reinicia el promedio con su costo real; una cantidad positiva cuyo costo anterior se desconoce permanece sin valoración en vez de asumir cero.

## Correcciones

El historial no se edita. Un error se corrige con un movimiento compensatorio y motivo. Las ventas anteriores a la activación no se recalculan. Los archivos `data/inventory-initial-suggestions.*` son material de revisión, no una carga automática.
