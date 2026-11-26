# Fecha comercial y apertura operativa a las 06:00

**Aplicar primero el SQL incremental en QA; después probar este frontend.** No se ejecutó SQL remoto. No volver a aplicar la migración de caja inicial ni los schemas base sobre QA.

Orden en `zafiro-pruebas`:

1. Ya aplicados: `schema.sql`, `pos-schema.sql`, `202609270001_cash_management.sql`.
2. Revisar y aplicar manualmente **solo `202609270002_sales_business_date.sql`**. Es una transacción de DDL, funciones y permisos; no actualiza registros existentes. No contiene un backfill. Es de aplicación única.
3. Recargar la aplicación local y probar `/admin/cash` y `/admin/pos`. La apertura manual usa `pos_cash_open`; si falta la migración devuelve un error explícito en lugar de ignorar la fecha seleccionada. La apertura automática sigue usando `pos_cash_ensure_session()` y adquiere la nueva regla al aplicar el SQL.

## Qué cambia

- La fuente de la regla en servidor es `pos_sales_cutoff_hour()` (6) y `pos_sales_business_date()`, siempre en America/Bogota. El default de `cutoff_hour` para nuevas filas consulta esa regla. El frontend usa `src/shared/operations/salesBusinessDate.ts` para sugerir hoy/ayer; ambos lados tienen pruebas de frontera.
- La apertura manual permite hoy o ayer calendario de Bogotá. La validación autoritativa usa la hora del servidor; ni el reloj del navegador ni un timestamp enviado por el cliente cambian la validación. Una pantalla dejada abierta hasta otro día puede requerir recarga si la selección ya dejó de ser válida.
- `business_date` se guarda separada de `opened_at`, `created_at` y `opened_by_email`. Para inserciones operativas nuevas, la base asigna hora real y usuario autenticado, incluso en inserciones directas. La base inicial tiene su propio responsable y hora, que pueden ser posteriores.
- Si existe jornada abierta, los pedidos la reutilizan sin cambiar fecha, etiqueta, corte ni hora. Cuando no existe, la apertura usa la sugerencia de las 06:00 y el bloqueo atómico que ya evita duplicados.
- Abrir automáticamente no crea una fila de caja: la base permanece sin registrar. Pedidos y cobros funcionan; gastos desde caja, aportes, retiros y arqueo exigen completar la base. El formulario explica que se debe ingresar el efectivo que había al inicio, sin sumar ventas posteriores. Completar base no actualiza la jornada ni sus cobros.
- Se eliminó el antiguo cálculo de las 18:00, sin uso, del repositorio TypeScript. Se conserva la alerta de cierre a las 06:00 ya existente: es una alerta, no una reasignación de fecha. Los `18` de estilos, iconos y sonidos no se tocaron.
- El flujo histórico manual existente conserva su implementación y su `18` explícito; sus fechas se eligen directamente y no usa la sugerencia de apertura operativa. No se reescriben las migraciones anteriores ni el schema histórico. No hay nuevos arqueos históricos ni ajustes posteriores al cierre.

## Comprobación manual en QA

1. Antes y después de aplicar, comprobar que la jornada de prueba del **26** conserva su fecha, `cutoff_hour`, hora, cobros, base y cierre (si existen). No se requiere cerrarla ni modificarla para instalar.
2. Si esa jornada sigue abierta, crear un pedido: debe reutilizarla, aun después de medianoche. No debe abrir una jornada adicional ni ofrecer cambiar la fecha al completar su base.
3. Para las pruebas de creación de nuevas jornadas, utilizar posteriormente un turno de prueba sin jornada abierta, resolviendo sus cuentas y arqueo mediante el flujo normal. No borrar/resetear datos para preparar las pruebas.
4. En Caja y gastos, verificar “Fecha de la jornada”, sugerencia y opciones hoy/ayer. Abrir con ayer y comprobar fecha elegida, hora real y responsable. Fechas anteriores o futuras enviadas por API deben rechazarse, sin crear jornada ni base.
5. En otro turno de prueba sin jornada abierta, enviar el primer pedido desde dos sesiones simultáneas. Debe existir una única jornada, sin base registrada. Registrar un cobro en efectivo; verificar que sigue permitiendo operar y que movimientos desde caja/arqueo piden la base.
6. Completar la base original: la fecha y el cobro previo permanecen; efectivo esperado = base más cobros netos, con los demás movimientos aplicables.
7. Horarios esperados de Bogotá para jornadas nuevas: 27 a las 11:00, 16:00 y 17:00 → 27; 28 a las 01:00 y 05:59 → 27; 28 a las 06:00 → 28. Estos horarios se verifican automáticamente con timestamps de prueba; no cambiar el reloj ni registros de QA para simularlos.

## Pruebas y límites

`npm run test:cash`, `npm run test:cash:db`, `npm run test:pos`, `npm run build`.

Resultados de esta revisión: **8 pruebas de cálculo/interfaz, 15 escenarios PostgreSQL y 39 pruebas del POS aprobados**; build y comprobación de whitespace correctos. Continúan las advertencias informativas de Vite sobre tamaño del bundle y Browserslist. La configuración efectiva del servidor Vite local se comprobó contra `pkcpxkvevqyzebhngzws.supabase.co` sin enviar consultas a ese proyecto.

El runner PostgreSQL crea un clúster temporal aislado, aplica primero los SQL previos con fixtures ficticios y luego **el archivo incremental real**. Verifica conservación de una jornada abierta del 26 con corte 18, límites horarios, selección manual, rechazo directo/RPC, concurrencia de dos pedidos, cobros sin base y base sin cambios de fecha/cobros. Ninguna prueba lee QA o producción. Las pruebas UI usan hooks/eventos simulados; la autenticación real, PostgREST y el uso completo en navegador requieren la comprobación manual anterior.
