# Aplicación parcial de recepciones a solicitudes

Aplicar manualmente en QA después de `202609280008_inventory_last_purchase_cost.sql`.

Esta migración añade `inventory_receipt_lines.applied_submission_quantity` para distinguir la cantidad completa recibida de la parte que cubre una solicitud de reposición.

- `base_quantity` conserva toda la mercancía que ingresó.
- `applied_submission_quantity` conserva únicamente `least(pendiente, base_quantity)`.
- Las existencias, los costos y la valoración usan `base_quantity` completa.
- `inventory_submission_lines.received_quantity` aumenta solo por la cantidad aplicada y nunca supera la aprobada.
- Las recepciones anteriores vinculadas se rellenan con `base_quantity`, ya que el flujo anterior rechazaba excedentes.
- Las recepciones directas conservan `applied_submission_quantity = null`.

La migración desactiva temporalmente y dentro de la misma transacción el trigger inmutable de líneas de recepción para realizar exclusivamente el backfill. Lo reactiva antes de instalar la nueva función de comandos.

No ejecutar automáticamente ni aplicar en producción como parte de este cambio.
