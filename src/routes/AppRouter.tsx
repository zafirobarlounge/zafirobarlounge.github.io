import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAdminAuth } from '../auth/RequireAdminAuth';
import { RequireCatalogAdminAuth } from '../auth/RequireCatalogAdminAuth';
import { AdminLoginView } from '../admin/AdminLoginView';
import { AdminMenuView } from '../admin/AdminMenuView';
import { AdminPosView } from '../admin/AdminPosView';
import { AdminPosSettingsView } from '../admin/AdminPosSettingsView';
import { AdminSalesSessionsView } from '../admin/AdminSalesSessionsView';
import { AdminCashView } from '../admin/cash/AdminCashView';
import { AdminView } from '../admin/AdminView';
import { HomeView } from '../views/HomeView';
import { MenuView } from '../views/MenuView';

export function AppRouter() {
  return (
    <Routes>
      <Route path="/admin/login" element={<AdminLoginView />} />
      <Route element={<RequireAdminAuth />}>
        <Route path="/admin" element={<AdminView />} />
        <Route path="/admin/cash" element={<AdminCashView />} />
        <Route path="/admin/pos" element={<AdminPosView />} />
        <Route path="/admin/pos-settings" element={<AdminPosSettingsView />} />
        <Route path="/admin/sales-sessions" element={<AdminSalesSessionsView />} />
      </Route>
      <Route element={<RequireCatalogAdminAuth />}>
        <Route path="/admin/menu" element={<AdminMenuView />} />
      </Route>
      <Route path="/" element={<HomeView />} />
      <Route path="/menu" element={<MenuView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
