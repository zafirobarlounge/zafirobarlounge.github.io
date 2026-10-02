const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");
const compile = (file) =>
  ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const domain = { exports: {}, Intl, Date };
vm.runInNewContext(compile("src/admin/cash/cash.domain.ts"), domain);
const businessDates = { exports: {}, Intl, Date };
vm.runInNewContext(
  compile("src/shared/operations/salesBusinessDate.ts"),
  businessDates,
);
const fixture = () => ({
  sessions: [
    {
      id: "session",
      session_label: "Jornada de prueba",
      business_date: "2026-09-27",
      status: "open",
      components: {
        opening: 100000,
        cash: 500000,
        expenses: 160000,
        withdrawals: 0,
        contributions: 0,
      },
    },
  ],
  registers: [
    {
      sales_session_id: "session",
      opening_amount: 100000,
      opened_by: "caja",
      opened_at: "2026-09-27T23:00:00Z",
      components: null,
    },
  ],
  movements: [],
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('importe colombiano formatea miles y normaliza decimales sin alterar el valor', () => {
  const { cashInput } = domain.exports;
  assert.equal(cashInput('1500000').display, '1.500.000');
  assert.equal(cashInput('1.500.000,50').value, '1500000.50');
  assert.equal(cashInput('0').value, '0');
  assert.equal(cashInput('12,').display, '12,');
  assert.equal(cashInput('12,345'), null);
  assert.equal(cashInput('-100'), null);
  assert.equal(cashInput('1000000000000'), null);
});
test("apertura calcula fecha comercial automaticamente y completar base conserva fecha", async () => {
  const saved = [];
  const h = harness({
    data: { sessions: [], registers: [], movements: [] },
    save: async (_, p) => {
      saved.push(p);
      return { sales_session_id: "new" };
    },
  });
  h.render();
  await settle();
  let tree = h.render();
  const form = nodes(tree, "form").find((f) =>
    text(f).includes("Abrir jornada y caja"),
  );
  const options = businessDates.exports.salesDayOptions();
  assert.ok(!nodes(form, "select").some(n => n.props.name === 'business_date'));
  submit(form, {
    amount: "100000",
    business_date: options.yesterday,
    notes: "",
  });
  await settle();
  assert.equal(saved[0].business_date, options.suggested);
  const data = fixture();
  data.registers = [];
  const complete = harness({
    data,
    save: async (_, p) => {
      saved.push(p);
      return {};
    },
  });
  complete.render();
  await settle();
  tree = complete.render();
  const base = nodes(tree, "form").find((f) =>
    text(f).includes("Completar base de la jornada activa"),
  );
  assert.match(
    text(base),
    /Ingresa el efectivo que había al inicio de la jornada, sin incluir las ventas cobradas después/,
  );
  assert.ok(
    !nodes(base, "select").some((n) => n.props.name === "business_date"),
  );
  submit(base, { amount: "100000", notes: "" });
  await settle();
  assert.equal(saved[1].business_date, undefined);
  assert.equal(saved[1].session, "session");
});
function harness({
  onClose,
  initialAction = 'session',
  embedded = false,
  role = "cashier",
  storage = new Map(),
  save = async () => ({}),
  data = fixture(),
} = {}) {
  const downloads = [];
  let cursor = 0,
    states = [],
    effects = [],
    mounted = false;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states))
        states[i] = typeof initial === "function" ? initial() : initial;
      return [
        states[i],
        (next) => {
          states[i] = typeof next === "function" ? next(states[i]) : next;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (states[i] ??= { current: initial });
    },
    useEffect(effect) {
      if (!mounted) effects.push(effect);
    },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const context = {
    exports: {},
    Intl,
    Date,
    Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    document: { body: { style: {} }, createElement: () => ({ click() {} }) },
    crypto: { randomUUID },
    window: { confirm: () => true },
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    FormData: class {
      constructor(form) {
        this.values = form.values;
      }
      [Symbol.iterator]() {
        return Object.entries(this.values)[Symbol.iterator]();
      }
    },
    require(name) {
      if (name.includes('sessionFinance')) return { sessionDetailUrl: id => `/admin/sales-sessions?session=${encodeURIComponent(id)}` };
      if (name.includes("salesBusinessDate")) return businessDates.exports;
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-router-dom")
        return { Link: "a", Navigate: "redirect" };
      if (name.includes("SupabaseAuthProvider"))
        return {
          useSupabaseAuth: () => ({
            isCatalogAdmin: false,
            staffRoles: [role],
            user: { id: "test-user" },
          }),
        };
      if (name.includes("AdminLayout")) return { AdminLayout: "layout" };
      if (name.includes("cash.domain")) return domain.exports;
      if (name.includes("cash.repository"))
        return { loadCash: async () => structuredClone(data), saveCash: save };
      if (name.includes("inventory.repository"))
        return { loadInventory: async () => ({ items:[],presentations:[] }), loadInventoryPendingReplenishments: async () => [], saveInventoryPurchase: save, subscribeToInventoryRealtime: () => () => {} };
      if (name.includes("InventoryPurchaseLinesEditor"))
        return { InventoryPurchaseLinesEditor: 'purchase-lines', buildInventoryPurchaseLines:()=>[], createInventoryPurchaseLine:()=>({}), inventoryPurchaseLinesValid:()=>true, inventoryPurchaseTotal:()=>0, rememberInventoryPurchasePresentations:()=>{} };
      throw new Error(name);
    },
  };
  vm.runInNewContext(compile("src/admin/cash/AdminCashView.tsx"), context);
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    return {
      ...node,
      props: { ...node.props, children: expand(node.props.children) },
    };
  };
  return {
    storage,
    downloads,
    render() {
      cursor = 0;
      const tree = expand(context.exports.AdminCashView({ initialAction, embedded, onClose }));
      for (const effect of effects) effect();
      effects = [];
      mounted = true;
      return tree;
    },
  };
}
test('guardar base pendiente cambia automaticamente al arqueo sin cerrar el modal del POS', async () => {
  for (const embedded of [false, true]) {
    const data=fixture(); data.registers=[];
    let closes=0;
    const saved=[];
    const h=harness({data,embedded,onClose:()=>closes++,save:async(_,payload)=>{
      saved.push(payload);
      data.registers=fixture().registers;
      return {sales_session_id:'session'};
    }});
    h.render(); await settle();
    const base=nodes(h.render(),'form').find(f=>text(f).includes('Completar base'));
    submit(base,{amount:'100.000',notes:''}); await settle();
    const tree=h.render();
    assert.equal(saved[0].action,'open');
    assert.equal(saved[0].session,'session');
    assert.equal(saved[0].business_date,undefined);
    assert.equal(closes,0);
    assert.ok(!nodes(tree,'form').some(f=>text(f).includes('Completar base')));
    assert.ok(nodes(tree,'form').some(f=>text(f).includes('Arqueo y cierre de jornada')));
    assert.equal(nodes(tree,'div').filter(n=>n.props.role==='dialog').length,1);
  }
});
test('consulta mensual limita jornadas y movimientos; cajero tiene enlace al UUID seleccionado', async () => {
  const data=fixture();
  data.sessions.push({...data.sessions[0],id:'old',session_label:'Antigua',business_date:'2020-02-01',status:'closed'});
  data.movements=[{id:'m',sales_session_id:null,kind:'expense',origin:'owner',method:'cash',category:'other',concept:'Gasto antiguo',amount:10,expense_date:'2020-02-01',created_at:'2020-02-01T12:00:00Z',created_by:'test'}];
  const h=harness({data,initialAction:null}); h.render(); await settle();
  let tree=h.render();
  assert.equal(nodes(tree,'form').length,0);
  assert.ok(!nodes(tree,'option').some(n=>n.props.value==='old'));
  assert.equal(nodes(tree,'a').find(n=>text(n)==='Ver detalle de la jornada').props.to,'/admin/sales-sessions?session=session');
  nodes(tree,'input').find(n=>n.props.type==='month').props.onChange({target:{value:'2020-02'}});
  tree=h.render();
  assert.ok(nodes(tree,'option').some(n=>n.props.value==='old'));
  assert.ok(!nodes(tree,'option').some(n=>n.props.value==='session'));
  assert.match(text(tree),/Gasto antiguo/);
});
test('movimiento incrustado en POS abre solamente su modal y usa la jornada activa', async () => {
  const saves=[];
  const h=harness({embedded:true,initialAction:'movement',save:async(_,p)=>{saves.push(p);return {};}});
  h.render(); await settle(); const tree=h.render();
  assert.equal(nodes(tree,'layout').length,0);
  assert.equal(nodes(tree,'div').filter(n=>n.props.role==='dialog').length,1);
  assert.equal(nodes(tree,'form').length,1);
  submit(nodes(tree,'form')[0],{amount:'20',concept:'Taxi',category:'transport',date:'2026-09-27',notes:''});
  await settle(); assert.equal(saves[0].session,'session');
  assert.equal(h.render(),null);
});
function nodes(tree, type) {
  if (Array.isArray(tree)) return tree.flatMap((x) => nodes(x, type));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(tree.type === type ? [tree] : []),
    ...nodes(tree.props?.children, type),
  ];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
function submit(form, values) {
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: { values, reset() {} },
  });
}
test("interfaz exige explicación del faltante y envía el esperado mostrado", async () => {
  const saves = [];
  const h = harness({
    save: async (id, payload) => {
      saves.push(payload);
      return {};
    },
  });
  h.render();
  await settle();
  let tree = h.render();
  let close = nodes(tree, "form").find((f) =>
    text(f).includes("Arqueo y cierre de jornada"),
  );
  nodes(close, "input")
    .find((i) => i.props.name === "amount")
    .props.onChange({ target: { value: "430000" } });
  tree = h.render();
  close = nodes(tree, "form").find((f) =>
    text(f).includes("Arqueo y cierre de jornada"),
  );
  assert.match(text(close), /Faltante/);
  assert.equal(
    nodes(close, "input").find((i) => i.props.name === "reason").props.required,
    true,
  );
  submit(close, { amount: "430.000,50", reason: "Falta dinero", notes: "" });
  await settle();
  assert.equal(saves[0].expected, 440000);
  assert.equal(saves[0].amount, '430000.50');
  assert.equal(saves[0].session, "session");
});
test("doble clic y recarga tras fallo de red conservan UUID y no anuncian éxito", async () => {
  const storage = new Map(),
    ids = [];
  let reject;
  const h = harness({
    initialAction: 'movement',
    storage,
    save: (id) => {
      ids.push(id);
      return new Promise((_, r) => {
        reject = r;
      });
    },
  });
  h.render();
  await settle();
  let tree = h.render();
  const form = nodes(tree, "form").find((f) =>
    text(f).includes("Registrar movimiento"),
  );
  const values = {
    amount: "100",
    concept: "Taxi",
    category: "transport",
    date: "2026-09-27",
    notes: "",
  };
  submit(form, values);
  submit(form, values);
  assert.equal(ids.length, 1);
  reject(new Error("Sin conexión"));
  await settle();
  tree = h.render();
  assert.ok(!text(tree).includes("Operación guardada."));
  assert.equal(storage.size, 1);
  const reloaded = harness({
    storage,
    save: async (id) => {
      ids.push(id);
      return {};
    },
  });
  reloaded.render();
  await settle();
  tree = reloaded.render();
  nodes(tree, "button")
    .find((b) => text(b) === "Reintentar operación pendiente")
    .props.onClick();
  await settle();
  assert.equal(ids[0], ids[1]);
  assert.equal(storage.size, 0);
  assert.match(text(reloaded.render()), /Operación guardada/);
});
test("interfaz bloquea roles operativos y no inventa arqueos históricos", async () => {
  for (const role of ["waiter", "kitchen", "bar"])
    assert.equal(harness({ role }).render().type, "redirect");
  const data = fixture();
  data.sessions[0].business_date = businessDates.exports.salesDayOptions().suggested;
  data.sessions[0].status = "closed";
  data.sessions[0].components.opening = null;
  data.registers = [];
  const h = harness({ data });
  h.render();
  await settle();
  const tree = h.render();
  assert.match(text(tree), /Sin registrar/);
  assert.ok(
    !nodes(tree, "form").some((f) =>
      text(f).includes("Arqueo y cierre de jornada"),
    ),
  );
});


test('selected UUID includes next-month dawn; all/none and CSV use expense month', async () => {
  for(const role of ['cashier','superadmin']) {
    const data=fixture(); data.sessions[0].business_date='2026-09-30';
    const movement=(id,date,sid)=>({id,sales_session_id:sid,kind:'expense',origin:'register',method:'cash',category:'other',concept:id,amount:10,expense_date:date,created_at:date+'T06:00:00Z',created_by:'test'});
    data.movements=[movement('September','2026-09-30','session'),movement('Dawn','2026-10-01','session'),movement('Unassigned','2026-09-30',null),movement('OtherUUID','2026-09-30','other')];
    const h=harness({data,role,initialAction:null}); h.render(); await settle();
    let tree=h.render();
    assert.equal(nodes(tree,'a').find(n=>text(n)==='Ver detalle de la jornada').props.to,'/admin/sales-sessions?session=session');
    const scope=()=>nodes(tree,'select').find(n=>nodes(n,'option').some(o=>o.props.value==='all'));
    for(const [mode,expected] of [['selected',['September','Dawn']],['all',['September','Unassigned','OtherUUID']],['none',['Unassigned']]]) {
      scope().props.onChange({target:{value:mode}}); tree=h.render();
      const cards=nodes(tree,'article').map(text).join('|');
      nodes(tree,'button').find(n=>text(n)==='Exportar detalle CSV').props.onClick();
      const csv=await h.downloads.at(-1).text();
      for(const name of ['September','Dawn','Unassigned','OtherUUID']) {
        assert.equal(cards.includes(name),expected.includes(name),mode+name);
        assert.equal(csv.includes(name),expected.includes(name),'CSV '+mode+name);
      }
    }
  }
});

test('compra de inventario calcula y bloquea el valor del movimiento', () => {
  const view = readFileSync('src/admin/cash/AdminCashView.tsx','utf8');
  assert.match(view,/purchaseTotalDisplay/);
  assert.match(view,/name="amount" value=\{purchaseTotalDisplay\}/);
  assert.match(view,/aria-label="Valor total calculado desde los productos"/);
  assert.match(view,/cursor-not-allowed/);
  assert.match(view,/disabled readOnly/);
  assert.match(view,/Se calcula autom.ticamente con los productos recibidos/);
  assert.doesNotMatch(view,/Diferencia:.*Corrige los valores antes de guardar/);
});
