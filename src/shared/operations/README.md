# Operations Contracts

Esta carpeta contiene contratos TypeScript compartidos para la futura operación por mesas y mini POS de ZAFIRO Bar Lounge.

## Alcance actual

- solo tipos
- sin lógica runtime
- sin UI
- sin autenticación
- sin backend
- sin Supabase

## Propósito

- preparar una base consistente para la futura operación diaria del bar
- separar desde ahora los contratos de mesas, órdenes, pagos, caja y usuarios internos
- permitir que futuras pantallas admin reutilicen tipos estables sin afectar la web pública

## Cobertura del mini POS

Los contratos ya contemplan:
- mesas fijas y temporales
- zonas o áreas como salón, barra, terraza, VIP u otras
- cuenta activa por mesa
- mesero responsable
- cajero/admin que recibe pagos
- productos agregados con precio congelado al momento de cargarlos a la cuenta
- pagos parciales por monto
- pagos asociados a productos específicos
- pagos mixtos mediante múltiples asignaciones
- propina opcional
- descuento opcional simple
- auditoría básica de acciones
- sesión futura de caja

## Monto recibido y cambio

Los contratos de pago ya contemplan:
- monto que se debía cubrir
- monto realmente aplicado a la cuenta
- monto recibido del cliente
- cambio o devuelta

Esto permite escenarios como:
- pago exacto
- pago parcial con cambio
- pago total con cambio

## Pagos pendientes por Nequi o transferencia

Los pagos pueden quedar en estado:
- `pending`
- `confirmed`
- `rejected`

Esto deja base para que el cajero o admin:
- registre el intento de pago
- espere confirmación
- confirme o rechace el movimiento
- conserve una referencia opcional del pago

## Búsqueda rápida de productos

Se deja base para filtros de búsqueda rápida orientados a POS:
- búsqueda por nombre
- filtro por tipo
- filtro por subgrupo
- visibles en web pública
- disponibles
- destacados públicos
- visibles en POS
- frecuentes/rápidos en POS

## Caja futura

Los contratos dejan base para:
- efectivo esperado
- total confirmado
- pagos pendientes
- pagos rechazados
- desglose por método de pago
- futura sesión de caja

## Recomendación futura de base de datos

Cuando esta fase pase a runtime real, se recomienda **Supabase** como opción preferida por:
- PostgreSQL
- relaciones claras entre mesas, órdenes, pagos y usuarios
- Auth
- Realtime
- Storage para comprobantes o recursos futuros

## Módulos posteriores

No forma parte de esta fase:
- facturación electrónica
- impresoras
- reportes avanzados
- recetas o costeo
- sincronización multiusuario en tiempo real

El inventario ya se implementa en `src/admin/inventory` y su migración incremental 005. Los demás puntos siguen fuera de alcance. Estos contratos no cambian el comportamiento del sitio público.
