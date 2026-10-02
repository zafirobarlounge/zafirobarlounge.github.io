import * as XLSX from 'xlsx';

export type ImportUnit = 'unit' | 'gram' | 'milliliter';
export type ImportArea = string;
export type ImportUsageType = 'consumable' | 'operational';

export interface InventoryImportArticle {
  code: string;
  name: string;
  area: ImportArea;
  base_unit: ImportUnit;
  usage_type: ImportUsageType;
  initial_quantity: number | null;
  initial_unit_cost: number | null;
  minimum_quantity: number | null;
  target_quantity: number | null;
  notes: string;
}

export interface InventoryImportPresentation {
  item_code: string;
  name: string;
  content_per_package: number;
  content_unit: ImportUnit;
  suggested_package_cost: number | null;
  notes: string;
}

export interface InventoryImportMenuConsumption {
  menu_item_source_key: string;
  item_code: string;
  quantity_base: number;
  unit: ImportUnit;
  control_mode: 'partial';
}

export interface InventoryImportPayload {
  articles: InventoryImportArticle[];
  presentations: InventoryImportPresentation[];
  menu_consumption: InventoryImportMenuConsumption[];
}

export interface ParsedInventoryImport {
  payload: InventoryImportPayload;
  warnings: string[];
  errors: string[];
}

export const inventoryImportHeaders = {
  Articulos: ['codigo', 'nombre', 'area', 'unidad_base', 'tipo_uso', 'existencia_inicial', 'costo_unitario_inicial', 'minimo', 'objetivo', 'observaciones'],
  Presentaciones: ['codigo_articulo', 'presentacion', 'contenido', 'unidad', 'costo_sugerido', 'observaciones'],
  ConsumoMenu: ['producto_menu', 'codigo_articulo', 'cantidad_base', 'unidad', 'tipo_control'],
  Pendientes: ['articulo_relacion', 'dato_faltante', 'motivo'],
} as const;

const units: Record<string, ImportUnit> = { unidad: 'unit', gramo: 'gram', mililitro: 'milliliter' };
const usageTypes: Record<string, ImportUsageType> = { consumible: 'consumable', consumable: 'consumable', operativo: 'operational', operational: 'operational' };
const normalizeAreaPart = (value: string) => value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-CO');
function normalizeAreaSpec(value: unknown): ImportArea | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = normalizeAreaPart(raw);
  if (normalized === 'ambas' || normalized === 'both') return 'both';
  const parts = raw.split(/\s*[+,;]\s*/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((part) => {
    const partKey = normalizeAreaPart(part);
    if (partKey === 'barra') return 'bar';
    if (partKey === 'cocina') return 'kitchen';
    return part;
  }).join('+');
}
const text = (value: unknown) => value == null ? '' : String(value).trim();
const key = (value: unknown) => text(value).toUpperCase();

function optionalNumber(value: unknown, label: string, errors: string[]) {
  if (value == null || text(value) === '') return null;
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(',', '.'));
  if (!Number.isFinite(parsed)) { errors.push(`${label}: debe ser un número válido.`); return null; }
  return parsed;
}

function rows(workbook: XLSX.WorkBook, sheetName: keyof typeof inventoryImportHeaders, errors: string[]) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) { errors.push(`Falta la hoja obligatoria ${sheetName}.`); return [] as Record<string, unknown>[]; }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  const headers = (matrix[0] ?? []).map((value) => text(value));
  const expected = inventoryImportHeaders[sheetName];
  const missing = expected.filter((column) => column !== 'tipo_uso' && !headers.includes(column));
  if (missing.length) errors.push(`${sheetName}: faltan columnas ${missing.join(', ')}.`);
  return matrix.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
    .filter((row) => Object.values(row).some((value) => text(value) !== ''));
}

export function parseInventoryWorkbook(input: ArrayBuffer | Uint8Array): ParsedInventoryImport {
  const workbook = XLSX.read(input, { type: input instanceof ArrayBuffer ? 'array' : 'buffer', cellDates: false });
  const errors: string[] = [];
  const warnings: string[] = [];
  const articleRows = rows(workbook, 'Articulos', errors);
  const presentationRows = rows(workbook, 'Presentaciones', errors);
  const menuRows = rows(workbook, 'ConsumoMenu', errors);
  if (!workbook.Sheets.Pendientes) warnings.push('No se encontró la hoja opcional Pendientes.');

  const articles: InventoryImportArticle[] = articleRows.map((row, index) => {
    const prefix = `Articulos fila ${index + 2}`;
    const code = key(row.codigo), name = text(row.nombre);
    const area = normalizeAreaSpec(row.area);
    const baseUnit = units[text(row.unidad_base).toLowerCase()];
    const rawUsageType = text(row.tipo_uso).toLowerCase();
    const usageType = rawUsageType ? usageTypes[rawUsageType] : 'consumable';
    const initialQuantity = optionalNumber(row.existencia_inicial, `${prefix}, existencia_inicial`, errors);
    const initialCost = optionalNumber(row.costo_unitario_inicial, `${prefix}, costo_unitario_inicial`, errors);
    const minimum = optionalNumber(row.minimo, `${prefix}, minimo`, errors);
    const target = optionalNumber(row.objetivo, `${prefix}, objetivo`, errors);
    if (!code || !name) errors.push(`${prefix}: código y nombre son obligatorios.`);
    if (!area) errors.push(`${prefix}: el área es obligatoria.`);
    if (!baseUnit) errors.push(`${prefix}: unidad inválida; usa unidad, gramo o mililitro.`);
    if (!usageType) errors.push(`${prefix}: tipo_uso inválido; usa consumible u operativo.`);
    if ([initialQuantity, initialCost, minimum, target].some((value) => value != null && value < 0)) errors.push(`${prefix}: cantidades y costos no pueden ser negativos.`);
    if (minimum != null && target != null && target < minimum) errors.push(`${prefix}: objetivo no puede ser menor que mínimo.`);
    return { code, name, area: area ?? 'both', base_unit: baseUnit ?? 'unit', usage_type: usageType ?? 'consumable', initial_quantity: initialQuantity, initial_unit_cost: initialCost, minimum_quantity: minimum, target_quantity: target, notes: text(row.observaciones) };
  });

  const costsWithoutCount = articles.filter((article) => article.initial_quantity == null && article.initial_unit_cost != null).length;
  if (costsWithoutCount) warnings.push(`${costsWithoutCount} artículo(s) tienen costo de referencia pero no existencia: no se generará ningún conteo para ellos.`);

  const articleByCode = new Map(articles.map((article) => [article.code, article]));
  const presentations: InventoryImportPresentation[] = presentationRows.map((row, index) => {
    const prefix = `Presentaciones fila ${index + 2}`;
    const itemCode = key(row.codigo_articulo), name = text(row.presentacion);
    const content = optionalNumber(row.contenido, `${prefix}, contenido`, errors);
    const unit = units[text(row.unidad).toLowerCase()];
    const cost = optionalNumber(row.costo_sugerido, `${prefix}, costo_sugerido`, errors);
    if (!itemCode || !name || content == null) errors.push(`${prefix}: código, presentación y contenido son obligatorios.`);
    if (content != null && content <= 0) errors.push(`${prefix}: contenido debe ser mayor que cero.`);
    if (cost != null && cost < 0) errors.push(`${prefix}: costo_sugerido no puede ser negativo.`);
    if (!unit) errors.push(`${prefix}: unidad inválida.`);
    const article = articleByCode.get(itemCode);
    if (!article) errors.push(`${prefix}: no existe el artículo ${itemCode} en el archivo.`);
    else if (unit && article.base_unit !== unit) errors.push(`${prefix}: ${text(row.unidad)} no coincide con la unidad base de ${itemCode}; no se hacen conversiones automáticas.`);
    return { item_code: itemCode, name, content_per_package: content ?? 0, content_unit: unit ?? 'unit', suggested_package_cost: cost, notes: text(row.observaciones) };
  });

  const menuConsumption: InventoryImportMenuConsumption[] = menuRows.map((row, index) => {
    const prefix = `ConsumoMenu fila ${index + 2}`;
    const sourceKey = text(row.producto_menu), itemCode = key(row.codigo_articulo);
    const quantity = optionalNumber(row.cantidad_base, `${prefix}, cantidad_base`, errors);
    const unit = units[text(row.unidad).toLowerCase()];
    const mode = text(row.tipo_control).toLowerCase();
    if (!sourceKey || !sourceKey.includes('::')) errors.push(`${prefix}: producto_menu debe contener la clave estable exacta, no un nombre libre.`);
    if (!itemCode || quantity == null) errors.push(`${prefix}: artículo y cantidad_base son obligatorios.`);
    if (quantity != null && quantity <= 0) errors.push(`${prefix}: cantidad_base debe ser mayor que cero.`);
    if (!unit) errors.push(`${prefix}: unidad inválida.`);
    if (mode !== 'parcial') errors.push(`${prefix}: tipo_control debe ser parcial.`);
    const article = articleByCode.get(itemCode);
    if (!article) errors.push(`${prefix}: no existe el artículo ${itemCode} en el archivo.`);
    else if (article.usage_type === 'operational') errors.push(`${prefix}: el artículo ${itemCode} es operativo y no puede asociarse al consumo del menú.`);
    else if (unit && article.base_unit !== unit) errors.push(`${prefix}: ${text(row.unidad)} no coincide con la unidad base de ${itemCode}; tajadas, tiras, hojas y rodajas requieren conversión explícita.`);
    return { menu_item_source_key: sourceKey, item_code: itemCode, quantity_base: quantity ?? 0, unit: unit ?? 'unit', control_mode: 'partial' };
  });

  const duplicates = <T>(values: T[], makeKey: (value: T) => string, label: string) => {
    const seen = new Set<string>();
    values.forEach((value) => { const valueKey = makeKey(value).toLocaleLowerCase(); if (seen.has(valueKey)) errors.push(`${label} duplicado: ${makeKey(value)}.`); seen.add(valueKey); });
  };
  duplicates(articles, (row) => row.code, 'Código de artículo');
  duplicates(presentations, (row) => `${row.item_code} / ${row.name}`, 'Presentación');
  duplicates(menuConsumption, (row) => `${row.menu_item_source_key} / ${row.item_code}`, 'Asociación de menú');

  return { payload: { articles, presentations, menu_consumption: menuConsumption }, warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}

export function createInventoryTemplateWorkbook() {
  const workbook = XLSX.utils.book_new();
  (Object.keys(inventoryImportHeaders) as Array<keyof typeof inventoryImportHeaders>).forEach((name) => {
    const sheet = XLSX.utils.aoa_to_sheet([[...inventoryImportHeaders[name]]]);
    sheet['!cols'] = inventoryImportHeaders[name].map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  return workbook;
}

export async function inventoryImportFingerprint(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
