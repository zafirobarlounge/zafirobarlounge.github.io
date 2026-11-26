const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const panelPath = path.join(root, 'src/admin/PrintJobsPanel.tsx');
const source = readFileSync(panelPath, 'utf8');

function loadIncidentHelper() {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({}),
  });
  return exports.isPendingPrintIncident;
}

test('only unresolved review and failed jobs count as pending print incidents', () => {
  const isPending = loadIncidentHelper();
  assert.equal(isPending({ status: 'review', reviewed_at: null }), true);
  assert.equal(isPending({ status: 'failed', reviewed_at: null }), true);
  assert.equal(isPending({ status: 'review', reviewed_at: '2026-11-22T12:00:00Z' }), false);
  assert.equal(isPending({ status: 'failed', reviewed_at: '2026-11-22T12:00:00Z' }), false);
  assert.equal(isPending({ status: 'printed', reviewed_at: null }), false);
});

test('panel keeps the original snapshot, records the browser cycle, then resolves the original job', () => {
  assert.match(source, /orderNumber:\s*`\$\{job\.ticket_snapshot\.orderNumber\} · REIMPRESIÓN`/);
  assert.match(source, /rpc\('record_pos_preparation_reprint'/);
  assert.match(source, /update\(\{ status: 'printed', printed_at:/);
  assert.match(source, /\.in\('status', \['review', 'failed'\]\)/);
});

test('panel uses a body portal with a constrained and scrollable modal viewport', () => {
  assert.match(source, /createPortal\(<>{panel}\{confirmation}<\/>, document\.body\)/);
  assert.match(source, /max-h-\[85vh\]/);
  assert.match(source, /overflow-y-auto/);
  assert.match(source, /z-\[1000\]/);
  assert.match(source, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(source, /document\.documentElement\.style\.overflow = 'hidden'/);
});
