# Ajustes de jornadas cerradas

Revisar y aplicar manualmente `202609270004_session_adjustments.sql` en zafiro-pruebas, después de 003. **El frontend actualizado necesita 004**. No repetir 001, 002 ni 003. No se ha ejecutado SQL remoto.

## Comportamiento

Superadmin/administración conserva Ajustar fechas, Mover de jornada y Anular venta en el reporte, incluso con arqueo. Cada acción exige motivo. Se registra usuario, fecha real, UUID de cuenta/jornadas, valores originales y solicitud idempotente. El traslado aparece en el historial de ambas jornadas y navega al UUID destino. El cajero sigue consultando/exportando sin escribir ajustes; mesero, cocina, barra y anónimo no tienen acceso al reporte financiero.

Las correcciones se agregan a un registro inmutable. **No se actualizan las cuentas, pagos, fechas, bases ni arqueos originales**. El reporte aplica las correcciones por orden y muestra las cuentas/ventas/cobros/fechas ajustadas; el bloque financiero conserva el arqueo original y el aviso explica la diferencia. Un traslado reasigna la cuenta completa y sus cobros en el reporte, no mueve efectivo entre cajas. Una anulación deja trazabilidad, excluye la venta/cobros de las cifras ajustadas y no registra un reembolso. Los listados operativos antiguos del POS conservan los registros originales; para consultar correcciones se usa “Ver detalle de la jornada”. No se introducen correcciones de base, gastos ni importes de pagos.

Las jornadas sin ajustes siguen usando su snapshot de ventas guardado cuando tienen arqueo. Las jornadas con ajustes de ventas usan las cuentas y pagos proyectados; el resumen de ventas original queda visible por separado. Un ajuste solo de fechas conserva el resumen del snapshot. El CSV conserva columnas anteriores, añade cantidad/historial de ajustes y vendido/cobrado al cierre original. Los campos financieros de caja siguen representando el cierre original, no un nuevo arqueo.

Eliminar queda bloqueado si hay arqueo o ajustes, también en servidor. Las jornadas sin registros financieros ni ajustes conservan su eliminación previa. Las vías antiguas de modificación de cuentas/jornadas quedan bloqueadas después de registrar ajustes para evitar mezclar cambios directos con correcciones. Los triggers que protegían arqueos no se relajan. El SQL no transforma registros existentes; solo crea tabla, permisos, funciones y triggers.

## QA manual

1. Aplicar 004 en QA tras revisión, recargar el frontend y entrar como superadmin.
2. Expandir una jornada arqueada: Ajustar fechas disponible, Eliminar deshabilitado; expandir una cuenta para Mover/Anular.
3. Mover una cuenta a otra jornada cerrada indicando motivo. Verificar URL destino, reporte corregido e historial en ambas; comparar los arqueos originales antes/después.
4. Repetir un traslado desde el destino para comprobar el seguimiento de su ubicación efectiva. Un cliente con datos antiguos debe recibir “Recarga el reporte”.
5. Ajustar fechas a otro mes y recargar el enlace por UUID. Comprobar las fechas corregidas y el motivo en el historial; el cierre real de caja permanece igual.
6. Anular una venta: excluida de cifras ajustadas, visible como anulada; el arqueo original no cambia. No se genera una devolución de dinero.
7. Comprobar exportación, cero frente a ausentes y escape de fórmulas en motivos. Probar cajero de solo lectura y denegación de otros roles.

## Validación local

Resultado: 55 pruebas de POS/caja/reporte aprobadas y build TypeScript/Vite correcto. Persisten los avisos de Browserslist antiguo y tamaño de bundle. `git diff --check` aprobado; configuración local QA verificada y migraciones 001–003 intactas.

Pruebas automatizadas del repositorio verifican traslado, anulación, fechas, origen vacío sin totales obsoletos, preservación del snapshot y no modificación de fixtures originales. La interfaz se prueba con hooks simulados: superadmin puede ajustar una arqueada pero no eliminarla; cajero sin acciones administrativas.

PostgreSQL 15 aislado: 20 escenarios aprobados, incluyendo permisos, motivo, idempotencia concurrente, detección de origen obsoleto, fechas inválidas, inmutabilidad y comparación de todos los registros originales de jornadas/cuentas/productos/pagos/arqueos antes y después. Solo se usa un clúster temporal con fixtures ficticios. No se probó Auth/PostgREST real ni se escribieron datos en QA.

Se conservaron los cambios locales previos: detalle financiero desplegable y creación manual con fecha actual Bogotá, apertura 18:00 y cierre 02:00 del día siguiente. Se corrigió el formato de fecha ISO para no depender del orden de `en-CA` en el entorno.
