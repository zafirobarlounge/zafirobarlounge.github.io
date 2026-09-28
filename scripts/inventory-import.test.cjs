const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const XLSX = require('xlsx');

const source = ts.transpileModule(readFileSync('src/admin/inventory/inventory-import.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const sandbox = { exports: {}, require, crypto: require('node:crypto').webcrypto, ArrayBuffer, Uint8Array, Map, Set, Number, String, Object };
vm.runInNewContext(source, sandbox);
const { parseInventoryWorkbook, createInventoryTemplateWorkbook } = sandbox.exports;
const headers = {
  Articulos: ['codigo','nombre','area','unidad_base','existencia_inicial','costo_unitario_inicial','minimo','objetivo','observaciones'],
  Presentaciones: ['codigo_articulo','presentacion','contenido','unidad','costo_sugerido','observaciones'],
  ConsumoMenu: ['producto_menu','codigo_articulo','cantidad_base','unidad','tipo_control'],
};

const workbookBuffer = (sheets) => {
  const workbook = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => XLSX.utils.book_append_sheet(workbook, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([headers[name]]), name));
  if (!sheets.Pendientes) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['articulo_relacion','dato_faltante','motivo']]), 'Pendientes');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

test('plantilla contiene las cuatro hojas y los encabezados exactos', () => {
  const workbook = createInventoryTemplateWorkbook();
  assert.deepEqual(Array.from(workbook.SheetNames), ['Articulos','Presentaciones','ConsumoMenu','Pendientes']);
  assert.deepEqual(Array.from(XLSX.utils.sheet_to_json(workbook.Sheets.Articulos, { header: 1 })[0]), ['codigo','nombre','area','unidad_base','existencia_inicial','costo_unitario_inicial','minimo','objetivo','observaciones']);
});

test('lee varias hojas, omite filas vacías y conserva vacío como null', () => {
  const buffer = workbookBuffer({
    Articulos: [{ codigo:'PAN',nombre:'Pan',area:'cocina',unidad_base:'unidad',existencia_inicial:'',costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:'' }, {}],
    Presentaciones: [{codigo_articulo:'PAN',presentacion:'Paquete x4',contenido:4,unidad:'unidad',costo_sugerido:'',observaciones:''},{codigo_articulo:'PAN',presentacion:'Paquete x6',contenido:6,unidad:'unidad',costo_sugerido:7000,observaciones:''}],
    ConsumoMenu: [{producto_menu:'comida::pan::1',codigo_articulo:'PAN',cantidad_base:1,unidad:'unidad',tipo_control:'parcial'}],
  });
  const parsed = parseInventoryWorkbook(buffer);
  assert.deepEqual(Array.from(parsed.errors), []);
  assert.equal(parsed.payload.articles.length, 1);
  assert.equal(parsed.payload.articles[0].initial_quantity, null);
  assert.equal(parsed.payload.articles[0].initial_unit_cost, null);
  assert.equal(parsed.payload.presentations.length, 2);
  assert.equal(parsed.payload.presentations[0].suggested_package_cost, null);
});

test('detecta duplicados, claves libres y conversiones incompatibles', () => {
  const buffer = workbookBuffer({
    Articulos: [{codigo:'QUESO',nombre:'Queso',area:'cocina',unidad_base:'gramo',existencia_inicial:'',costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:''},{codigo:'QUESO',nombre:'Queso repetido',area:'cocina',unidad_base:'gramo',existencia_inicial:'',costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:''}],
    Presentaciones: [{codigo_articulo:'QUESO',presentacion:'Paquete',contenido:2,unidad:'unidad',costo_sugerido:'',observaciones:''}],
    ConsumoMenu: [{producto_menu:'Nombre inseguro',codigo_articulo:'QUESO',cantidad_base:2,unidad:'unidad',tipo_control:'parcial'}],
  });
  const parsed = parseInventoryWorkbook(buffer);
  assert.ok(parsed.errors.some((value) => value.includes('Código de artículo duplicado')));
  assert.ok(parsed.errors.some((value) => value.includes('no se hacen conversiones automáticas')));
  assert.ok(parsed.errors.some((value) => value.includes('clave estable exacta')));
  assert.ok(parsed.errors.some((value) => value.includes('tajadas, tiras')));
});

test('rechaza tajada y tira cuando la unidad base es gramo', () => {
  const buffer = workbookBuffer({
    Articulos: [
      {codigo:'QUESO',nombre:'Queso',area:'cocina',unidad_base:'gramo',existencia_inicial:'',costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:''},
      {codigo:'TOCINETA',nombre:'Tocineta',area:'cocina',unidad_base:'gramo',existencia_inicial:'',costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:''},
    ],
    Presentaciones: [],
    ConsumoMenu: [
      {producto_menu:'comida::hamburguesa::1',codigo_articulo:'QUESO',cantidad_base:2,unidad:'tajada',tipo_control:'parcial'},
      {producto_menu:'comida::hamburguesa::1',codigo_articulo:'TOCINETA',cantidad_base:2,unidad:'tira',tipo_control:'parcial'},
    ],
  });
  const parsed = parseInventoryWorkbook(buffer);
  assert.ok(parsed.errors.filter((value) => value.includes('unidad inválida')).length >= 2);
});

test('archivo inicial real conserva cantidades vacías y conteos esperados', () => {
  const parsed = parseInventoryWorkbook(readFileSync('data/zafiro-inventory-initial.xlsx'));
  assert.deepEqual(Array.from(parsed.errors), []);
  assert.equal(parsed.payload.articles.length, 57);
  assert.equal(parsed.payload.presentations.length, 49);
  assert.equal(parsed.payload.menu_consumption.length, 38);
  assert.equal(parsed.payload.articles.filter((row) => row.initial_quantity != null).length, 0);
  const book = XLSX.readFile('data/zafiro-inventory-initial.xlsx');
  assert.deepEqual(Array.from(book.SheetNames), ['Articulos','Presentaciones','ConsumoMenu','Pendientes']);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Pendientes).length, 14);
});

test('existencia cero explícita sí representa un conteo inicial', () => {
  const buffer = workbookBuffer({
    Articulos: [{codigo:'AGUA',nombre:'Agua',area:'barra',unidad_base:'unidad',existencia_inicial:0,costo_unitario_inicial:'',minimo:'',objetivo:'',observaciones:''}],
    Presentaciones: [], ConsumoMenu: [],
  });
  const parsed = parseInventoryWorkbook(buffer);
  assert.equal(parsed.payload.articles[0].initial_quantity, 0);
  assert.equal(parsed.errors.length, 0);
});
