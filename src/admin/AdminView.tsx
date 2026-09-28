import { Link, Navigate } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { useSupabaseAuth } from '../auth/SupabaseAuthProvider';

export function AdminView() {
  const { canAccessCatalog, canAccessPos, isCatalogAdmin, staffRoles, staffProfile } = useSupabaseAuth();

  if (canAccessPos && !canAccessCatalog) {
    return <Navigate to="/admin/pos" replace />;
  }

  if (canAccessCatalog && !canAccessPos) {
    return <Navigate to="/admin/menu" replace />;
  }

  const availableModules = [
    (isCatalogAdmin || staffRoles.some((role) => ['superadmin', 'cashier', 'bar', 'kitchen'].includes(role)))
      ? { cta: 'Abrir inventario', description: 'Existencias, entradas, solicitudes, conteos, mermas y consumo del POS.', title: 'Inventario', to: '/admin/inventory', tone: 'pos' }
      : null,
    (isCatalogAdmin || staffRoles.includes('cashier') || staffRoles.includes('superadmin'))
      ? { cta: 'Abrir caja y gastos', description: 'Base inicial, gastos, aportes, retiros y arqueos por jornada.', title: 'Caja y gastos', to: '/admin/cash', tone: 'sessions' }
      : null,
    canAccessCatalog
      ? {
          cta: 'Abrir modulo de menu',
          description: 'Revision interna de productos, visibilidad, disponibilidad, destacados, orden y precios del menu publico.',
          title: 'Menu',
          to: '/admin/menu',
          tone: 'catalog',
        }
      : null,
    canAccessPos
      ? {
          cta: 'Abrir operacion POS',
          description: 'Operacion por mesas, productos por pedido, preparacion separada y caja parcial o total en tiempo real.',
          title: 'Mini POS / Mesas',
          to: '/admin/pos',
          tone: 'pos',
        }
      : null,
    (isCatalogAdmin || staffRoles.includes('cashier') || staffRoles.includes('superadmin'))
      ? {
          cta: 'Ver jornadas',
          description: 'Historial completo de jornadas POS, resumen de ventas y anulaciones administrativas.',
          title: 'Jornadas POS',
          to: '/admin/sales-sessions',
          tone: 'sessions',
        }
      : null,
    isCatalogAdmin
      ? {
          cta: 'Abrir ajustes POS',
          description: 'Configura el flujo operativo del POS para cocina y bar, solo visible para superadmin.',
          title: 'Ajustes POS',
          to: '/admin/pos-settings',
          tone: 'pos',
        }
      : null,
  ].filter(Boolean) as Array<{
    cta: string;
    description: string;
    title: string;
    to: string;
    tone: 'catalog' | 'pos' | 'sessions';
  }>;

  return (
    <AdminLayout>
      <section className="max-w-3xl">
        <p className="text-[0.72rem] uppercase tracking-[0.28em] text-cyanGlow/80">ZAFIRO Admin</p>
        <h1 className="mt-4 font-display text-[2.8rem] leading-none text-ivory sm:text-[3.6rem]">Panel interno de administracion</h1>
        <p className="mt-5 max-w-2xl text-base leading-8 text-mist sm:text-lg">
          Desde aqui entras solo a los modulos que tu cuenta tiene habilitados dentro del backoffice operativo de ZAFIRO.
        </p>
      </section>

      <section className="mt-10 grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-4">
        {availableModules.map((module) => (
          <Link
            key={module.to}
            to={module.to}
            className={`interactive-card group flex min-h-[13.5rem] flex-col justify-between rounded-[1.25rem] border p-5 shadow-[0_16px_34px_rgba(0,0,0,0.2)] transition hover:border-cyanGlow/30 sm:p-6 ${
              module.tone === 'catalog'
                ? 'border-cyanGlow/16 bg-[linear-gradient(135deg,rgba(36,107,255,0.12),rgba(255,255,255,0.035))]'
                : module.tone === 'sessions'
                  ? 'border-amberGlow/20 bg-[linear-gradient(135deg,rgba(245,158,11,0.11),rgba(255,255,255,0.035))]'
                : 'border-sapphire/28 bg-[linear-gradient(135deg,rgba(9,28,58,0.78),rgba(36,107,255,0.1))]'
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-3">
                <p className={`text-[0.62rem] uppercase tracking-[0.22em] ${module.tone === 'sessions' ? 'text-amberGlow' : 'text-cyanGlow/80'}`}>
                  Modulo habilitado
                </p>
                <span className={`h-2.5 w-2.5 rounded-full ${module.tone === 'sessions' ? 'bg-amberGlow' : 'bg-cyanGlow'}`} />
              </div>
              <h2 className="mt-5 font-display text-[1.75rem] leading-none text-ivory sm:text-[2rem]">{module.title}</h2>
              <p className="mt-4 text-sm leading-6 text-mist">{module.description}</p>
            </div>
            <span className={`mt-6 inline-flex text-[0.68rem] font-semibold uppercase tracking-[0.2em] ${module.tone === 'sessions' ? 'text-amberGlow' : 'text-cyanGlow/85'}`}>
              {module.cta}
            </span>
          </Link>
        ))}

        <article className="flex min-h-[13.5rem] flex-col justify-between rounded-[1.25rem] border border-white/10 bg-white/[0.035] p-5 sm:p-6">
          <div>
            <p className="text-[0.62rem] uppercase tracking-[0.22em] text-amberGlow">Tu acceso</p>
            <div className="mt-5 inline-flex rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-emerald-200">
              {availableModules.length} modulo(s)
            </div>
          </div>
          <p className="mt-5 text-sm leading-6 text-mist">
            {staffProfile
              ? `${staffProfile.fullName} solo vera lo que su sesion tiene habilitado. Si una cuenta no tiene menu, no se muestra menu. Si no tiene POS, no entra a POS.`
              : 'El backoffice ya puede filtrar vistas por permisos reales sin afectar la web publica.'}
          </p>
        </article>
      </section>
    </AdminLayout>
  );
}
