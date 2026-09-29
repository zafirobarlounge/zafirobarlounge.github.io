# 011 · Áreas dinámicas de inventario

Aplicar manualmente `202609290011_dynamic_inventory_areas.sql` en QA después de la migración 010.

La migración crea `inventory_areas` y registra `bar`, `kitchen` y `operations`. Conserva los códigos de área existentes en `inventory_item_areas.area` e `inventory_submissions.area`, elimina sus restricciones cerradas y añade claves foráneas hacia `inventory_areas.code`. Esta estrategia evita reescribir asociaciones o solicitudes históricas.

También actualiza las RPC de lectura, comandos, paginación e importación. Barra y Cocina permanecen como códigos protegidos y como las únicas áreas admitidas por recetas y paneles del POS. Las áreas adicionales organizan inventario y reportes, sin crear roles ni espacios operativos.

La migración no crea existencias, recepciones, gastos ni movimientos históricos. No modifica cantidades o costos.
