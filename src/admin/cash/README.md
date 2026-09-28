# Caja y gastos

Ruta: `/admin/cash`, enlazada desde el panel, la cabecera y el control de jornada del POS.

Actualización de fecha comercial: consultar [migración incremental y prueba en QA](../../../supabase/migrations/202609270002_sales_business_date.md). El corte para jornadas operativas nuevas es a las 06:00 en Bogotá. Este frontend requiere aplicar primero `202609270002_sales_business_date.sql` para la apertura manual; no se debe repetir la migración inicial ya aplicada.

## Habilitación pendiente

No se ejecutó SQL ni se consultaron datos de producción. La rama no debe desplegarse antes de revisar y aplicar su migración. No ejecutar `pos-schema.sql`, seeds, recuperación ni resets sobre una instalación existente para habilitar este módulo.

1. Revisar `supabase/migrations/202609270001_cash_management.sql` y las restricciones descritas abajo. La migración es de aplicación única, transaccional y no transforma registros existentes.
2. Un operador autorizado debe comparar el esquema desplegado con el repositorio y revisar las consultas de solo lectura de `202609270001_cash_preflight.sql`. Si existen varias jornadas abiertas o pagos vinculados a una jornada distinta de su cuenta, detener cualquier corrección: esos registros requieren una decisión independiente y explícita. El módulo no los reasigna ni inventa bases.
3. Probar primero en una base de staging aislada con los roles reales de Supabase Auth. Verificar acceso de caja y superadmin, y denegación de mesero, cocina, barra y anónimo. Las pruebas locales simulan JWT/roles; no sustituyen la validación del proveedor Auth y PostgREST desplegados.
4. Tras aprobar el SQL y disponer del respaldo operativo habitual, aplicar **solo** la migración nueva en una ventana sin operaciones POS. Las transacciones en curso deben terminar antes. No ejecutarla automáticamente desde el frontend.
5. Revisar el PR y autorizar por separado el merge/despliegue del frontend. GitHub Pages publica al actualizar `main`; este trabajo no hizo merge ni desplegó.
6. Al entrar en Caja y gastos, completar la base de la jornada activa si aparece «Sin registrar». Esa base queda con fecha real de registro y usuario; no se alteran fechas ni cifras históricas.

Se reutilizan `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. No se necesita ninguna clave privilegiada en el navegador.

## Operación

- Apertura explícita: registra base (admite cero) y nota. Crea la jornada existente del POS y la apertura en una misma transacción. Si el POS ya abrió automáticamente la jornada al operar, se completa su base en esa misma jornada; hasta entonces no se permiten movimientos desde caja ni arqueo.
- Gastos: concepto, categoría, valor, fecha, método y origen. Solo `Caja del local` con `Efectivo` afecta el efectivo esperado y exige jornada activa con base. Negocio fuera de caja y propietario admiten todos los métodos y pueden registrarse sin jornada. Pagar directamente con dinero del propietario no crea un aporte.
- Aportes y retiros: efectivo, monto y motivo; no se contabilizan como ventas ni gastos. Un gasto ya pagado desde caja no debe duplicarse como retiro. La aplicación nunca genera ambos automáticamente.
- Cierre: termina las cuentas en POS y confirma/rechaza pagos pendientes. Actualiza caja, introduce efectivo contado y observación. Si hay diferencia, explica el faltante/sobrante. Se compara el esperado visto en pantalla con el recalculado en servidor; si cambió, se rechaza todo el cierre y se pide actualizar.
- Historial: selecciona jornada para ver base, componentes y arqueo. Filtra movimientos por jornada/fecha/categoría/método/origen. Insumos es un subconjunto de gastos. Exporta el detalle filtrado a CSV, incluidos los anulados y sus motivos.
- Anulación: solo superadmin, con motivo. Permitida si la jornada relacionada sigue abierta (o en gastos sin jornada); conserva el original y su responsable/fecha. No existe eliminación de movimientos en la interfaz.
- Si la conexión falla con resultado incierto, se conserva localmente la solicitud pendiente del usuario. Usa «Reintentar operación pendiente» incluso después de recargar: conserva el UUID y no duplica el registro. Las respuestas de rechazo de la base no dejan cambios parciales. Un fallo de recarga después de guardar se informa como tal.

## Cálculos y protección

`esperado = base + SUM(pagos cash confirmed.amount_applied) + aportes - gastos desde caja - retiros`.

No se suma `amount_received` ni el cambio. El cierre almacena componentes, esperado, contado, diferencia, motivo, usuario y hora en la misma transacción que cierra la jornada. Los importes nuevos usan `numeric(14,2)` y se validan en servidor; no se cambia el tipo de importes existentes.

Tablas nuevas: `pos_cash_registers`, `pos_cash_movements`, `pos_cash_audit`. Solo admiten lectura con RLS para caja/superadmin; no se otorgan escrituras directas. Las funciones de escritura obtienen la identidad del JWT, comprueban rol y generan la auditoría dentro de la transacción. Las funciones internas no son ejecutables por usuarios API.

Todas las escrituras sobre jornadas, cuentas, líneas y pagos toman el mismo bloqueo transaccional que caja. Es una decisión conservadora para un solo local: serializa brevemente escrituras y prioriza la consistencia del arqueo. Un bloqueo mutuo de operaciones POS heredadas puede ser rechazado por PostgreSQL y exige reintentar; no se omiten bloqueos para forzar la operación.

Después del arqueo se rechazan cambios en la jornada, anulaciones de sus ventas, modificaciones de productos/pagos y reasignaciones desde o hacia ella, incluidas las funciones administrativas existentes. Una jornada con registros de caja no puede eliminarse, aunque aún esté abierta. No se permite reabrir jornadas históricas. Los botones heredados reciben mensajes explicando la restricción desde la base.

La migración no añade arqueos a jornadas antiguas. Al cerrar, una cuenta/pago con asociación inconsistente detiene la operación; no se transforma el dato. No se ofrece corrección posterior al cierre en esta versión: debe diseñarse un procedimiento de ajustes explícitos, separado de las operaciones ordinarias.

## Verificación

Los ajustes posteriores al cierre se documentan en [migración 004: alcance, SQL y QA](../../../supabase/migrations/202609270004_session_adjustments.md). Requieren aplicar 004 manualmente antes de usar el frontend actualizado.

El detalle financiero de `/admin/sales-sessions` requiere la migración incremental 003. Véanse [SQL, permisos, compatibilidad CSV, resultados y pasos de QA](../../../supabase/migrations/202609270003_session_financial_report.md). La aplicación en QA es manual; no repetir 001/002.

```sh
npm run test:cash
npm run test:pos
npm run test:report
npm run test:cash:db
npm run build
```

`test:cash:db` necesita los binarios PostgreSQL 15 (`PGBIN` para otra ruta). Crea un clúster **nuevo** bajo el directorio temporal, elige un puerto local libre y conecta exclusivamente a `127.0.0.1`. No acepta URL de base, ignora las variables `PG*` heredadas y no utiliza `.env` ni Supabase. En Linux debe ejecutarse con un usuario no root. Usa fixtures ficticios, detiene el clúster al terminar y conserva sus archivos para inspección; no borra bases existentes.

Las pruebas cubren cálculo, neto/cambio, transferencias, orígenes, base cero, anulaciones, faltantes, transiciones, rechazo de importes inválidos, RLS, escritura directa, snapshots, conservación histórica, apertura/movimiento idempotentes y una carrera real cierre/movimiento. Las pruebas existentes del POS cubren pedidos, preparación, sincronización, pagos e históricos según sus mocks. Pendiente antes del despliegue: prueba de uso de extremo a extremo con Supabase Auth/PostgREST reales y los roles de staging.

Resultados locales del 27 de septiembre de 2026: 39 pruebas existentes del POS, 6 pruebas de cálculo/interfaz y 12 escenarios de PostgreSQL aislado aprobados. `npm run build` y `git diff --check` aprobados. Vite informa advertencias sobre tamaño del bundle y antigüedad de Browserslist; no son fallos del build. La prueba de interfaz usa un entorno simulado de hooks/eventos, no un navegador autenticado contra Supabase.

Limitaciones: consulta completa de movimientos/jornadas mediante RPC (sin truncamiento por el límite de filas de PostgREST); para historiales grandes habrá que añadir filtros/paginación en servidor. No hay inventario, costeo, nómina, reembolsos, integraciones bancarias ni utilidad neta. No se recalculan ni se corrigen históricos automáticamente.
