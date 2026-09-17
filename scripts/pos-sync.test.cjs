const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const repositoryPath = 'src/integrations/supabase/posOperationsRepository.ts';
const posPath = 'src/admin/AdminPosView.tsx';
const settingsPath = 'src/admin/AdminPosSettingsView.tsx';
const parse = (file) => ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('session closing alert uses the next Colombian 6am cutoff and disappears only on closure', () => {
  const file = parse(posPath);
  const helper = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'isSalesSessionPastClosingCutoff');
  assert.ok(helper);
  const check = evaluate(`${helper.getText(file)}; isSalesSessionPastClosingCutoff`, {});
  const session = { openedAt: '2026-09-17T02:00:00Z', closedAt: null, status: 'open' };
  assert.equal(check(session, Date.parse('2026-09-17T10:59:59Z')), false);
  assert.equal(check(session, Date.parse('2026-09-17T11:00:00Z')), true);
  assert.equal(check(session, Date.parse('2026-09-20T18:00:00Z')), true);
  assert.equal(check({ ...session, status: 'closed', closedAt: '2026-09-17T13:00:00Z' }, Date.parse('2026-09-20T18:00:00Z')), false);
  const newSession = { ...session, openedAt: '2026-09-17T13:00:00Z' };
  assert.equal(check(newSession, Date.parse('2026-09-17T18:00:00Z')), false);
  assert.equal(check(newSession, Date.parse('2026-09-18T11:00:00Z')), true);
  assert.equal(check({ ...session, openedAt: 'invalid' }, Date.now()), false);
});

function evaluate(source, context) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return vm.runInNewContext(compiled, context);
}

function loadRepository(client) {
  const context = {
    exports: {},
    require: (name) => {
      assert.equal(name, './client');
      return { getSupabaseClient: () => client };
    },
  };
  evaluate(readFileSync(path.join(root, repositoryPath), 'utf8'), context);
  return context.exports;
}

function mockClient(rows = {}, errors = {}) {
  const queries = [];
  const queryDetails = [];
  const channels = [];
  const removed = [];
  return {
    queries, queryDetails, channels, removed,
    from(table) {
      let data = [...(rows[table] ?? [])];
      const details = { table, orders: [] };
      const query = {
        select() { return query; },
        eq(key, value) { data = data.filter((row) => row[key] === value); return query; },
        in(key, values) { data = data.filter((row) => values.includes(row[key])); return query; },
        order(key, { ascending = true } = {}) {
          details.orders.push({ key, ascending });
          data.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
          return query;
        },
        limit(count) { details.limit = count; data = data.slice(0, count); return query; },
        // Log-loader tests use empty operational order/payment datasets.
        is() { return query; },
        or() { return query; },
        range(from, to) { data = data.slice(from, to + 1); return query; },
        then(resolve, reject) {
          queries.push(table);
          queryDetails.push(details);
          return Promise.resolve({ data, error: errors[table] ?? null }).then(resolve, reject);
        },
      };
      return query;
    },
    channel(name) {
      const channel = {
        name, handlers: [],
        on(type, filter, handler) { channel.handlers.push({ type, filter, handler }); return channel; },
        subscribe(handler) { channel.status = handler; return channel; },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { removed.push(channel); return Promise.resolve('ok'); },
  };
}

function getEffect(file, marker) {
  const source = parse(file);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0].getText(source).includes(marker)) {
      assert.equal(effect, undefined, `Ambiguous effect: ${marker}`);
      effect = node.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect, `Missing effect: ${marker}`);
  return effect;
}

// Execute the actual private helpers/effects without rendering UI or connecting to Supabase.
function loadPosHelpers(context) {
  const source = parse(posPath);
  const helpers = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name.text !== 'AdminPosView');
  evaluate(helpers.map((node) => node.getText(source)).join('\n'), context);
}

function browser() {
  const timeouts = new Map();
  const intervals = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  let nextId = 0;
  return {
    timeouts, intervals, windowListeners, documentListeners,
    window: {
      setTimeout(callback) { const id = ++nextId; timeouts.set(id, callback); return id; },
      clearTimeout(id) { timeouts.delete(id); },
      setInterval(callback, delay) { const id = ++nextId; intervals.set(id, { callback, delay }); return id; },
      clearInterval(id) { intervals.delete(id); },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
      removeEventListener(name, callback) { assert.equal(windowListeners.get(name), callback); windowListeners.delete(name); },
    },
    document: {
      visibilityState: 'visible',
      addEventListener(name, callback) { documentListeners.set(name, callback); },
      removeEventListener(name, callback) { assert.equal(documentListeners.get(name), callback); documentListeners.delete(name); },
    },
    flushTimeouts() {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function posHarness(loader) {
  const env = browser();
  const client = mockClient();
  const repo = loadRepository(client);
  const context = {
    ...env, exports: {}, require,
    actorRef: { current: { email: 'waiter@example.test', roles: [] } },
    workspaceAccessRef: { current: {} },
    posStateRef: { current: null },
    realtimeTimerRef: { current: null },
    trailingSyncTimerRef: { current: null },
    loadStateRef: { current: async () => {} },
    audioContextRef: { current: null },
    recentRealtimeNotificationKeysRef: { current: new Map() },
    suppressed: false,
    shouldSuppressBackgroundSync: () => context.suppressed,
    loadPosStateFromSupabase: loader,
    subscribeToPosRealtime: repo.subscribeToPosRealtime,
    updateTableContextFromRealtime() {},
    invalidateTableContext() {},
    savingLineItemRef: { current: false },
    tableContextRef: { current: null },
    selectedTableIdRef: { current: null },
    setTableContext() {},
    isPosTableContextValid: repo.isPosTableContextValid,
    mapPosRealtimeOrderItem: repo.mapPosRealtimeOrderItem,
    mapPosRealtimeLog: repo.mapPosRealtimeLog,
    stateUpdates: 0,
    setPosState(value) {
      context.stateUpdates++;
      context.posStateRef.current = typeof value === 'function' ? value(context.posStateRef.current) : value;
    },
    setSelectedTableId() {}, setIsLoading() {}, setErrorMessage() {},
  };
  loadPosHelpers(context);
  const cleanup = evaluate(`(${getEffect(posPath, 'const handleRealtimeEvent')})()`, context);
  return { context, env, client, cleanup };
}

const timestamp = '2026-09-15T20:00:00Z';
function fixtures() {
  return {
    pos_tables: [{ id: 't1', code: '01', name: 'Mesa 1', active_order_id: 'open', status: 'occupied', created_at: timestamp, updated_at: timestamp }],
    pos_sales_sessions: Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`, business_date: '2026-09-15', opened_at: timestamp, status: 'closed', summary: {},
    })),
    pos_orders: ['closed', 'open', 'legacy'].map((id) => ({
      id, table_id: 't1', sales_session_id: id === 'legacy' ? null : 's0',
      opened_at: timestamp, updated_at: timestamp, closed_at: id === 'open' ? null : timestamp, financial_status: 'paid_total',
    })),
    pos_order_items: ['closed', 'open', 'legacy'].map((id) => ({
      id: `i-${id}`, order_id: id, product_name: 'Producto', prep_area: 'kitchen',
      operational_status: 'pending_preparation', financial_status: 'pending_payment', quantity: 1,
      total_price: 10000, unit_price: 10000, created_at: timestamp, updated_at: timestamp,
    })),
    pos_payments: ['closed', 'legacy'].map((id) => ({
      id: `p-${id}`, order_id: id, sales_session_id: 's0', amount_applied: 10000, method: 'cash',
      status: 'confirmed', created_at: timestamp, target_item_ids: [],
    })),
    pos_operational_flow_settings: [{ area: 'kitchen', use_direct_delivery: true, use_in_process: false, use_picking_up: true }],
  };
}

test('all POS areas poll every five minutes; hidden and suppressed ticks do not load', () => {
  for (const activeTab of ['floor', 'kitchen', 'bar', 'cashier']) {
    const env = browser();
    let loads = 0;
    let suppressed = false;
    const context = {
      ...env, exports: {}, require, activeTab, workspaceTabs: [activeTab],
      shouldSuppressBackgroundSync: () => suppressed,
      loadStateRef: { current: () => { loads++; } },
    };
    loadPosHelpers(context);
    const cleanup = evaluate(`(${getEffect(posPath, 'const intervalMs')})()`, context);
    assert.equal(env.intervals.size, 1);
    const interval = [...env.intervals.values()][0];
    assert.equal(interval.delay, 300000);
    interval.callback();
    assert.equal(loads, 1);
    env.document.visibilityState = 'hidden';
    interval.callback(); interval.callback();
    assert.equal(loads, 1);
    env.document.visibilityState = 'visible';
    suppressed = true;
    interval.callback();
    assert.equal(loads, 1);
    cleanup();
    assert.equal(env.intervals.size, 0);
  }
});

test('Realtime preserves event handling, observes status and removes channels once', () => {
  const client = mockClient();
  const repo = loadRepository(client);
  const statuses = [];
  let loads = 0;
  let reload = false;
  const events = [];
  const unsubscribe = repo.subscribeToPosRealtime(() => loads++, (event) => { events.push(event); return reload; }, (status) => statuses.push(status));
  const channel = client.channels[0];
  assert.equal(channel.handlers.length, 7);
  const tables = channel.handlers.map(({ filter }) => filter.table);
  assert.equal(new Set(tables).size, 7);
  const handler = channel.handlers.find(({ filter }) => filter.table === 'pos_order_items').handler;
  handler({ eventType: 'UPDATE', new: { id: 'known' }, old: {} });
  assert.equal(loads, 0);
  assert.equal(events[0].table, 'pos_order_items');
  reload = true;
  handler({ eventType: 'INSERT', new: { id: 'unknown' }, old: {} });
  assert.equal(loads, 1);
  for (const status of ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) channel.status(status);
  assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);
  unsubscribe(); unsubscribe();
  assert.deepEqual(client.removed, [channel]);
  handler({ eventType: 'UPDATE', new: {}, old: {} }); channel.status('CLOSED');
  assert.equal(loads, 1);
  assert.equal(statuses.length, 4);
});

test('known items update locally; unknown items reload; visibility/focus coalesce; cleanup blocks late results', async () => {
  const repo = loadRepository(mockClient(fixtures()));
  const state = await repo.loadPosStateFromSupabase({ includeHistoricalRows: true });
  let loads = 0;
  const harness = posHarness(async () => { loads++; return state; });
  await settle();
  assert.equal(loads, 1);
  const handler = harness.client.channels[0].handlers.find(({ filter }) => filter.table === 'pos_order_items').handler;
  handler({ eventType: 'UPDATE', new: { id: 'i-open', operational_status: 'ready', updated_at: timestamp }, old: {} });
  assert.equal(harness.context.posStateRef.current.tables[0].activeOrder.items[0].operationalStatus, 'ready');
  assert.equal(harness.env.timeouts.size, 0);
  handler({ eventType: 'INSERT', new: { id: 'new-item' }, old: {} });
  assert.equal(harness.env.timeouts.size, 1);
  harness.env.flushTimeouts(); await settle();
  assert.equal(loads, 2);
  harness.env.document.visibilityState = 'hidden';
  harness.env.documentListeners.get('visibilitychange')();
  harness.env.windowListeners.get('focus')();
  assert.equal(harness.env.timeouts.size, 0);
  harness.env.document.visibilityState = 'visible';
  harness.env.documentListeners.get('visibilitychange')();
  harness.env.windowListeners.get('focus')();
  assert.equal(harness.env.timeouts.size, 1);
  harness.env.flushTimeouts(); await settle();
  assert.equal(loads, 3);
  harness.context.suppressed = true;
  handler({ eventType: 'INSERT', new: { id: 'new-item' }, old: {} });
  assert.equal(harness.env.timeouts.size, 0);
  harness.context.suppressed = false;
  handler({ eventType: 'INSERT', new: { id: 'new-item' }, old: {} });
  harness.cleanup();
  assert.equal(harness.env.timeouts.size, 0);
  assert.equal(harness.env.windowListeners.size, 0);
  assert.equal(harness.env.documentListeners.size, 0);
  assert.equal(harness.client.removed.length, 1);
  await harness.context.loadStateRef.current();
  assert.equal(loads, 3);
});

test('POS loads serialize and combine pending reloads, including unmount during a request', async () => {
  const requests = [];
  const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
  const pending = harness.context.loadStateRef.current();
  harness.context.loadStateRef.current();
  assert.equal(requests.length, 1);
  requests[0]({ tables: [], openOrders: [], closedSales: [] });
  await settle();
  assert.equal(requests.length, 2);
  const updates = harness.context.stateUpdates;
  harness.cleanup();
  requests[1]({ tables: [], openOrders: [], closedSales: [] });
  await pending;
  assert.equal(harness.context.stateUpdates, updates);
  assert.equal(requests.length, 2);
});

test('a known Realtime update arriving during a snapshot load survives the response without a full reload', async () => {
  const state = await loadRepository(mockClient(fixtures())).loadPosStateFromSupabase({ includeHistoricalRows: true });
  const requests = [];
  const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
  requests[0](state);
  await settle();
  const pending = harness.context.loadStateRef.current();
  const handler = harness.client.channels[0].handlers.find(({ filter }) => filter.table === 'pos_order_items').handler;
  handler({ eventType: 'UPDATE', new: { id: 'i-open', operational_status: 'ready' }, old: {} });
  assert.equal(harness.context.posStateRef.current.tables[0].activeOrder.items[0].operationalStatus, 'ready');
  requests[1](state);
  await pending;
  assert.equal(harness.context.posStateRef.current.tables[0].activeOrder.items[0].operationalStatus, 'ready');
  assert.equal(harness.env.timeouts.size, 0);
  assert.equal(requests.length, 2);
  harness.cleanup();
});

test('settings use only their dedicated table/channel and reuse the existing mapping', async () => {
  const client = mockClient(fixtures());
  const repo = loadRepository(client);
  const settings = await repo.loadPosOperationalFlowSettingsFromSupabase();
  assert.deepEqual(client.queries, ['pos_operational_flow_settings']);
  assert.equal(settings.kitchen.useDirectDelivery, true);
  assert.equal(settings.kitchen.usePickingUp, true);
  assert.equal(settings.bar.useDirectDelivery, false);
  let changes = 0;
  const unsubscribe = repo.subscribeToPosOperationalSettingsRealtime(() => changes++);
  const channel = client.channels[0];
  assert.equal(channel.name, 'zafiro-pos-operational-settings-live');
  assert.deepEqual(plain(channel.handlers.map(({ filter }) => filter)), [{ event: '*', schema: 'public', table: 'pos_operational_flow_settings' }]);
  channel.handlers[0].handler();
  assert.equal(changes, 1);
  unsubscribe(); unsubscribe(); channel.handlers[0].handler();
  assert.equal(changes, 1);
  assert.equal(client.removed.length, 1);
  const env = browser();
  const context = {
    ...env, isCatalogAdmin: true, realtimeTimerRef: { current: null },
    loadPosOperationalFlowSettingsFromSupabase: repo.loadPosOperationalFlowSettingsFromSupabase,
    subscribeToPosOperationalSettingsRealtime: repo.subscribeToPosOperationalSettingsRealtime,
    setErrorMessage() {}, setIsLoading() {}, setOperationalFlowSettings() {},
  };
  client.queries.length = 0;
  const cleanup = evaluate(`(${getEffect(settingsPath, 'const loadState')})()`, context);
  await settle();
  assert.deepEqual(client.queries, ['pos_operational_flow_settings']);
  client.channels[1].handlers[0].handler();
  assert.equal(env.timeouts.size, 1);
  cleanup();
  assert.equal(env.timeouts.size, 0);
  assert.equal(client.removed.length, 2);
});

test('history downloads each dataset once and preserves existing summaries, closed sales and table relations', async () => {
  const rows = fixtures();
  const baselineRepo = loadRepository(mockClient(rows));
  const expectedHistory = await baselineRepo.loadSalesSessionHistoryFromSupabase();
  const expectedState = await baselineRepo.loadPosStateFromSupabase({ includeHistoricalRows: true });
  const client = mockClient(rows);
  const actual = await loadRepository(client).loadSalesSessionHistoryViewFromSupabase();
  assert.deepEqual(plain(actual.history), plain(expectedHistory));
  assert.deepEqual(plain(actual.closedSales), plain(expectedState.closedSales));
  assert.deepEqual(plain(actual.tables), plain(expectedState.tables));
  assert.equal(actual.history.length, 12);
  for (const table of ['pos_orders', 'pos_order_items', 'pos_payments', 'pos_sales_sessions', 'pos_tables']) {
    assert.equal(client.queries.filter((name) => name === table).length, 1, table);
  }
  assert.equal(client.queries.length, 5);
  assert.equal(actual.history[0].orderCount, 2);
  assert.equal(actual.history[0].totalCollected, 20000);
  const source = readFileSync(path.join(root, 'src/admin/AdminSalesSessionsView.tsx'), 'utf8');
  assert.ok(source.includes('await loadSalesSessionHistoryViewFromSupabase()'));
  assert.ok(!source.includes('loadPosStateFromSupabase'));
});

test('history still paginates large datasets without downloading any page twice', async () => {
  const rows = fixtures();
  rows.pos_orders = Array.from({ length: 1001 }, (_, index) => ({ ...rows.pos_orders[0], id: `o${index}` }));
  const client = mockClient(rows);
  const result = await loadRepository(client).loadSalesSessionHistoryViewFromSupabase();
  assert.equal(result.closedSales.length, 1001);
  assert.equal(client.queries.filter((table) => table === 'pos_orders').length, 2);
  assert.equal(client.queries.filter((table) => table === 'pos_order_items').length, 1);
  assert.equal(client.queries.filter((table) => table === 'pos_payments').length, 1);
});

test('cashier historical detail loads only closed orders of the requested session and their items/payments', async () => {
  const client = mockClient(fixtures());
  const result = await loadRepository(client).loadClosedSalesForSessionFromSupabase('s0');
  assert.deepEqual(plain(result.map((order) => order.id)), ['closed']);
  assert.equal(result[0].items.length, 1);
  assert.equal(result[0].payments.length, 1);
  assert.equal(result[0].summary.totalPaid, 10000);
  assert.ok(client.queries.every((table) => ['pos_orders', 'pos_order_items', 'pos_payments'].includes(table)));
  const before = client.queries.length;
  assert.deepEqual(plain(await loadRepository(client).loadClosedSalesForSessionFromSupabase('unknown-session')), []);
  assert.deepEqual(client.queries.slice(before), ['pos_orders']);
  await assert.rejects(loadRepository(mockClient({}, { pos_orders: { message: 'offline' } })).loadClosedSalesForSessionFromSupabase('s0'), /offline/);
});

test('cashier historical detail paginates session orders without a global historical download', async () => {
  const rows = fixtures();
  rows.pos_orders = Array.from({ length: 1001 }, (_, index) => ({ ...rows.pos_orders[0], id: `sale-${index}` }));
  rows.pos_order_items = []; rows.pos_payments = [];
  const client = mockClient(rows);
  const result = await loadRepository(client).loadClosedSalesForSessionFromSupabase('s0');
  assert.equal(result.length, 1001);
  assert.equal(client.queries.filter((table) => table === 'pos_orders').length, 2);
  assert.equal(client.queries.includes('pos_sales_sessions'), false);
});

test('cashier historical detail effect ignores late session responses, reports failures and supports reload', async () => {
  const requests = [];
  const context = {
    Error, activeTab: 'cashier', cashierRightPanel: 'summary', selectedHistoricalSession: { id: 'a' },
    setHistoricalSessionDetail(value) { context.detail = value; },
    loadClosedSalesForSessionFromSupabase(id) { return new Promise((resolve, reject) => requests.push({ id, resolve, reject })); },
  };
  const mount = () => evaluate(`(${getEffect(posPath, 'const historicalSessionId')})()`, context);
  mount(); assert.equal(requests.length, 0);
  context.cashierRightPanel = 'previous_sessions';
  const cleanupA = mount();
  assert.equal(context.detail.loading, true);
  cleanupA(); context.selectedHistoricalSession = { id: 'b' };
  const cleanupB = mount();
  requests[1].resolve(['sale-b']); await settle();
  requests[0].resolve(['sale-a']); await settle();
  assert.equal(context.detail.sessionId, 'b');
  assert.deepEqual(plain(context.detail.orders), ['sale-b']);
  cleanupB();
  const cleanupFailure = mount();
  requests[2].reject(new Error('offline')); await settle();
  assert.equal(context.detail.error, 'offline');
  assert.equal(context.detail.loading, false);
  cleanupFailure();
  const cleanupRetry = mount();
  assert.equal(context.detail.error, null);
  requests[3].resolve([]); await settle();
  assert.equal(context.detail.loading, false);
  assert.equal(context.detail.error, null);
  cleanupRetry();
});

test('read loaders propagate errors instead of returning incomplete settings/history', async () => {
  const settingsRepo = loadRepository(mockClient({}, { pos_operational_flow_settings: { message: 'offline' } }));
  await assert.rejects(settingsRepo.loadPosOperationalFlowSettingsFromSupabase(), /offline/);
  const historyRepo = loadRepository(mockClient({}, { pos_orders: { message: 'offline' } }));
  await assert.rejects(historyRepo.loadSalesSessionHistoryViewFromSupabase(), /offline/);
});

test('settings serialize overlapping refreshes and ignore results after unmount', async () => {
  const env = browser();
  const client = mockClient();
  const requests = [];
  let updates = 0;
  const context = {
    ...env, isCatalogAdmin: true, realtimeTimerRef: { current: null },
    loadPosOperationalFlowSettingsFromSupabase: () => new Promise((resolve) => requests.push(resolve)),
    subscribeToPosOperationalSettingsRealtime: loadRepository(client).subscribeToPosOperationalSettingsRealtime,
    setErrorMessage() {}, setIsLoading() {}, setOperationalFlowSettings() { updates++; },
  };
  const cleanup = evaluate(`(${getEffect(settingsPath, 'const loadState')})()`, context);
  client.channels[0].handlers[0].handler();
  env.flushTimeouts();
  client.channels[0].handlers[0].handler();
  env.flushTimeouts();
  assert.equal(requests.length, 1);
  requests[0]({});
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(updates, 1);
  cleanup();
  requests[1]({});
  await settle();
  assert.equal(updates, 1);
  assert.equal(requests.length, 2);
});

test('history ignores older responses and responses after unmount', async () => {
  const source = parse('src/admin/AdminSalesSessionsView.tsx');
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'loadSessions') initializer = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  const requests = [];
  const context = {
    isMountedRef: { current: true }, loadRequestIdRef: { current: 0 },
    loadSalesSessionHistoryViewFromSupabase: () => new Promise((resolve) => requests.push(resolve)),
    sessions: null, setSessions(value) { context.sessions = value; },
    setErrorMessage() {}, setIsLoading() {}, setClosedSales() {}, setTables() {}, setExpandedSessionId() {},
  };
  const load = evaluate(`(${initializer})`, context);
  const older = load();
  const newer = load();
  requests[1]({ history: ['new'], closedSales: [], tables: [] });
  await newer;
  requests[0]({ history: ['old'], closedSales: [], tables: [] });
  await older;
  assert.deepEqual(context.sessions, ['new']);
  const last = load();
  context.isMountedRef.current = false;
  requests[2]({ history: ['late'], closedSales: [], tables: [] });
  await last;
  assert.deepEqual(context.sessions, ['new']);
});

function completeItem(overrides = {}) {
  return {
    ...fixtures().pos_order_items[1], id: 'incoming', product_slug: 'producto', service_round: 1,
    menu_item_source_key: null, notes: 'Persisted notes', replacement_for_item_id: null,
    created_by_email: 'other@example.test', updated_by_email: 'other@example.test',
    sent_at: null, preparation_started_at: null, ready_at: null, picking_up_at: null,
    picking_up_by_email: null, delivered_at: null, delivered_by_email: null,
    cancelled_at: null, cancelled_by_email: null, cancellation_reason: null,
    operational_status: 'draft', quantity: 2, unit_price: 12345, total_price: 19000,
    ...overrides,
  };
}

function completeLog(overrides = {}) {
  return {
    id: 'log-new', event_type: 'items_added', actor_email: 'other@example.test', actor_role: 'waiter',
    created_at: timestamp, order_id: 'open', order_item_id: null, table_id: 't1', notes: 'Added',
    before_data: null, after_data: [completeItem()], ...overrides,
  };
}

function contextMutationClient(rows, logResult = () => Promise.resolve({ data: null, error: null })) {
  const requests = [];
  return {
    requests,
    from(table) {
      const request = { table, action: 'read', filters: [] };
      let values;
      let one = false;
      const query = {
        select() { return query; },
        eq(key, value) { request.filters.push([key, value]); return query; },
        in(key, values) { request.filters.push([key, values]); return query; },
        order() { return query; },
        range() { return query; },
        limit() { return query; },
        single() { one = true; return query; },
        maybeSingle() { one = true; return query; },
        update(patch) { request.action = 'update'; values = patch; return query; },
        insert(patch) { request.action = 'insert'; values = patch; return query; },
        then(resolve, reject) {
          requests.push(request);
          if (table === 'pos_order_status_logs') {
            (rows[table] ??= []).push(values);
            return logResult().then(resolve, reject);
          }
          let selected = (rows[table] ?? []).filter((row) => request.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
          if (request.action === 'update') {
            selected.forEach((row) => Object.assign(row, values, { updated_at: new Date().toISOString() }));
          } else if (request.action === 'insert') {
            const row = { id: `new-${requests.length}`, created_at: timestamp, updated_at: timestamp, ...values };
            (rows[table] ??= []).push(row);
            selected = [row];
          }
          return Promise.resolve({ data: one ? selected[0] ?? null : selected.map((row) => ({ ...row })), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function tableContextRows(empty = false) {
  const rows = fixtures();
  rows.pos_sales_sessions[0].status = 'open';
  rows.pos_order_items[1] = completeItem({ id: 'i-open', order_id: 'open', total_price: 24690 });
  if (empty) {
    rows.pos_tables[0].active_order_id = null;
    rows.pos_tables[0].status = 'available';
  }
  return rows;
}

const contextActor = { email: 'waiter@example.test', roles: ['waiter'] };
const contextPayload = {
  productName: 'Producto', productSlug: 'producto', productType: 'comida',
  menuItemSourceKey: null, notes: 'Persisted notes', quantity: 1, unitPrice: 12345,
};

test('operational cancellation removes exactly one unit from draft/sent/pending lines and preserves history', async () => {
  for (const status of ['draft', 'sent', 'pending_preparation']) {
    for (const quantity of [1, 2, 4]) {
      const row = completeItem({ id: 'cancel-target', order_id: 'open', quantity, unit_price: 8000, total_price: quantity * 8000, operational_status: status });
      const rows = { pos_order_items: [row] };
      const client = contextMutationClient(rows);
      const repo = loadRepository(client);
      const source = parse(repositoryPath);
      const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'cancelOrderItemInSupabase');
      const logs = [];
      const reconciled = [];
      const context = {
        exports: {}, CONTROLLED_CANCEL_STATUSES: new Set(['draft', 'sent', 'pending_preparation']),
        getSupabaseClient: () => client,
        getOrderItemById: async () => repo.mapPosRealtimeOrderItem({ ...row }),
        mapPosOrderItemRow: repo.mapPosRealtimeOrderItem,
        throwIfError(error) { if (error) throw new Error(error.message); },
        reconcileOrderState: async (id) => { reconciled.push(id); },
        insertPosLog: async (input) => { logs.push(input); },
      };
      evaluate(declaration.getText(source), context);
      const staleItem = repo.mapPosRealtimeOrderItem({ ...row, quantity: 99 });
      const result = await context.exports.cancelOrderItemInSupabase(row.id, 'One unit only', contextActor, staleItem);
      assert.equal(reconciled.length, 1);
      assert.equal(logs[0].eventType, 'item_cancelled');
      const cancelled = result.find((item) => item.operationalStatus === 'cancelled');
      assert.equal(cancelled.quantity, 1);
      assert.equal(cancelled.totalPrice, 8000);
      assert.equal(cancelled.financialStatus, 'cancelled');
      assert.equal(cancelled.serviceRound, 1);
      if (quantity > 1) {
        const active = result.find((item) => item.id === 'cancel-target');
        assert.equal(active.quantity, quantity - 1);
        assert.equal(active.totalPrice, (quantity - 1) * 8000);
        assert.equal(active.operationalStatus, status);
        assert.equal(active.notes, 'Persisted notes');
        assert.equal(rows.pos_order_items.length, 2);
      } else {
        assert.equal(result.length, 1);
        assert.equal(rows.pos_order_items.length, 1);
      }
    }
  }
});

test('entering empty/existing tables loads only read context, no payments, and reopening refreshes it', async () => {
  for (const empty of [true, false]) {
    const rows = tableContextRows(empty);
    const client = contextMutationClient(rows);
    const repo = loadRepository(client);
    const context = await repo.loadPosTableContextFromSupabase('t1');
    assert.equal(context.order === null, empty);
    assert.equal(context.items.length, empty ? 0 : 1);
    assert.equal(context.salesSession.id, 's0');
    assert.ok(client.requests.every((request) => request.action === 'read'));
    assert.equal(client.requests.some((request) => request.table === 'pos_payments'), false);
    rows.pos_tables[0].name = 'Updated table';
    assert.equal((await repo.loadPosTableContextFromSupabase('t1')).table.name, 'Updated table');
  }
});

test('first product opens an account; second/compatible/different products reuse context without reads', async () => {
  const rows = tableContextRows(true);
  const client = contextMutationClient(rows);
  const repo = loadRepository(client);
  const context = await repo.loadPosTableContextFromSupabase('t1');
  for (const [index, patch] of [{}, {}, { productSlug: 'other' }, { notes: 'Other notes' }].entries()) {
    const before = client.requests.length;
    const added = await repo.addItemsToTableInSupabase('t1', [{ ...contextPayload, ...patch }], contextActor, context);
    assert.equal(client.requests.slice(before).some((request) => request.action === 'read'), false);
    assert.equal(added[0].operationalStatus, 'draft');
    assert.equal(added[0].unitPrice, 12345);
    assert.equal(added[0].quantity, index === 1 ? 2 : 1);
    assert.equal(added[0].serviceRound, index < 2 ? 1 : index);
    assert.equal(context.table.activeOrderId, context.order.id);
    assert.equal(context.table.status, 'occupied');
  }
  assert.equal(context.items.length, 3);
  assert.equal(rows.pos_order_status_logs.filter((log) => log.event_type === 'order_opened').length, 1);
  assert.equal(rows.pos_order_status_logs.filter((log) => log.event_type === 'items_added').length, 4);
});

test('pending or failed logs do not block the confirmed account/product result', async () => {
  for (const logResult of [() => new Promise(() => {}), () => Promise.resolve({ error: { message: 'offline' } })]) {
    const rows = tableContextRows(true);
    const client = contextMutationClient(rows, logResult);
    const repo = loadRepository(client);
    const context = await repo.loadPosTableContextFromSupabase('t1');
    const result = await repo.addItemsToTableInSupabase('t1', [contextPayload], contextActor, context);
    assert.equal(result.length, 1);
    assert.equal(rows.pos_tables[0].active_order_id, result[0].orderId);
    await settle();
  }
});

test('Realtime merges complete items and invalidates changed/deleted/incomplete account context', async () => {
  const rows = tableContextRows();
  const repo = loadRepository(contextMutationClient(rows));
  const context = await repo.loadPosTableContextFromSupabase('t1');
  const event = { table: 'pos_order_items', eventType: 'INSERT', newRecord: completeItem({ id: 'remote', order_id: 'open', service_round: 8 }), oldRecord: null };
  const merged = repo.applyRealtimeEventToTableContext(context, event);
  assert.equal(merged.items.length, 2);
  assert.equal(repo.applyRealtimeEventToTableContext(merged, event).items.length, 2);
  const updated = repo.applyRealtimeEventToTableContext(merged, { ...event, eventType: 'UPDATE', newRecord: { ...event.newRecord, quantity: 4 } });
  assert.equal(updated.items.find((item) => item.id === 'remote').quantity, 4);
  assert.equal(repo.applyRealtimeEventToTableContext(context, { ...event, newRecord: { id: 'i-open', order_id: 'open' } }), null);
  assert.equal(repo.applyRealtimeEventToTableContext(context, { ...event, eventType: 'DELETE', newRecord: null, oldRecord: event.newRecord }), null);
  assert.equal(repo.applyRealtimeEventToTableContext(context, { table: 'pos_tables', eventType: 'UPDATE', newRecord: { ...rows.pos_tables[0], active_order_id: null }, oldRecord: null }), null);
  assert.equal(repo.applyRealtimeEventToTableContext(context, { table: 'pos_sales_sessions', eventType: 'UPDATE', newRecord: { id: 's0' }, oldRecord: null }), null);
});

test('invalid context falls back safely and stale draft quantity cannot overwrite a remote edit', async () => {
  const rows = tableContextRows();
  const client = contextMutationClient(rows);
  const repo = loadRepository(client);
  const context = await repo.loadPosTableContextFromSupabase('t1');
  rows.pos_order_items[1].quantity = 5;
  await assert.rejects(repo.addItemsToTableInSupabase('t1', [contextPayload], contextActor, context), /otro dispositivo/);
  assert.equal(rows.pos_order_items[1].quantity, 5);
  const refreshed = await repo.loadPosTableContextFromSupabase('t1');
  assert.equal((await repo.addItemsToTableInSupabase('t1', [contextPayload], contextActor, refreshed))[0].quantity, 6);
  const invalid = { ...refreshed, table: { ...refreshed.table, id: 'wrong' } };
  const before = client.requests.length;
  await repo.addItemsToTableInSupabase('t1', [contextPayload], contextActor, invalid);
  assert.ok(client.requests.slice(before).some((request) => request.table === 'pos_tables' && request.action === 'read'));
});

function componentCallback(name) {
  const source = parse(posPath);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) callback = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `Missing callback: ${name}`);
  return callback;
}

test('cashier previous sessions show at most seven closed records, preserving newest-first order', () => {
  const sessions = [{ id: 'active', status: 'open' }, ...Array.from({ length: 10 }, (_, index) => ({ id: `closed-${index}`, status: 'closed' }))];
  const result = evaluate(componentCallback('previousClosedSessions'), {
    posState: { recentSalesSessions: sessions }, useMemo: (callback) => callback(),
  });
  assert.deepEqual(plain(result.map((session) => session.id)), Array.from({ length: 7 }, (_, index) => `closed-${index}`));
});

test('create-table Cancel clears only code/name; empty form uses selected-table deletion', async () => {
  for (const fields of [{ code: 'M-9', name: '' }, { code: '', name: 'Mesa 9' }, { code: 'M-9', name: 'Mesa 9' }, { code: '', name: '' }]) {
    let deleted = 0;
    const form = { ...fields, capacity: 8, zone: 'terrace', notes: 'Keep notes' };
    const context = {
      busyAction: null, hasCreateTableText: Boolean(form.code || form.name),
      setCreateTableForm(update) { context.form = update(form); },
      handleDeleteSelectedTable: async () => { deleted++; },
    };
    const action = evaluate(`(${componentCallback('handleCancelOrDeleteTable')})`, context);
    await action();
    if (context.hasCreateTableText) {
      assert.equal(deleted, 0);
      assert.deepEqual(plain(context.form), { ...form, code: '', name: '' });
    } else {
      assert.equal(deleted, 1);
    }
    context.busyAction = 'Creating';
    await action();
    assert.equal(deleted, context.hasCreateTableText ? 0 : 1);
  }
});

test('upper POS notifications expire after five seconds for success and eight for errors; cleanup cancels old timer', () => {
  for (const error of [false, true]) {
    let callback;
    let delay;
    let cancelled = false;
    const context = {
      actionMessage: error ? null : 'Producto agregado', errorMessage: error ? 'No fue posible guardar' : null,
      setActionMessage(value) { context.actionMessage = value; },
      setErrorMessage(value) { context.errorMessage = value; },
      window: {
        setTimeout(fn, ms) { callback = fn; delay = ms; return 1; },
        clearTimeout(id) { assert.equal(id, 1); cancelled = true; },
      },
    };
    const cleanup = evaluate(`(${getEffect(posPath, 'const hasNotification')})()`, context);
    assert.equal(delay, error ? 8000 : 5000);
    callback();
    assert.equal(context.actionMessage, null);
    assert.equal(context.errorMessage, null);
    cleanup();
    assert.equal(cancelled, true);
  }
});

test('table context effect blocks while loading and ignores responses after closing/reopening or unmount', async () => {
  const requests = [];
  const rows = tableContextRows();
  const repo = loadRepository(contextMutationClient(rows));
  const loaded = await repo.loadPosTableContextFromSupabase('t1');
  const context = {
    selectedTable: { id: 't1' }, activeTab: 'floor',
    selectedTableId: 't1', selectedTableIdRef: { current: 't1' }, isPosTableContextValid: repo.isPosTableContextValid,
    tableContextRequestRef: { current: 0 }, tableContextRef: { current: loaded },
    savingLineItemRef: { current: false },
    setTableContext(value) { context.current = value; }, setErrorMessage() {},
    loadPosTableContextFromSupabase() { return new Promise((resolve) => requests.push(resolve)); },
  };
  const mount = () => evaluate(`(${getEffect(posPath, 'const requestId = ++tableContextRequestRef.current')})()`, context);
  const close = mount();
  assert.equal(context.current, null);
  assert.equal(context.tableContextRef.current, null);
  close();
  const unmount = mount();
  requests[0](loaded); await settle();
  assert.equal(context.current, null);
  requests[1](loaded); await settle();
  assert.equal(context.current, loaded);
  unmount();
  const lateUnmount = mount();
  lateUnmount();
  requests[2](loaded); await settle();
  assert.equal(context.current, null);
});

test('actual add handler blocks duplicate clicks and releases the guard after primary save, not trailing sync', async () => {
  const repo = loadRepository(contextMutationClient(tableContextRows()));
  const loaded = await repo.loadPosTableContextFromSupabase('t1');
  let confirm;
  let calls = 0;
  const context = {
    selectedTable: { id: 't1', code: '01' }, actor: contextActor,
    selectedTableIdRef: { current: 't1' },
    tableContextRef: { current: loaded }, savingLineItemRef: { current: false },
    tableContextEventsRef: { current: [] }, isPosTableContextValid: repo.isPosTableContextValid,
    isLineQuantityValid: true, parsedLineQuantity: 1, addItemMode: 'menu', replaceTargetItemId: null,
    selectedProduct: { sourceKey: null, name: 'Producto', slug: 'producto', type: 'comida', price: 12345 },
    lineNotes: 'Persisted notes', pendingOrderItemFocusRef: { current: null },
    setIsSavingLineItem(value) { context.saving = value; }, setTableContext() {},
    setErrorMessage() {}, setPosState() {}, setLineNotes() {}, setLineQuantity() {},
    updateTableContextFromRealtime() {}, invalidateTableContext() { context.invalidations = (context.invalidations ?? 0) + 1; },
    addItemsToTableInSupabase() { calls++; return new Promise((resolve) => { confirm = resolve; }); },
    async executeAction(label, action, options) { const result = await action(); options.onSuccess(result); },
  };
  const add = evaluate(`(${componentCallback('handleAddOrReplaceItem')})`, context);
  const pending = add();
  assert.equal(context.saving, true);
  await add();
  assert.equal(calls, 1);
  confirm([loaded.items[0]]);
  await pending;
  assert.equal(context.saving, false);
  assert.equal(context.savingLineItemRef.current, false);
  context.tableContextRef.current = null;
  await add();
  assert.equal(calls, 1, 'no save without a loaded context');
  context.tableContextRef.current = loaded;
  context.selectedTableIdRef.current = 't2';
  await add();
  assert.equal(calls, 1, 'a stale handler cannot save after selection has changed');
  context.selectedTableIdRef.current = 't1';
  context.tableContextRef.current = { ...loaded, tableId: 't2' };
  await add();
  assert.equal(calls, 1, 'context.tableId must match the actual selected ID');
  assert.equal(context.invalidations, 3, 'missing/mismatched context requests reload');
});

test('selection changes synchronously clear context before the next React effect', () => {
  const context = {
    selectedTableIdRef: { current: 't1' }, tableContextRef: { current: { tableId: 't1' } },
    invalidateTableContext() { context.tableContextRef.current = null; context.invalidated = true; },
    setSelectedTableIdState(value) { context.selected = value; },
  };
  const select = evaluate(`(${componentCallback('setSelectedTableId')})`, context);
  select('t2');
  assert.equal(context.selectedTableIdRef.current, 't2');
  assert.equal(context.tableContextRef.current, null);
  assert.equal(context.invalidated, true);
  assert.equal(context.selected, 't2');
  select((current) => current === 't2' ? null : current);
  assert.equal(context.selectedTableIdRef.current, null);
});

test('F5 waits for explicit selection; rapid A-to-B switch discards A even before effect cleanup', async () => {
  const repo = loadRepository(contextMutationClient(tableContextRows()));
  const a = await repo.loadPosTableContextFromSupabase('t1');
  const b = { ...a, tableId: 't2', table: { ...a.table, id: 't2' }, order: { ...a.order, tableId: 't2' } };
  const requests = [];
  const context = {
    selectedTable: { id: 't1' }, selectedTableId: null, selectedTableIdRef: { current: null }, activeTab: 'floor',
    tableContextRequestRef: { current: 0 }, tableContextRef: { current: null }, savingLineItemRef: { current: false },
    isPosTableContextValid: repo.isPosTableContextValid,
    setTableContext(value) { context.current = value; }, setErrorMessage() {},
    loadPosTableContextFromSupabase(id) { return new Promise((resolve) => requests.push({ id, resolve })); },
  };
  const mount = () => evaluate(`(${getEffect(posPath, 'const requestId = ++tableContextRequestRef.current')})()`, context);
  mount();
  assert.equal(requests.length, 0);
  context.selectedTableId = 't1'; context.selectedTableIdRef.current = 't1';
  const cleanupA = mount();
  assert.equal(context.current, null, 'automatic selection is not a ready context');
  context.selectedTableId = 't2'; context.selectedTableIdRef.current = 't2';
  requests[0].resolve(a); await settle();
  assert.equal(context.current, null, 'late A cannot be accepted while B is selected');
  cleanupA();
  context.selectedTable = { id: 't2' };
  const cleanupB = mount();
  assert.equal(requests[1].id, 't2');
  requests[1].resolve(b); await settle();
  assert.equal(context.current.tableId, 't2');
  cleanupB();
});

test('released table after last draft removal invalidates old context and loads an empty account safely', async () => {
  const rows = tableContextRows();
  const repo = loadRepository(contextMutationClient(rows));
  const original = await repo.loadPosTableContextFromSupabase('t1');
  rows.pos_tables[0].active_order_id = null;
  rows.pos_tables[0].status = 'available';
  rows.pos_orders[1].closed_at = timestamp;
  rows.pos_order_items = rows.pos_order_items.filter((item) => item.order_id !== 'open');
  assert.equal(repo.applyRealtimeEventToTableContext(original, {
    table: 'pos_tables', eventType: 'UPDATE', newRecord: rows.pos_tables[0], oldRecord: null,
  }), null);
  const fresh = await repo.loadPosTableContextFromSupabase('t1');
  assert.equal(fresh.order, null);
  assert.equal(fresh.items.length, 0);
  const result = await repo.addItemsToTableInSupabase('t1', [contextPayload], contextActor, fresh);
  assert.notEqual(result[0].orderId, original.order.id);
  assert.equal(result[0].serviceRound, 1);
});

function emitRealtime(harness, table, eventType, record) {
  harness.client.channels[0].handlers.find(({ filter }) => filter.table === table)
    .handler({ eventType, new: record, old: {} });
}

async function syncState(rows = fixtures()) {
  return loadRepository(mockClient(rows)).loadPosStateFromSupabase({ includeHistoricalRows: true });
}

test('complete item INSERT into an existing account preserves snapshots, recalculates balance and does not reload or duplicate', async () => {
  const rows = fixtures();
  rows.pos_payments.push({ ...rows.pos_payments[0], id: 'p-open', order_id: 'open', amount_applied: 5000 });
  const state = await syncState(rows);
  let loads = 0;
  const harness = posHarness(async () => { loads++; return state; });
  await settle();
  const record = completeItem();
  const event = { table: 'pos_order_items', eventType: 'INSERT', newRecord: record, oldRecord: {} };
  assert.equal(harness.context.shouldReloadAfterRealtimeEvent(event, state), false);
  emitRealtime(harness, event.table, event.eventType, record);
  emitRealtime(harness, event.table, event.eventType, record);
  const current = harness.context.posStateRef.current;
  const order = current.openOrders.find((entry) => entry.id === 'open');
  const item = order.items.find((entry) => entry.id === record.id);
  assert.equal(order.items.filter((entry) => entry.id === record.id).length, 1);
  assert.equal(item.quantity, 2);
  assert.equal(item.unitPrice, 12345);
  assert.equal(item.totalPrice, 19000);
  assert.equal(item.notes, record.notes);
  assert.equal(item.createdAt, record.created_at);
  assert.equal(order.summary.totalDue, 29000);
  assert.equal(order.summary.totalPaid, 5000);
  assert.equal(order.summary.remainingBalance, 24000);
  assert.equal(current.tables[0].activeOrder.summary.remainingBalance, 24000);
  assert.equal(current.openOrders.reduce((sum, entry) => sum + entry.summary.remainingBalance, 0), 24000);
  assert.equal(current.pendingPreparationKitchen.some((entry) => entry.id === record.id), false);
  assert.equal(current.pendingPreparationBar.some((entry) => entry.id === record.id), false);
  assert.equal(harness.env.timeouts.size, 0);
  assert.equal(loads, 1);
  harness.cleanup();
});

test('draft INSERT remains hidden; known preparation UPDATE keeps the existing area filter and no reload', async () => {
  for (const prepArea of ['kitchen', 'bar']) {
    const state = await syncState();
    const harness = posHarness(async () => state);
    await settle();
    const record = completeItem({ prep_area: prepArea });
    emitRealtime(harness, 'pos_order_items', 'INSERT', record);
    emitRealtime(harness, 'pos_order_items', 'UPDATE', { ...record, operational_status: 'pending_preparation', sent_at: timestamp });
    const current = harness.context.posStateRef.current;
    const queue = prepArea === 'kitchen' ? current.pendingPreparationKitchen : current.pendingPreparationBar;
    const other = prepArea === 'kitchen' ? current.pendingPreparationBar : current.pendingPreparationKitchen;
    assert.equal(queue.filter((item) => item.id === record.id).length, 1);
    assert.equal(other.some((item) => item.id === record.id), false);
    assert.equal(current.openOrders[0].summary.totalDue, 29000);
    assert.equal(harness.env.timeouts.size, 0);
    emitRealtime(harness, 'pos_order_items', 'INSERT', record);
    assert.equal(harness.context.posStateRef.current.openOrders[0].items.find((item) => item.id === record.id).operationalStatus, 'pending_preparation');
    harness.cleanup();
  }
});

test('missing account, missing table relation and incomplete/invalid INSERT payloads retain full reconciliation', async () => {
  const state = await syncState();
  const harness = posHarness(async () => state);
  await settle();
  const malformed = [
    completeItem({ order_id: 'unknown' }), completeItem({ total_price: undefined }),
    completeItem({ unit_price: NaN }), completeItem({ quantity: 0 }),
    completeItem({ sent_at: undefined }), completeItem({ prep_area: 'unknown' }),
    completeItem({ operational_status: 'unknown' }), completeItem({ created_at: 'invalid' }),
  ];
  for (const record of malformed) {
    const event = { table: 'pos_order_items', eventType: 'INSERT', newRecord: record };
    assert.equal(harness.context.shouldReloadAfterRealtimeEvent(event, state), true);
    assert.equal(harness.context.applyRealtimeEventToPosState(state, event), state);
  }
  const event = { table: 'pos_order_items', eventType: 'INSERT', newRecord: completeItem() };
  assert.equal(harness.context.shouldReloadAfterRealtimeEvent(event, { ...state, tables: [] }), true);
  assert.equal(harness.context.shouldReloadAfterRealtimeEvent({ table: 'pos_orders', eventType: 'INSERT', newRecord: { id: 'unknown' } }, state), true);
  harness.cleanup();
});

test('new account reconciliation replays complete INSERT/UPDATE events and cancels the covered second pass', async () => {
  const before = await syncState();
  const after = await syncState();
  const orderRow = { ...fixtures().pos_orders[1], id: 'new-order' };
  const newOrder = { ...after.openOrders[0], id: orderRow.id, items: [], payments: [] };
  after.openOrders.push(newOrder);
  after.tables[0] = { ...after.tables[0], activeOrderId: newOrder.id, activeOrder: newOrder };
  const requests = [];
  const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
  requests[0](before); await settle();
  emitRealtime(harness, 'pos_orders', 'INSERT', orderRow);
  harness.env.flushTimeouts();
  const record = completeItem({ order_id: newOrder.id });
  emitRealtime(harness, 'pos_order_items', 'INSERT', record);
  harness.env.flushTimeouts();
  emitRealtime(harness, 'pos_order_items', 'UPDATE', { ...record, operational_status: 'pending_preparation', sent_at: timestamp });
  harness.env.flushTimeouts();
  assert.equal(requests.length, 2);
  requests[1](after); await settle();
  assert.equal(requests.length, 2);
  const current = harness.context.posStateRef.current;
  const item = current.openOrders.find((order) => order.id === newOrder.id).items[0];
  assert.equal(item.operationalStatus, 'pending_preparation');
  assert.equal(item.totalPrice, 19000);
  assert.equal(current.pendingPreparationKitchen.some((entry) => entry.id === item.id), true);
  harness.cleanup();
});

test('an unknown item UPDATE covered by the snapshot cancels its pending retry', async () => {
  const before = await syncState();
  const record = completeItem();
  const rows = fixtures(); rows.pos_order_items.push(record);
  const after = await syncState(rows);
  const requests = [];
  const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
  requests[0](before); await settle();
  const pending = harness.context.loadStateRef.current(false, 'manual-test');
  emitRealtime(harness, 'pos_order_items', 'UPDATE', { ...record, operational_status: 'ready', ready_at: timestamp });
  harness.env.flushTimeouts();
  requests[1](after); await pending;
  assert.equal(requests.length, 2);
  assert.equal(harness.context.posStateRef.current.openOrders[0].items.find((item) => item.id === record.id).operationalStatus, 'ready');
  harness.cleanup();
});

test('unresolved INSERT events retain pending-reload even when the last debounced event is covered', async () => {
  const state = await syncState();
  const rows = fixtures(); rows.pos_order_items.push(completeItem({ id: 'covered-later' }));
  const snapshot = await syncState(rows);
  const requests = [];
  const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
  requests[0](state); await settle();
  const pending = harness.context.loadStateRef.current(false, 'manual-test');
  emitRealtime(harness, 'pos_order_items', 'INSERT', completeItem({ order_id: 'missing' }));
  emitRealtime(harness, 'pos_order_items', 'UPDATE', completeItem({ id: 'covered-later' }));
  harness.env.flushTimeouts();
  requests[1](snapshot); await settle();
  assert.equal(requests.length, 3);
  requests[2](state); await pending;
  harness.cleanup();
});

test('local INSERT preserves unrelated detached orders, payments and preparation entries', async () => {
  const state = await syncState();
  const detachedItem = { ...state.openOrders[0].items[0], id: 'detached-item', orderId: 'detached' };
  const detachedOrder = { ...state.openOrders[0], id: 'detached', tableId: null, items: [detachedItem] };
  state.openOrders.push(detachedOrder);
  state.pendingPreparationKitchen.push(detachedItem);
  const payment = { id: 'detached-payment', orderId: 'detached', status: 'pending' };
  state.pendingPayments.push(payment);
  const harness = posHarness(async () => state);
  await settle();
  emitRealtime(harness, 'pos_order_items', 'INSERT', completeItem());
  const current = harness.context.posStateRef.current;
  assert.equal(current.openOrders.find((order) => order.id === detachedOrder.id), detachedOrder);
  assert.equal(current.pendingPreparationKitchen.find((item) => item.id === detachedItem.id), detachedItem);
  assert.equal(current.pendingPayments.find((entry) => entry.id === payment.id), payment);
  assert.equal(current.closedSales, state.closedSales);
  harness.cleanup();
});

test('non-Realtime requests and DELETE during a load keep the existing pending fallback', async () => {
  for (const reason of ['focus', 'visibility', 'polling:floor', 'trailing-sync', 'delete']) {
    const state = await syncState();
    const requests = [];
    const harness = posHarness(() => new Promise((resolve) => requests.push(resolve)));
    requests[0](state); await settle();
    const pending = harness.context.loadStateRef.current(false, 'manual-test');
    if (reason === 'delete') {
      emitRealtime(harness, 'pos_order_items', 'UPDATE', completeItem({ id: 'not-in-snapshot' }));
      harness.env.flushTimeouts();
      emitRealtime(harness, 'pos_order_items', 'DELETE', {});
    } else {
      harness.context.loadStateRef.current(false, reason);
    }
    requests[1](state); await settle();
    assert.equal(requests.length, 3, reason);
    requests[2](state); await pending;
    harness.cleanup();
  }
});

test('log INSERT uses the existing mapper, sorts descending, caps at 15 and never duplicates or reloads', async () => {
  const state = await syncState();
  const repo = loadRepository(mockClient());
  state.logs = Array.from({ length: 15 }, (_, index) => repo.mapPosRealtimeLog(completeLog({
    id: `old-${index}`, created_at: new Date(Date.parse(timestamp) - (index + 1) * 1000).toISOString(),
  })));
  const harness = posHarness(async () => state);
  await settle();
  const row = completeLog();
  emitRealtime(harness, 'pos_order_status_logs', 'INSERT', row);
  emitRealtime(harness, 'pos_order_status_logs', 'INSERT', row);
  const logs = harness.context.posStateRef.current.logs;
  assert.equal(logs.length, 15);
  assert.deepEqual(plain(logs.map((entry) => entry.id)), [row.id, ...Array.from({ length: 14 }, (_, index) => `old-${index}`)]);
  assert.equal(logs[0].id, row.id);
  assert.equal(logs.filter((entry) => entry.id === row.id).length, 1);
  assert.deepEqual(plain(logs[0]), plain(repo.mapPosRealtimeLog(row)));
  assert.ok(logs.every((entry, index) => index === 0 || logs[index - 1].createdAt >= entry.createdAt));
  assert.equal(harness.env.timeouts.size, 0);
  emitRealtime(harness, 'pos_order_status_logs', 'INSERT', completeLog({ id: 'too-old', created_at: '2000-01-01T00:00:00Z' }));
  assert.deepEqual(plain(harness.context.posStateRef.current.logs), plain(logs));
  harness.cleanup();
});

test('operational loader requests the latest 15 logs while historical loaders retain their existing behavior', async () => {
  const rows = fixtures();
  rows.pos_orders = [];
  rows.pos_order_items = [];
  rows.pos_payments = [];
  rows.pos_order_status_logs = Array.from({ length: 30 }, (_, index) => completeLog({
    id: `log-${index}`, created_at: new Date(Date.parse(timestamp) - index * 1000).toISOString(),
  })).reverse();
  const client = mockClient(rows);
  const repo = loadRepository(client);
  const operational = await repo.loadPosStateFromSupabase();
  assert.equal(operational.logs.length, 15);
  assert.deepEqual(plain(operational.logs.map((log) => log.id)), Array.from({ length: 15 }, (_, index) => `log-${index}`));
  const logQuery = client.queryDetails.find((query) => query.table === 'pos_order_status_logs');
  assert.equal(logQuery.limit, 15);
  assert.deepEqual(logQuery.orders, [{ key: 'created_at', ascending: false }]);

  const historical = await repo.loadPosStateFromSupabase({ includeHistoricalRows: true });
  assert.equal(historical.logs.length, 30);
  const historicalLogQuery = client.queryDetails.filter((query) => query.table === 'pos_order_status_logs')[1];
  assert.equal(historicalLogQuery.limit, 120);

  client.queries.length = 0;
  const historyView = await repo.loadSalesSessionHistoryViewFromSupabase();
  assert.equal(historyView.history.length, 12);
  assert.equal(client.queries.includes('pos_order_status_logs'), false);

  client.queries.length = 0;
  const withoutLogs = await repo.loadPosStateFromSupabase({ includeLogs: false });
  assert.equal(withoutLogs.logs.length, 0);
  assert.equal(client.queries.includes('pos_order_status_logs'), false);
});
