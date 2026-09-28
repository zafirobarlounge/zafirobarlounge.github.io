# Guía operativa de Inventario

Ruta: `/admin/inventory`. La navegación **Existencias y solicitudes** también aparece en el POS para administración, caja, barra y cocina.

## Administración

1. Crea el artículo con una unidad base estable: unidad, gramo o mililitro; asigna barra/cocina, mínimo y objetivo.
2. Añade todas las presentaciones reales de compra, por ejemplo paquete x4 y paquete x6. El contenido siempre se expresa en la unidad base. El costo sugerido es opcional y solo precarga recepciones futuras.
3. Registra el primer conteo físico. Hasta entonces se muestra “Sin conteo inicial”; no se inventa un cero. Si conoces el costo unitario inicial puedes registrarlo; si no, la valoración queda “Sin costo conocido”.
4. Configura el consumo de cada producto del menú con uno o más artículos. Marca “Control parcial” cuando solo se miden algunos componentes.
5. Revisa solicitudes, conteos y daños. Aprobar una reposición no aumenta stock; la recepción sí.

### Importación inicial XLSX

En **Configuración** solo administración puede descargar la plantilla e importar un archivo `.xlsx`. El formato exacto es:

- `Articulos`: `codigo`, `nombre`, `area`, `unidad_base`, `existencia_inicial`, `costo_unitario_inicial`, `minimo`, `objetivo`, `observaciones`.
- `Presentaciones`: `codigo_articulo`, `presentacion`, `contenido`, `unidad`, `costo_sugerido`, `observaciones`.
- `ConsumoMenu`: `producto_menu`, `codigo_articulo`, `cantidad_base`, `unidad`, `tipo_control`.
- `Pendientes`: `articulo_relacion`, `dato_faltante`, `motivo`; es informativa y no se importa.

Los valores admitidos en el Excel son `unidad`, `gramo`, `mililitro`; las áreas son `barra`, `cocina`, `ambas`; `tipo_control` es `parcial`. `producto_menu` debe ser la clave estable exacta de `menu_items`, por ejemplo `comida::quesadilla-zafiro::1`. Una celda numérica vacía se conserva como desconocida y nunca se convierte a cero.

La vista previa local valida hojas, columnas, duplicados y unidades. La vista previa del servidor clasifica registros nuevos y existentes y detecta conflictos. Confirmar ejecuta una sola transacción auditada e idempotente. El archivo revisable de Zafiro está en `data/zafiro-inventory-initial.xlsx`; no se carga automáticamente.

## Caja

Caja consulta existencias, último costo real de compra y valor contable rastreado, registra conteos iniciales/correcciones compensatorias, recibe compras y revisa reportes. Al recibir, selecciona una presentación, cantidad de paquetes y costo real por paquete; también puede usar unidad base con total de línea o costo unitario. La vista previa muestra conversión, total y costo base. Puede enlazar un gasto existente por UUID. La recepción nunca genera el gasto automáticamente. El costo sugerido de la presentación solo precarga el formulario y no cambia el costo vigente hasta registrar una recepción con costo conocido.

Existencias permite buscar por nombre o código disponible, filtrar por área y estado y ordenar alfabéticamente. No se ordenan cantidades entre unidades base distintas. Cada tarjeta abre el conteo/corrección o la entrada con el artículo bloqueado; un artículo sin conteo inicial mantiene impedida la recepción. Los listados largos de configuración, presentaciones, recetas, reportes y entradas incluyen búsqueda sin cambiar el UUID seleccionado.

## Barra y cocina

Cada área ve solo sus artículos y no ve costos. El recorrido es: consultar existencia → crear solicitud/conteo/daño → guardar borrador o enviar → ver estado. Enviar no cambia la existencia. Administración o caja decide la aprobación.

En el POS, las pestañas operativas **Bar** y **Cocina** incluyen **Inventario del área** debajo de la cola de preparación. El panel se actualiza al entrar en la pestaña, permite buscar y filtrar por estado, y muestra los reportes recientes de esa misma área. Los artículos compartidos aparecen en ambas pestañas. Desde este panel los tres tipos de reporte se envían directamente a revisión; no ofrece recepciones, ajustes, configuración ni datos de costos.

## POS

Al entregar, el POS descuenta una sola vez la receta vigente y guarda una copia de sus componentes y del último costo real vigente. El producto sin receta se entrega normalmente y se identifica como sin seguimiento. Una alerta de posible agotado o control parcial informa, pero no oculta productos ni bloquea ventas. En recetas parciales se muestra el costo vigente de los componentes controlados y solo se incluyen los componentes configurados.

Si se anula una unidad ya entregada, se debe distribuir cada componente entre devolución disponible, merma, consumo interno/cortesía y consumo del cliente. Solo la parte recuperable vuelve a existencias usando el costo snapshot original; las demás clasificaciones no descuentan ni valoran por segunda vez. Antes de entregar, una cancelación normal no devuelve stock. Un daño físico en preparación se reporta como daño separado.

Cada recepción con costo conocido reemplaza el costo operativo vigente por su costo real por unidad base. Recepciones sin costo, conteos, correcciones y devoluciones no lo cambian. Las ventas futuras usan ese valor y lo congelan en el consumo y movimiento, por lo que una compra posterior no recalcula ventas anteriores.

El promedio ponderado móvil continúa como dato contable e histórico para mantener compatibilidad con la valoración existente. Las salidas conservan ese promedio aunque el saldo quede en cero o negativo. Una recepción con saldo previo `<= 0` reinicia el promedio contable con su costo real; una cantidad positiva cuyo costo anterior se desconoce permanece sin valoración en vez de asumir cero. Ese promedio ya no se usa como costo operativo actual.

## Correcciones

El historial no se edita. Un error se corrige con un movimiento compensatorio y motivo. Las ventas anteriores a la activación no se recalculan. Los archivos `data/inventory-initial-suggestions.*` son material de revisión, no una carga automática.
