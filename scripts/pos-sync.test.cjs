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
