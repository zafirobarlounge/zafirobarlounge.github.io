# 020 · Señal Realtime de inventario

Aplicar manualmente después de `202609290019_inventory_void_courtesy.sql`.

La migración crea `inventory_realtime_events`, una señal mínima que contiene únicamente tipo de evento, identificador y fecha. Los triggers la alimentan cuando cambian movimientos, solicitudes, entradas o configuración.

Esto permite sincronizar Inventario y POS sin conceder lectura directa sobre movimientos, valoraciones o costos a Bar/Cocina. La tabla conserva siete días de señales y se agrega de forma idempotente a `supabase_realtime` cuando esa publicación existe.

No modifica cantidades, costos, recetas ni datos históricos.
