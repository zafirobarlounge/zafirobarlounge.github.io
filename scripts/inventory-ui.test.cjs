const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const compile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const domain = { exports: {}, Intl, Date };
vm.runInNewContext(compile('src/admin/inventory/inventory.domain.ts'), domain);

test('cantidades distinguen ausencia de cero y respetan precisión', () => {
  assert.equal(domain.exports.formatInventoryQuantity(null, 'unit'), 'Sin conteo inicial');
  assert.match(domain.exports.formatInventoryQuantity(0, 'unit'), /^0 unidad/);
  assert.match(domain.exports.formatInventoryQuantity(12.5, 'gram', 3), /12,5 g/);
});

test('vista previa calcula presentación, total y costo base sin usar redondeo como autoridad', () => {
  const bread = domain.exports.receiptCostPreview(3, 6, 7000, 'package');
  assert.equal(bread.baseQuantity, 18);
  assert.equal(bread.lineTotal, 21000);
  assert.ok(Math.abs(bread.baseUnitCost - (7000 / 6)) < 1e-10);
  const sauce = domain.exports.receiptCostPreview(1, 200, 4990, 'package');
  assert.equal(sauce.baseQuantity, 200);
  assert.equal(sauce.lineTotal, 4990);
  assert.equal(sauce.baseUnitCost, 24.95);
  const whole = domain.exports.inventoryMoneyInput('7.000');
  assert.equal(whole.display, '7.000');
  assert.equal(whole.value, 7000);
  const decimal = domain.exports.inventoryMoneyInput('24,95');
  assert.equal(decimal.display, '24,95');
  assert.equal(decimal.value, 24.95);
});

test('CSV de inventario protege fórmulas y conserva referencias', () => {
  const csv = domain.exports.inventoryMovementCsv([{
    id: 'movement', item_id: 'item', item_name: '=IMPORTXML("x")', movement_type: 'correction', quantity_delta: -2,
    base_unit_snapshot: 'unit', reason: '+riesgo', actor: '@actor', occurred_at: '2026-09-27T20:00:00Z',
    sales_session_id: 'session-uuid', order_id: null, order_item_id: null, metadata: {},
  }]);
  assert.match(csv, /'=IMPORTXML/);
  assert.match(csv, /'\+riesgo/);
  assert.match(csv, /'@actor/);
  assert.match(csv, /session-uuid/);
});

test('rutas y navegación exponen inventario solo a roles previstos', () => {
  const routes = readFileSync('src/routes/AppRouter.tsx', 'utf8');
  const hub = readFileSync('src/admin/AdminView.tsx', 'utf8');
  const pos = readFileSync('src/admin/AdminPosView.tsx', 'utf8');
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(routes, /path="\/admin\/inventory"/);
  for (const role of ['superadmin', 'cashier', 'bar', 'kitchen']) assert.match(hub, new RegExp(role));
  assert.doesNotMatch(hub.match(/Abrir inventario[\s\S]{0,300}/)?.[0] ?? '', /waiter/);
  assert.match(pos, /Existencias y solicitudes/);
  assert.match(view, /\['superadmin','cashier','bar','kitchen'\]/);
  assert.match(view, /Tu rol no tiene acceso al inventario/);
});

test('interfaz muestra conversión congelada y separa recepción de gasto', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /Recibirás/);
  assert.match(view, /conversión y estos costos quedarán congelados/);
  assert.match(view, /La recepción no crea gastos automáticamente/);
  assert.match(view, /Recepción directa en unidad base/);
  assert.match(view, /Costo real por paquete o envase/);
  assert.match(view, /Costo promedio rastreado/);
  assert.match(view, /Valor inventariable rastreado/);
  assert.match(view, /Costo de componentes controlados/);
  assert.match(view, /solo incluye los componentes configurados/);
  assert.doesNotMatch(view, /costo total del plato/i);
  assert.doesNotMatch(view, /utilidad neta|margen neto/i);
});

test('migración 006 congela costos y aplica valoración sin acoplarla a gastos', () => {
  const sql = readFileSync('supabase/migrations/202609280006_inventory_cost_valuation.sql', 'utf8');
  assert.match(sql, /suggested_package_cost/);
  for (const field of ['actual_package_cost','line_total_cost','base_unit_cost','average_unit_cost_snapshot','tracked_cost']) assert.match(sql, new RegExp(field));
  assert.match(sql, /old_qty<=0/);
  assert.match(sql, /old_qty\*old_avg/);
  assert.match(sql, /cl\.average_unit_cost_snapshot,'return'/);
  assert.match(sql, /expense\.amount<>derived_total/);
  assert.doesNotMatch(sql, /update public\.pos_cash_movements/);
});
