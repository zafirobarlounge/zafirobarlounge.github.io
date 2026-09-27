# Detalle financiero de jornada

Requiere aplicar manualmente **202609270003_session_financial_report.sql**, después de 001 y 002, antes de usar el reporte actualizado en QA. No se ejecutó SQL remoto. Las migraciones 001 y 002 se conservan intactas; 003 no transforma registros. No repetir los schemas base ni migraciones ya aplicadas.

## Consulta

`/admin/sales-sessions?session=<UUID>` conserva el destino al recargar y expande esa jornada aunque esté fuera del mes/rango. Los filtros existentes permanecen; un aviso indica que se incluye además el destino del enlace. “Volver al filtro del periodo” elimina esa excepción. Un UUID desconocido muestra un mensaje sin sustituirlo por otra jornada.

POS y Caja y gastos ofrecen “Ver detalle de la jornada”. El enlace de POS apunta a la jornada activa y el de Caja a la seleccionada. Se conserva el acceso mediante el botón Abrir/Cerrar jornada y la eliminación previa del enlace redundante de cabecera.

Se conservan ventas, cuentas, productos y exportación de detalle. Cobros confirmados se presentan por efectivo, Nequi, transferencia bancaria, tarjeta y otros, usando importes netos aplicados. La comparación global de efectivo frente a otros medios no etiqueta estos últimos como transferencias.

El bloque financiero reutiliza `loadCash`, `expectedCash` y `movementTotals`. Asocia solo por UUID. Incluye base, aportes, retiros, gastos por origen, esperado y datos del arqueo. Los anulados permanecen con su usuario, fecha y motivo, excluidos de los totales. Ningún gasto sin jornada se atribuye por coincidencia de fecha o etiqueta. No se calcula utilidad.

Las jornadas abiertas muestran valores consultados y “Pendiente de cierre”. Base/arqueo ausentes muestran “Sin registrar”. En jornadas arqueadas, componentes, esperado, contado, diferencia y demás datos de caja vienen del snapshot guardado; el resumen de ventas/cobros también usa `pos_sales_sessions.summary` guardado al cerrar. Los gastos de negocio/propietario se consultan de sus movimientos asociados, protegidos contra cambios por el cierre. No se reconstruyen arqueos históricos ausentes.

Ventas y caja se cargan independientemente. Un fallo de caja muestra un error y “Reintentar carga de caja”; no borra el reporte de ventas ni presenta totales financieros ficticios. El CSV de resumen espera la carga financiera para evitar una exportación incompleta; el detalle original de ventas puede exportarse.

## Permisos y SQL

- Reporte RPC `pos_session_report`: solo usuarios autorizados por `pos_cash_allowed()` (caja y administración/superadmin). Anónimo y mesero/cocina/bar no pueden ejecutarlo con éxito. Las tablas de caja y `pos_cash_read` mantienen su RLS/autorización existente.
- Cajero: consulta y exportación del reporte. No hay botones/modales administrativos; los handlers también comprueban permiso. No se confía en estos controles: triggers nuevos bloquean administración directa de jornadas, reasignación de cuentas y modificación de ventas ya cerradas para usuarios no administradores. Se conserva el registro normal de pedidos, cobros y cierre de cuentas/jornada mediante sus flujos operativos.
- Las cinco funciones históricas existentes se redefinen únicamente para reconocer también el rol superadmin mediante `pos_cash_allowed(true)`. Conservan el flujo y sus validaciones; no se invocan durante la migración.
- Los triggers de protección de arqueos de 001 permanecen activos para todos, incluido admin. La interfaz oculta acciones sobre jornadas arqueadas y bloquea acciones si aún no pudo comprobar el estado de caja. No hay ajustes posteriores al arqueo nuevos.
- Las lecturas operativas POS existentes conservan su modelo de permisos; esta migración no rediseña el acceso de meseros/preparadores a datos necesarios para operar cuentas activas.

La nueva consulta reutiliza los mapeadores y cálculos del repositorio POS sobre una respuesta RPC autorizada, sin descargar cada tabla de nuevo por cada jornada. Como `loadCash`, devuelve el historial completo sin truncar a 1000 filas; el tamaño de respuesta puede requerir paginación futura para historiales grandes.

## CSV

Se conservan nombres/columnas anteriores y el CSV de detalle de ventas. En el resumen se añaden métodos, base, aportes, retiros, gastos por cada origen, esperado, contado, diferencia, estado, explicación, observaciones, responsable y fecha de cierre de caja.

Compatibilidad: la columna heredada `transferencias` conserva su agregado no efectivo para no romper consumidores existentes. Las nuevas columnas `no_efectivo` y `transferencia_bancaria` identifican explícitamente el agregado y las transferencias bancarias reales, respectivamente. En pantalla, Nequi, transferencia, tarjeta y otros se muestran por separado; el agregado se llama “Otros medios (sin efectivo)”.

Ausencia se exporta como celda vacía y cero como 0. Los textos que pueden iniciar fórmulas se neutralizan, se escapan comillas/separadores/saltos, y los números negativos permanecen numéricos. `fecha_cierre_caja` usa ISO con zona; en pantalla se muestra Bogotá.

## Comprobación QA

1. Revisar y aplicar solo 003 en `zafiro-pruebas`; recargar el frontend local. No modificar secrets ni producción.
2. Abrir el detalle desde POS y Caja, elegir una jornada fuera del mes, recargar URL y comprobar que conserva el UUID. Probar un ID inexistente y volver al filtro.
3. Comparar una jornada sin base, una abierta y una arqueada. Revisar que el arqueo coincide con sus componentes guardados; comprobar movimientos anulados y gastos externos/sin jornada.
4. Exportar resumen y detalle; verificar métodos separados, ausentes frente a cero y los campos del cierre.
5. Con caja, verificar consulta/exportación sin acciones administrativas; con mesero/cocina/bar comprobar denegación. Confirmar con Auth/PostgREST reales que tampoco pueden invocar las operaciones restringidas. Con admin, una jornada arqueada debe seguir protegida.
6. Simular fallo de la petición de caja en herramientas de red: deben seguir visibles las ventas, aparecer el error recuperable y bloquearse el resumen CSV hasta reintentar correctamente.

Las pruebas automáticas de interfaz usan mocks de hooks/eventos; las de base usan JWT simulados sobre PostgreSQL local aislado. No equivalen a probar Auth ni PostgREST reales en QA. No se modificaron datos remotos.

## Resultados locales — 27 de septiembre de 2026

- POS: 40 pruebas aprobadas, incluida la lectura del snapshot de ventas guardado mediante el nuevo RPC.
- Caja y reporte: 13 pruebas aprobadas (8 de caja y 5 del reporte). Cubren UUID fuera del periodo y recarga simulada, permisos de interfaz, errores recuperables, métodos, ausencia frente a cero, snapshots, anulados y gastos sin jornada.
- PostgreSQL 15 aislado: 17 escenarios aprobados, incluidos concurrencia, roles denegados, cajero operativo sin administración y protección de arqueos para admin. Se aplicaron los SQL únicamente en el clúster temporal de pruebas.
- Build TypeScript/Vite aprobado. Persisten avisos de Browserslist antiguo y tamaño de bundle; no bloquean la compilación.
- No se realizó una prueba con Auth real ni una inspección visual autenticada en QA. La lista anterior describe validación automatizada local.
