import type { MenuDataCollection, MenuDataItem } from '../../shared/menu/menu.types';
import {
  buildAdminMenuApplyPayload,
  getAdminMenuCategory,
  getAdminMenuSubgroup,
  serializeAdminMenuDraft,
} from './adminMenu.mapper';
import type {
  AdminMenuApplyHistoryEntry,
  AdminMenuCatalogApplyArtifact,
  AdminMenuDraftItem,
  AdminMenuExcelChangeRow,
} from './adminMenu.types';

interface BrowserFileSystemWritableFileStream {
  close(): Promise<void>;
  write(data: string): Promise<void>;
}

interface BrowserFileSystemFileHandle {
  createWritable(): Promise<BrowserFileSystemWritableFileStream>;
}

interface BrowserFileSystemDirectoryHandle {
  getDirectoryHandle(
    name: string,
    options?: {
      create?: boolean;
    },
  ): Promise<BrowserFileSystemDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: {
      create?: boolean;
    },
  ): Promise<BrowserFileSystemFileHandle>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<BrowserFileSystemDirectoryHandle>;
}

export interface AdminMenuCatalogApplyResult {
  artifact: AdminMenuCatalogApplyArtifact;
  fileTargets: string[];
  nextCatalog: MenuDataCollection;
}

export function buildAdminMenuCatalogApplyArtifact(
  sourceCatalog: MenuDataCollection,
  drafts: AdminMenuDraftItem[],
): AdminMenuCatalogApplyArtifact {
  const applyPayload = buildAdminMenuApplyPayload(drafts);
  const readyKeys = new Set(
    applyPayload.items.filter((item) => item.status === 'ready').map((item) => item.draftKey),
  );
  const draftMap = new Map(drafts.map((draft) => [draft.draftKey, draft]));

  const nextItems = drafts.map((draft) => {
    if (!readyKeys.has(draft.draftKey)) {
      return draft.original;
    }

    return materializeMenuItemFromDraft(draft);
  });

  const afterCatalog: MenuDataCollection = {
    updatedAt: new Date().toISOString(),
    count: nextItems.length,
    items: nextItems,
  };

  const excelRows = buildAdminMenuExcelRows(drafts, applyPayload);
  const changedFields = excelRows.filter((row) => row.status === 'ready').length;

  return {
    kind: 'zafiro-admin-menu-catalog-apply-artifact',
    version: 1,
    generatedAt: afterCatalog.updatedAt,
    beforeCatalog: sourceCatalog,
    afterCatalog,
    applyPayload: {
      ...applyPayload,
      items: applyPayload.items.map((item) => {
        const draft = draftMap.get(item.draftKey);

        if (!draft || item.status !== 'ready') {
          return item;
        }

        return {
          ...item,
          serializedItem: serializeAdminMenuDraft(draft),
        };
      }),
    },
    excelRows,
    summary: {
      applicable: applyPayload.summary.readyItems > 0,
      appliedItems: applyPayload.summary.readyItems,
      blockedItems: applyPayload.summary.blockedItems,
      totalChangedItems: applyPayload.summary.totalChangedItems,
      changedFields,
    },
  };
}

export async function applyCatalogArtifactToDirectory(
  artifact: AdminMenuCatalogApplyArtifact,
): Promise<AdminMenuCatalogApplyResult> {
  const rootHandle = await pickRepositoryRoot();
  await assertCatalogStructure(rootHandle);

  const timeTag = buildSafeTimestamp(artifact.generatedAt);
  const historyDir = await getNestedDirectoryHandle(rootHandle, ['data', 'admin-history', `catalog-apply-${timeTag}`], true);
  const publicDataDir = await getNestedDirectoryHandle(rootHandle, ['public', 'data'], true);

  await writeJsonFile(publicDataDir, 'menu.json', artifact.afterCatalog);
  await writeJsonFile(historyDir, 'before-catalog.json', artifact.beforeCatalog);
  await writeJsonFile(historyDir, 'after-catalog.json', artifact.afterCatalog);
  await writeJsonFile(historyDir, 'apply-artifact.json', artifact);
  await writeJsonFile(historyDir, 'excel-changes.json', artifact.excelRows);
  await writeTextFile(historyDir, 'excel-changes.csv', buildExcelCsv(artifact.excelRows));

  return {
    artifact,
    nextCatalog: artifact.afterCatalog,
    fileTargets: [
      'public/data/menu.json',
      `data/admin-history/catalog-apply-${timeTag}/before-catalog.json`,
      `data/admin-history/catalog-apply-${timeTag}/after-catalog.json`,
      `data/admin-history/catalog-apply-${timeTag}/apply-artifact.json`,
      `data/admin-history/catalog-apply-${timeTag}/excel-changes.json`,
      `data/admin-history/catalog-apply-${timeTag}/excel-changes.csv`,
    ],
  };
}

export function buildAdminMenuApplyHistoryEntry(
  artifact: AdminMenuCatalogApplyArtifact,
  fileTargets: string[],
): AdminMenuApplyHistoryEntry {
  return {
    id: `applied-${artifact.generatedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'applied',
    createdAt: artifact.generatedAt,
    artifact,
    fileTargets,
  };
}

export function buildExcelCsv(rows: AdminMenuExcelChangeRow[]) {
  const headers = [
    'status',
    'id',
    'slug',
    'itemName',
    'hojaOrigen',
    'tipo',
    'subgrupo',
    'field',
    'fieldLabel',
    'before',
    'after',
  ];

  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      [
        row.status,
        String(row.id),
        row.itemSlug,
        row.itemName,
        row.hojaOrigen,
        row.tipo,
        row.subgrupo,
        row.field,
        row.fieldLabel,
        row.before,
        row.after,
      ]
        .map(escapeCsvValue)
        .join(','),
    ),
  ];

  return lines.join('\n');
}

export function materializeMenuItemFromDraft(draft: AdminMenuDraftItem): MenuDataItem {
  const serialized = serializeAdminMenuDraft(draft);

  return {
    ...draft.original,
    description: serialized.description,
    disponible: serialized.disponible,
    destacado: serialized.destacado,
    hojaOrigen: serialized.hojaOrigen,
    id: serialized.id,
    imagen: serialized.imagen,
    name: serialized.name,
    orden: serialized.orden,
    precioVenta: serialized.precioVenta,
    subgrupo: serialized.subgrupo,
    tipo: serialized.tipo,
    visible: serialized.visible,
  };
}

function buildAdminMenuExcelRows(drafts: AdminMenuDraftItem[], applyPayload = buildAdminMenuApplyPayload(drafts)) {
  const draftMap = new Map(drafts.map((draft) => [draft.draftKey, draft]));

  return applyPayload.items.flatMap<AdminMenuExcelChangeRow>((item) => {
    const draft = draftMap.get(item.draftKey);

    if (!draft) {
      return [];
    }

    return item.changedFields.map((fieldChange) => ({
      draftKey: item.draftKey,
      id: item.id,
      itemName: item.itemName,
      itemSlug: item.itemSlug,
      hojaOrigen: draft.hojaOrigen,
      tipo: getAdminMenuCategory(draft),
      subgrupo: getAdminMenuSubgroup(draft),
      status: item.status,
      field: fieldChange.field,
      fieldLabel: fieldChange.fieldLabel,
      before: fieldChange.before,
      after: fieldChange.after,
    }));
  });
}

async function pickRepositoryRoot() {
  const pickerWindow = window as DirectoryPickerWindow;

  if (typeof pickerWindow.showDirectoryPicker !== 'function') {
    throw new Error(
      'Este navegador no soporta acceso local al sistema de archivos. Usa Chrome o Edge en localhost para aplicar al catalogo JSON.',
    );
  }

  return pickerWindow.showDirectoryPicker({ mode: 'readwrite' });
}

async function assertCatalogStructure(rootHandle: BrowserFileSystemDirectoryHandle) {
  try {
    const publicDir = await rootHandle.getDirectoryHandle('public');
    const publicDataDir = await publicDir.getDirectoryHandle('data');
    await publicDataDir.getFileHandle('menu.json');
  } catch {
    throw new Error(
      'Selecciona la raiz del repo de ZAFIRO. Debe contener public/data/menu.json.',
    );
  }
}

async function getNestedDirectoryHandle(
  rootHandle: BrowserFileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
) {
  let current = rootHandle;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create });
  }

  return current;
}

async function writeJsonFile(
  directoryHandle: BrowserFileSystemDirectoryHandle,
  fileName: string,
  value: unknown,
) {
  await writeTextFile(directoryHandle, fileName, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(
  directoryHandle: BrowserFileSystemDirectoryHandle,
  fileName: string,
  content: string,
) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function escapeCsvValue(value: string) {
  const normalized = value.replace(/"/g, '""');
  return `"${normalized}"`;
}

function buildSafeTimestamp(value: string) {
  return value.replace(/[:.]/g, '-');
}
