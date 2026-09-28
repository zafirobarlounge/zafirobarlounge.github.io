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
  assert.match(view, /Conversión antes de guardar/);
  assert.match(view, /Esta conversión quedará congelada/);
  assert.match(view, /La recepción no crea gastos automáticamente/);
  assert.match(view, /Recepción directa en unidad base/);
});
