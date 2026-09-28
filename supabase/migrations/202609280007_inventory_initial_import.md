# Importación inicial de inventario

Aplicar manualmente `202609280007_inventory_initial_import.sql` en **zafiro-pruebas**, después de `202609280006_inventory_cost_valuation.sql`. No se ejecutó SQL remoto. La migración no importa archivos por sí sola, no reconstruye compras o ventas históricas y no crea existencias, recepciones ni gastos.

La migración añade un código estable opcional a los artículos, notas de importación, una bitácora inmutable por solicitud y huella SHA-256, y dos RPC:

- `inventory_import_preview(payload)`: valida el archivo normalizado contra artículos, presentaciones, recetas y claves reales de `menu_items`.
- `inventory_import_commit(request_id, fingerprint, payload)`: repite la validación bajo bloqueo, escribe todo en una transacción y devuelve el mismo resultado ante un reintento idéntico.

Ambas operaciones exigen `inventory_can_configure()`. Caja, barra y cocina pueden invocar técnicamente el RPC autenticado, pero el servidor lo rechaza. Las tablas siguen sin permisos de escritura directa para esos roles.

Un conteo inicial solo se crea cuando `initial_quantity` no es `null`; cero explícito sí es un conteo. `initial_unit_cost` sin cantidad se conserva únicamente como referencia en el XLSX y no inicia seguimiento. La importación no toca `inventory_receipts`, `pos_cash_movements`, `pos_orders` ni ventas anteriores.

## Aplicación y QA

1. Revisar y aplicar la migración manualmente en QA.
2. Entrar como administrador a `/admin/inventory`, pestaña **Configuración**.
3. Descargar la plantilla o seleccionar `data/zafiro-inventory-initial.xlsx` con **Importar inventario**.
4. Confirmar que la vista previa muestre 57 artículos, 49 presentaciones, 38 asociaciones y 0 conteos iniciales cuando la base esté vacía.
5. Confirmar la importación una vez y repetir el mismo archivo: no debe duplicar registros.
6. Verificar que los 57 artículos queden como **Sin conteo inicial** hasta registrar el conteo físico real.
