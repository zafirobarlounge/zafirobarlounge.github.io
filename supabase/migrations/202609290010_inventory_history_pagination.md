# Paginación de historiales de inventario

Aplicar manualmente en QA después de `202609280009_inventory_receipt_request_application.sql`.

La migración conserva `inventory_read()` para estado actual y configuración, y deja sus claves históricas como arrays vacíos por compatibilidad. Entradas, solicitudes, movimientos y reportes recientes se consultan mediante RPC independientes con autorización equivalente a la existente.

Los cursores combinan fecha y UUID. Entradas y solicitudes entregan 20 filas, movimientos 50 y reportes recientes del área 8. La exportación consulta bajo demanda todos los movimientos del mes contable seleccionado sin cargarlos al abrir Inventario.

No ejecutar automáticamente ni aplicar en producción como parte de este cambio.
