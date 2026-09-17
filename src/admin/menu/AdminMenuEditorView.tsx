import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSupabaseAuth } from '../../auth/SupabaseAuthProvider';
import { loadMenuData } from '../../controllers/menuController';
import { isSupabaseConfigured } from '../../integrations/supabase/client';
import { saveAdminMenuDraftsToSupabase } from '../../integrations/supabase/menuCatalogRepository';
import { normalizeMenuCategory, sanitizeMenuText } from '../../models/menuData';
import type { MenuDataCollection, MenuDataItem } from '../../shared/menu/menu.types';
import { AdminLayout } from '../AdminLayout';
import {
  applyCatalogArtifactToDirectory,
  buildAdminMenuApplyHistoryEntry,
  buildAdminMenuCatalogApplyArtifact,
  buildExcelCsv,
} from './adminMenu.catalogApply';
import {
  generateDerivedExcelFromCurrentDrafts,
  prepareExcelImportAgainstCurrentDrafts,
  compareCurrentDraftsWithExcelFile,
} from './adminMenu.excelSync';
import {
  buildAdminMenuApplyPayload,
  buildAdminMenuDrafts,
  buildAdminMenuReadableChanges,
  buildAdminMenuSnapshot,
  buildCategoryOptions,
  buildSubgroupOptions,
  getAdminMenuCategory,
  getAdminMenuChangedFields,
  getAdminMenuSubgroup,
  hasAdminMenuDraftChanges,
  humanizeAdminLabel,
  importAdminMenuSnapshot,
  mapMenuItemToDraft,
  parseDraftOrder,
  serializeAllAdminMenuDrafts,
  serializeChangedAdminMenuDrafts,
  updateAdminMenuDraftField,
  validateAdminMenuDraft,
} from './adminMenu.mapper';
import type {
  AdminMenuApplyHistoryEntry,
  AdminMenuExcelImportPreview,
  AdminMenuDraftItem,
  AdminMenuExcelChangeRow,
  AdminMenuExcelOperationHistoryEntry,
  AdminMenuExcelSyncReport,
  AdminMenuFilterState,
  AdminMenuReadableChange,
  AdminMenuSnapshot,
  AdminMenuSnapshotHistoryEntry,
} from './adminMenu.types';
import { AdminMenuEditorPanel } from './components/AdminMenuEditorPanel';
import { AdminMenuFilters } from './components/AdminMenuFilters';
import { AdminMenuItemList } from './components/AdminMenuItemList';

type AdminMenuSection = 'editor' | 'changes' | 'snapshots';

const initialFilters: AdminMenuFilterState = {
  search: '',
  status: 'all',
  category: 'all',
  subgroup: 'all',
};

export function AdminMenuEditorView() {
  const { user } = useSupabaseAuth();
  const [catalogCollection, setCatalogCollection] = useState<MenuDataCollection | null>(null);
  const [items, setItems] = useState<MenuDataItem[]>([]);
  const [drafts, setDrafts] = useState<AdminMenuDraftItem[]>([]);
  const [filters, setFilters] = useState<AdminMenuFilterState>(initialFilters);
  const [selectedDraftKey, setSelectedDraftKey] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<AdminMenuSection>('editor');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [snapshotHistory, setSnapshotHistory] = useState<AdminMenuSnapshotHistoryEntry[]>([]);
  const [applyHistory, setApplyHistory] = useState<AdminMenuApplyHistoryEntry[]>([]);
  const [excelSyncReport, setExcelSyncReport] = useState<AdminMenuExcelSyncReport | null>(null);
  const [excelImportPreview, setExcelImportPreview] = useState<AdminMenuExcelImportPreview | null>(null);
  const [excelOperationHistory, setExcelOperationHistory] = useState<AdminMenuExcelOperationHistoryEntry[]>([]);
  const [selectedHistoryEntryId, setSelectedHistoryEntryId] = useState<string | null>(null);
  const [pendingExcelBaseAction, setPendingExcelBaseAction] = useState<'compare' | 'derive' | null>(null);
  const importSnapshotInputRef = useRef<HTMLInputElement | null>(null);
  const baseExcelInputRef = useRef<HTMLInputElement | null>(null);
  const importExcelInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let isMounted = true;

    loadMenuData({ audience: 'admin', fallbackToJson: false })
      .then((data) => {
        if (!isMounted) {
          return;
        }

        const nextDrafts = buildAdminMenuDrafts(data.items);
        setCatalogCollection(data);
        setItems(data.items);
        setDrafts(nextDrafts);
        setSelectedDraftKey(nextDrafts[0]?.draftKey ?? null);
        setError(null);
      })
      .catch((loadError) => {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : 'No fue posible cargar el menu.');
        setCatalogCollection(null);
        setItems([]);
        setDrafts([]);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const categoryOptions = useMemo(() => buildCategoryOptions(drafts), [drafts]);
  const subgroupOptions = useMemo(
    () => buildSubgroupOptions(drafts, filters.category),
    [drafts, filters.category],
  );
  const categorySelectOptions = useMemo(
    () => ensureActiveFilterOption(categoryOptions, filters.category, humanizeAdminLabel),
    [categoryOptions, filters.category],
  );
  const subgroupSelectOptions = useMemo(
    () => ensureActiveFilterOption(subgroupOptions, filters.subgroup, (value) => value),
    [subgroupOptions, filters.subgroup],
  );

  const filteredDrafts = useMemo(() => {
    const normalizedSearch = sanitizeMenuText(filters.search).toLowerCase();

    return drafts
      .filter((item) => {
        const matchesSearch =
          !normalizedSearch ||
          [item.name, item.slug, item.tipo, item.subgrupo, item.hojaOrigen, item.description]
            .map((value) => sanitizeMenuText(value).toLowerCase())
            .some((value) => value.includes(normalizedSearch));

        if (!matchesSearch) {
          return false;
        }

        const matchesStatus = (() => {
          switch (filters.status) {
            case 'visible':
              return item.visible;
            case 'hidden':
              return !item.visible;
            case 'available':
              return item.disponible;
            case 'unavailable':
              return !item.disponible;
            case 'featured':
              return item.destacado;
            case 'edited':
              return hasAdminMenuDraftChanges(item);
            default:
              return true;
          }
        })();

        if (!matchesStatus) {
          return false;
        }

        const matchesCategory = filters.category === 'all' || getAdminMenuCategory(item) === filters.category;
        if (!matchesCategory) {
          return false;
        }

        const matchesSubgroup = filters.subgroup === 'all' || getAdminMenuSubgroup(item) === filters.subgroup;
        return matchesSubgroup;
      })
      .sort((left, right) => {
        const leftOrder = parseDraftOrder(left.orden, left.original.orden);
        const rightOrder = parseDraftOrder(right.orden, right.original.orden);

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return left.name.localeCompare(right.name, 'es-CO');
      });
  }, [drafts, filters]);

  useEffect(() => {
    if (selectedDraftKey !== null && drafts.some((item) => item.draftKey === selectedDraftKey)) {
      return;
    }

    if (filteredDrafts.length) {
      setSelectedDraftKey(filteredDrafts[0].draftKey);
      return;
    }

    setSelectedDraftKey(drafts[0]?.draftKey ?? null);
  }, [drafts, filteredDrafts, selectedDraftKey]);

  const selectedItem = drafts.find((item) => item.draftKey === selectedDraftKey) ?? null;
  const selectedItemMatchesFilters = selectedItem
    ? filteredDrafts.some((item) => item.draftKey === selectedItem.draftKey)
    : false;
  const selectedValidation = selectedItem ? validateAdminMenuDraft(selectedItem) : null;
  const selectedChangedFields = selectedItem ? getAdminMenuChangedFields(selectedItem) : [];
  const editedItems = drafts.filter(hasAdminMenuDraftChanges);
  const editedCount = editedItems.length;
  const visibleCount = drafts.filter((item) => item.visible).length;
  const unavailableCount = drafts.filter((item) => !item.disponible).length;
  const invalidCount = drafts.filter((item) => !validateAdminMenuDraft(item).isValid).length;
  const pendingPayloadPreview = serializeChangedAdminMenuDrafts(drafts);
  const fullPayloadPreview = useMemo(() => serializeAllAdminMenuDrafts(drafts), [drafts]);
  const adminSnapshot = useMemo(
    () => buildAdminMenuSnapshot(drafts, filters, selectedDraftKey),
    [drafts, filters, selectedDraftKey],
  );
  const adminApplyPayload = useMemo(() => buildAdminMenuApplyPayload(drafts), [drafts]);
  const adminApplyArtifact = useMemo(
    () => (catalogCollection ? buildAdminMenuCatalogApplyArtifact(catalogCollection, drafts) : null),
    [catalogCollection, drafts],
  );
  const excelChangeRows = useMemo(() => adminApplyArtifact?.excelRows ?? [], [adminApplyArtifact]);
  const excelCsvPreview = useMemo(() => buildExcelCsv(excelChangeRows), [excelChangeRows]);
  const currentReadableChanges = useMemo(() => buildAdminMenuReadableChanges(editedItems), [editedItems]);
  const isPayloadReady = editedCount > 0 && invalidCount === 0;
  const changedDraftSummaries = useMemo(
    () =>
      editedItems.map((item) => {
        const changedFields = getAdminMenuChangedFields(item);
        const validation = validateAdminMenuDraft(item);

        return {
          draftKey: item.draftKey,
          changedFields,
          fieldCount: changedFields.length,
          hasErrors: !validation.isValid,
          item,
          validation,
        };
      }),
    [editedItems],
  );
  const selectedHistoryEntry =
    snapshotHistory.find((entry) => entry.id === selectedHistoryEntryId) ?? snapshotHistory[0] ?? null;

  const handleFilterChange = <K extends keyof AdminMenuFilterState>(
    field: K,
    value: AdminMenuFilterState[K],
  ) => {
    setFilters((current) => ({
      ...current,
      [field]: value,
      ...(field === 'category' ? { subgroup: 'all' } : {}),
    }));
  };

  const handleItemFieldChange = <K extends keyof AdminMenuDraftItem>(
    field: K,
    value: AdminMenuDraftItem[K],
  ) => {
    if (selectedDraftKey === null) {
      return;
    }

    setDrafts((current) =>
      current.map((item) =>
        item.draftKey === selectedDraftKey ? updateAdminMenuDraftField(item, field, value) : item,
      ),
    );
  };

  const handleCreateProductDraft = () => {
    const nextId = drafts.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    const fallbackCategory = filters.category !== 'all'
      ? filters.category
      : categoryOptions[0]?.value ?? normalizeMenuCategory(selectedItem?.tipo ?? 'bebidas');
    const fallbackSubgroup = filters.subgroup !== 'all'
      ? filters.subgroup
      : selectedItem?.subgrupo?.trim() || 'General';
    const nextOrder = drafts.reduce((max, item) => Math.max(max, parseDraftOrder(item.orden, item.original.orden)), 0) + 1;
    const nextName = `Nuevo producto ${nextId}`;
    const nextSlug = `nuevo-producto-${nextId}`;
    const nextOriginal: MenuDataItem = {
      id: nextId,
      orden: 0,
      slug: '',
      name: '',
      description: '',
      tipo: '',
      subgrupo: '',
      ingredientes: '',
      preparacion: '',
      emplatado: '',
      precioVenta: null,
      imagen: '',
      hojaOrigen: '',
      visible: false,
      disponible: false,
      destacado: false,
    };

    const nextDraft = mapMenuItemToDraft(
      {
        ...nextOriginal,
        orden: nextOrder,
        slug: nextSlug,
        name: nextName,
        tipo: humanizeAdminLabel(fallbackCategory),
        subgrupo: fallbackSubgroup,
        hojaOrigen: fallbackSubgroup,
        visible: true,
        disponible: true,
      },
      `new::${nextId}`,
    );

    setDrafts((current) => [nextDraft, ...current]);
    setSelectedDraftKey(nextDraft.draftKey);
    setActiveSection('editor');
    setExportFeedback(`Se creo un borrador nuevo para ${nextDraft.name}. Completa la ficha y luego guardala en Supabase.`);
  };

  const resetSelectedItem = () => {
    if (!selectedItem) {
      return;
    }

    setDrafts((current) =>
      current.map((item) =>
        item.draftKey === selectedItem.draftKey ? mapMenuItemToDraft(item.original, item.draftKey) : item,
      ),
    );
  };

  const resetAllChanges = () => {
    const nextDrafts = buildAdminMenuDrafts(items);
    setDrafts(nextDrafts);
    setSelectedDraftKey(nextDrafts[0]?.draftKey ?? null);
    setExportFeedback(null);
  };

  const focusSelectedItemInFilters = () => {
    if (!selectedItem) {
      return;
    }

    setFilters({
      search: '',
      status: 'all',
      category: getAdminMenuCategory(selectedItem),
      subgroup: getAdminMenuSubgroup(selectedItem),
    });
  };

  const handleDownloadPayload = (payload: unknown, fileName: string, emptyMessage: string) => {
    if (Array.isArray(payload) && payload.length === 0) {
      setExportFeedback(emptyMessage);
      return;
    }

    const serialized = JSON.stringify(payload, null, 2);
    const blob = new Blob([serialized], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    setExportFeedback(`Se descargo ${fileName}.`);
  };

  const handleCopyPayload = async (
    payload: unknown,
    successMessage: string,
    emptyMessage: string,
  ) => {
    if (Array.isArray(payload) && payload.length === 0) {
      setExportFeedback(emptyMessage);
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setExportFeedback(successMessage);
    } catch (copyError) {
      setExportFeedback(
        copyError instanceof Error
          ? `No fue posible copiar el JSON: ${copyError.message}`
          : 'No fue posible copiar el JSON.',
      );
    }
  };

  const registerSnapshotHistory = ({
    snapshot,
    source,
    fileName,
    changes,
    restoredCount,
    missingCount,
  }: {
    changes: AdminMenuReadableChange[];
    fileName: string | null;
    missingCount?: number;
    restoredCount?: number;
    snapshot: AdminMenuSnapshot;
    source: 'saved' | 'imported';
  }) => {
    const entry: AdminMenuSnapshotHistoryEntry = {
      id: `${source}-${snapshot.generatedAt}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      fileName,
      createdAt: snapshot.generatedAt,
      snapshot,
      changes,
      restoredCount,
      missingCount,
    };

    setSnapshotHistory((current) => [entry, ...current]);
    setSelectedHistoryEntryId(entry.id);
  };

  const registerExcelOperation = (entry: Omit<AdminMenuExcelOperationHistoryEntry, 'id'>) => {
    setExcelOperationHistory((current) => [
      {
        ...entry,
        id: `${entry.source}-${entry.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      },
      ...current,
    ]);
  };

  const handleSaveSnapshot = () => {
    const fileName = `zafiro-admin-menu-snapshot-${adminSnapshot.generatedAt.replace(/[:.]/g, '-')}.json`;

    handleDownloadPayload(
      adminSnapshot,
      fileName,
      'No hay cambios pendientes para guardar en snapshot.',
    );

    if (pendingPayloadPreview.length) {
      registerSnapshotHistory({
        snapshot: adminSnapshot,
        source: 'saved',
        fileName,
        changes: currentReadableChanges,
      });
    }
  };

  const handleOpenImportSnapshot = () => {
    importSnapshotInputRef.current?.click();
  };

  const handleImportSnapshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const rawContent = await file.text();
      const parsedContent = JSON.parse(rawContent) as unknown;
      const imported = importAdminMenuSnapshot(items, parsedContent);

      setDrafts(imported.drafts);
      setFilters(imported.filters);
      setSelectedDraftKey(imported.selectedDraftKey);
      setActiveSection('editor');
      registerSnapshotHistory({
        snapshot: imported.snapshot,
        source: 'imported',
        fileName: file.name,
        changes: buildAdminMenuReadableChanges(imported.drafts.filter(hasAdminMenuDraftChanges)),
        restoredCount: imported.restoredCount,
        missingCount: imported.missingCount,
      });
      setExportFeedback(
        imported.missingCount
          ? `Snapshot importado con ${imported.restoredCount} item${imported.restoredCount === 1 ? '' : 's'} restaurado${imported.restoredCount === 1 ? '' : 's'} y ${imported.missingCount} sin coincidencia en el catalogo actual.`
          : `Snapshot importado correctamente. Se restauraron ${imported.restoredCount} item${imported.restoredCount === 1 ? '' : 's'} editado${imported.restoredCount === 1 ? '' : 's'}.`,
      );
    } catch (importError) {
      setExportFeedback(
        importError instanceof Error
          ? `No fue posible importar el snapshot: ${importError.message}`
          : 'No fue posible importar el snapshot.',
      );
    } finally {
      event.target.value = '';
    }
  };

  const handleDownloadExcelRows = (rows: AdminMenuExcelChangeRow[]) => {
    handleDownloadPayload(
      rows,
      'zafiro-menu-cambios-excel.json',
      'No hay cambios preparados para una salida orientada a Excel.',
    );
  };

  const handleDownloadExcelCsv = () => {
    if (!excelChangeRows.length) {
      setExportFeedback('No hay cambios preparados para una salida orientada a Excel.');
      return;
    }

    const blob = new Blob([excelCsvPreview], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'zafiro-menu-cambios-excel.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    setExportFeedback('Se descargo zafiro-menu-cambios-excel.csv.');
  };

  const handleApplyCatalogJson = async () => {
    if (!adminApplyArtifact) {
      setExportFeedback('No hay catalogo base cargado para aplicar cambios.');
      return;
    }

    if (adminApplyArtifact.summary.appliedItems === 0) {
      setExportFeedback('No hay cambios validos listos para aplicar al catalogo JSON.');
      return;
    }

    try {
      const result = await applyCatalogArtifactToDirectory(adminApplyArtifact);
      const nextDrafts = buildAdminMenuDrafts(result.nextCatalog.items);

      setCatalogCollection(result.nextCatalog);
      setItems(result.nextCatalog.items);
      setDrafts(nextDrafts);
      setSelectedDraftKey(nextDrafts[0]?.draftKey ?? null);
      setApplyHistory((current) => [
        buildAdminMenuApplyHistoryEntry(result.artifact, result.fileTargets),
        ...current,
      ]);
      setActiveSection('changes');
      setExportFeedback(
        `Se aplicaron ${result.artifact.summary.appliedItems} item${result.artifact.summary.appliedItems === 1 ? '' : 's'} al catalogo JSON. Se actualizo public/data/menu.json con respaldo en data/admin-history.`,
      );
    } catch (applyError) {
      setExportFeedback(
        applyError instanceof Error
          ? `No fue posible aplicar cambios al catalogo JSON: ${applyError.message}`
          : 'No fue posible aplicar cambios al catalogo JSON.',
      );
    }
  };

  const handleSaveToSupabase = async () => {
    if (!isSupabaseConfigured()) {
      setExportFeedback(
        'Supabase aun no esta configurado en este entorno. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY para guardar cambios reales.',
      );
      return;
    }

    try {
      const result = await saveAdminMenuDraftsToSupabase(drafts, {
        actorLabel: user?.email ?? 'catalog-admin',
        changeSource: 'admin_menu',
        snapshotKind: 'catalog_apply',
      });
      const nextDrafts = buildAdminMenuDrafts(result.collection.items);

      setCatalogCollection(result.collection);
      setItems(result.collection.items);
      setDrafts(nextDrafts);
      setSelectedDraftKey(nextDrafts[0]?.draftKey ?? null);
      setActiveSection('changes');
      setExportFeedback(
        `Supabase actualizado con ${result.appliedCount} item${result.appliedCount === 1 ? '' : 's'} y ${result.logCount} registro${result.logCount === 1 ? '' : 's'} de trazabilidad.`,
      );
    } catch (saveError) {
      setExportFeedback(
        saveError instanceof Error
          ? `No fue posible guardar en Supabase: ${saveError.message}`
          : 'No fue posible guardar en Supabase.',
      );
    }
  };

  const handleOpenBaseExcel = (action: 'compare' | 'derive') => {
    setPendingExcelBaseAction(action);
    baseExcelInputRef.current?.click();
  };

  const handleBaseExcelSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || !pendingExcelBaseAction) {
      return;
    }

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setExportFeedback('Selecciona un archivo .xlsx valido para trabajar con el Excel base.');
      setPendingExcelBaseAction(null);
      return;
    }

    try {
      if (pendingExcelBaseAction === 'compare') {
        const report = await compareCurrentDraftsWithExcelFile(drafts, file);
        const statusLabel =
          report.status === 'synced'
            ? 'Sincronizado'
            : report.status === 'pending'
              ? 'Cambios pendientes respecto al Excel base'
              : 'Desincronizado con Excel base';

        setExcelSyncReport(report);
        setExcelImportPreview(null);
        setActiveSection('changes');
        setExportFeedback(
          `${statusLabel}. Hojas afectadas: ${report.summary.sheetDifferences}, items con diferencias: ${report.summary.itemDifferences}, campos distintos: ${report.summary.fieldDifferences}.`,
        );
        registerExcelOperation({
          createdAt: report.generatedAt,
          fieldCount: report.summary.fieldDifferences,
          fileName: file.name,
          generatedFiles: [],
          itemCount: report.summary.itemDifferences,
          source: 'excel_compare',
          status: report.status,
          summary: `${statusLabel} frente a ${file.name}.`,
        });
      } else {
        const result = await generateDerivedExcelFromCurrentDrafts(drafts, file);
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.derivedFileName;
        anchor.click();
        URL.revokeObjectURL(url);

        setExcelSyncReport(result.report);
        setExcelImportPreview(null);
        setActiveSection('changes');
        setExportFeedback(
          `Excel derivado listo como ${result.derivedFileName}. Se comparo contra ${file.name} y se detectaron ${result.report.summary.itemDifferences} item${result.report.summary.itemDifferences === 1 ? '' : 's'} con diferencias.`,
        );
        registerExcelOperation({
          createdAt: result.report.generatedAt,
          fieldCount: result.report.summary.fieldDifferences,
          fileName: file.name,
          generatedFiles: result.generatedFiles,
          itemCount: result.report.summary.itemDifferences,
          source: 'excel_export',
          status: result.report.status,
          summary: `Excel derivado generado desde ${file.name}.`,
        });
      }
    } catch (syncError) {
      setExportFeedback(
        syncError instanceof Error
          ? `No fue posible trabajar con el Excel base: ${syncError.message}`
          : 'No fue posible trabajar con el Excel base.',
      );
    } finally {
      setPendingExcelBaseAction(null);
    }
  };

  const handleOpenExcelImport = () => {
    importExcelInputRef.current?.click();
  };

  const handleImportExcelPrepare = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setExportFeedback('Selecciona un archivo .xlsx valido para preparar la sincronizacion.');
      return;
    }

    try {
      const preview = await prepareExcelImportAgainstCurrentDrafts(drafts, file);
      const statusLabel =
        preview.report.status === 'synced'
          ? 'Sincronizado'
          : preview.report.status === 'pending'
            ? 'Cambios pendientes respecto a Supabase'
            : 'Desincronizado con Supabase';

      setExcelImportPreview(preview);
      setExcelSyncReport(preview.report);
      setActiveSection('changes');
      setExportFeedback(
        `${statusLabel}. El archivo ${file.name} trae ${preview.totalChangedItems} item${preview.totalChangedItems === 1 ? '' : 's'} editado${preview.totalChangedItems === 1 ? '' : 's'} para revisar antes de sincronizar.`,
      );
      registerExcelOperation({
        createdAt: preview.report.generatedAt,
        fieldCount: preview.report.summary.fieldDifferences,
        fileName: preview.fileName,
        generatedFiles: [],
        itemCount: preview.report.summary.itemDifferences,
        source: 'excel_compare',
        status: preview.report.status,
        summary: `Excel importado ${file.name} listo para revision antes de sincronizar.`,
      });
    } catch (importError) {
      setExportFeedback(
        importError instanceof Error
          ? `No fue posible leer el Excel importado: ${importError.message}`
          : 'No fue posible leer el Excel importado.',
      );
    }
  };

  const handleApproveExcelImport = async () => {
    if (!excelImportPreview) {
      return;
    }

    if (!isSupabaseConfigured()) {
      setExportFeedback(
        'Supabase aun no esta configurado en este entorno. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY para sincronizar desde Excel.',
      );
      return;
    }

    if (!excelImportPreview.applicable) {
      setExportFeedback(
        'La sincronizacion desde Excel aun no es aplicable. Revisa diferencias estructurales o validaciones pendientes antes de aprobarla.',
      );
      return;
    }

    try {
      const result = await saveAdminMenuDraftsToSupabase(excelImportPreview.changedDrafts, {
        actorLabel: user?.email ?? 'excel-sync-admin',
        changeSource: 'excel_import',
        snapshotKind: 'excel_import_sync',
        snapshotPayload: {
          fileName: excelImportPreview.fileName,
          report: excelImportPreview.report,
          changedDrafts: excelImportPreview.changedDrafts.map((draft) => serializeAllAdminMenuDrafts([draft])[0]),
        },
        snapshotSummary: {
          applicable: excelImportPreview.applicable,
          blockedItems: excelImportPreview.blockedItems,
          changedItems: excelImportPreview.totalChangedItems,
          fileName: excelImportPreview.fileName,
        },
      });
      const nextDrafts = buildAdminMenuDrafts(result.collection.items);

      setCatalogCollection(result.collection);
      setItems(result.collection.items);
      setDrafts(nextDrafts);
      setSelectedDraftKey(nextDrafts[0]?.draftKey ?? null);
      setExcelImportPreview(null);
      setActiveSection('changes');
      setExportFeedback(
        `Supabase sincronizado desde ${excelImportPreview.fileName} con ${result.appliedCount} item${result.appliedCount === 1 ? '' : 's'} aplicado${result.appliedCount === 1 ? '' : 's'}.`,
      );
      registerExcelOperation({
        createdAt: new Date().toISOString(),
        fieldCount: excelImportPreview.report.summary.fieldDifferences,
        fileName: excelImportPreview.fileName,
        generatedFiles: [],
        itemCount: result.appliedCount,
        source: 'excel_import',
        status: 'applied',
        summary: `Sincronizacion aprobada y aplicada a Supabase desde ${excelImportPreview.fileName}.`,
      });
    } catch (saveError) {
      setExportFeedback(
        saveError instanceof Error
          ? `No fue posible sincronizar el Excel hacia Supabase: ${saveError.message}`
          : 'No fue posible sincronizar el Excel hacia Supabase.',
      );
    }
  };

  return (
    <AdminLayout>
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-[0.72rem] uppercase tracking-[0.28em] text-cyanGlow/80">Editor de catalogo</p>
          <h1 className="mt-4 font-display text-[2.5rem] leading-none text-ivory sm:text-[3.3rem]">Menu</h1>
          <p className="mt-4 text-base leading-8 text-mist sm:text-lg">
            Centro operativo del catalogo. Aqui editas el catalogo, revisas cambios y decides cuando guardar de verdad en
            Supabase o sincronizarlo contra Excel.
          </p>
        </div>

        <Link
          to="/admin"
          className="interactive-button w-fit rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08]"
        >
          Volver a admin
        </Link>
        <input
          ref={importSnapshotInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportSnapshot}
          className="hidden"
        />
        <input
          ref={baseExcelInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={handleBaseExcelSelected}
          className="hidden"
        />
        <input
          ref={importExcelInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={handleImportExcelPrepare}
          className="hidden"
        />
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Items totales" value={String(drafts.length)} note="Catalogo operativo cargado desde Supabase o fallback local." />
        <SummaryCard label="Visibles" value={String(visibleCount)} note="Productos que hoy podrian verse en la web." />
        <SummaryCard label="Agotados" value={String(unavailableCount)} note="Items marcados como no disponibles." />
        <SummaryCard
          label="Cambios locales"
          value={String(editedCount)}
          note="Ediciones hechas solo dentro de esta sesion del navegador."
          accent="amber"
        />
        <SummaryCard
          label="Con validaciones pendientes"
          value={String(invalidCount)}
          note="Items que requieren ajuste antes de una futura persistencia."
          accent="rose"
        />
      </section>

      <section className="mt-8 rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-3 sm:p-4">
        <div className="flex flex-wrap gap-2">
          <AdminSectionTab active={activeSection === 'editor'} label="Catalogo" onClick={() => setActiveSection('editor')} />
          <AdminSectionTab active={activeSection === 'changes'} label="Excel y sincronizacion" onClick={() => setActiveSection('changes')} />
        </div>
      </section>

      <div className="mt-8 space-y-8">
        {activeSection === 'editor' ? (
          <>
            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Estado del borrador</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.4rem]">
                    {editedCount
                      ? `${editedCount} item${editedCount === 1 ? '' : 's'} con cambios pendientes`
                      : 'Sin cambios pendientes'}
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Edita el catalogo, filtra productos y trabaja sobre la ficha del item activo sin salir del flujo principal.
                    El borrador se queda local hasta que tu decidas guardarlo o sincronizarlo.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[22rem]">
                  <InlineMetric label="Items editados" value={String(editedCount)} />
                  <InlineMetric label="Items invalidos" value={String(invalidCount)} />
                  <InlineMetric label="Payload listo" value={isPayloadReady ? 'Si' : 'No'} />
                  <InlineMetric label="Persistencia" value="Pendiente" />
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleCreateProductDraft}
                  className="interactive-button rounded-full border border-cyanGlow/28 bg-cyanGlow/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyanGlow"
                >
                  Nuevo producto
                </button>
                <p className="text-sm leading-7 text-mist">
                  Crea un borrador nuevo dentro del catálogo actual y guárdalo luego en Supabase junto con los demás cambios.
                </p>
              </div>
            </section>

            <AdminMenuFilters
              category={filters.category}
              categoryOptions={categorySelectOptions}
              onCategoryChange={(value) => handleFilterChange('category', value)}
              onSearchChange={(value) => handleFilterChange('search', value)}
              onStatusChange={(value) => handleFilterChange('status', value)}
              onSubgroupChange={(value) => handleFilterChange('subgroup', value)}
              search={filters.search}
              status={filters.status}
              subgroup={filters.subgroup}
              subgroupOptions={subgroupSelectOptions}
            />

            {isLoading ? (
              <section className="rounded-[1.9rem] border border-white/10 bg-white/[0.03] p-6 text-mist">
                Cargando productos del menu...
              </section>
            ) : null}

            {!isLoading && error ? (
              <section className="rounded-[1.9rem] border border-rose-200/15 bg-rose-200/10 p-6 text-rose-100">
                Error al cargar el menu: {error}
              </section>
            ) : null}

            {!isLoading && !error ? (
              <div className="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(24rem,1.1fr)] xl:items-start">
                <div className="min-w-0 space-y-4 xl:relative xl:z-10">
                  <div className="rounded-[1.6rem] border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-mist sm:px-5">
                    Mostrando <span className="text-ivory">{filteredDrafts.length}</span> productos · Categoria{' '}
                    <span className="text-ivory">
                      {filters.category === 'all' ? 'Todas' : humanizeAdminLabel(filters.category)}
                    </span>{' '}
                    · Subgrupo <span className="text-ivory">{filters.subgroup === 'all' ? 'Todos' : filters.subgroup}</span>
                  </div>

                  {selectedItem && !selectedItemMatchesFilters ? (
                    <div className="rounded-[1.5rem] border border-amberGlow/20 bg-amberGlow/10 px-4 py-4 text-sm text-mist sm:px-5">
                      <p className="font-semibold text-ivory">
                        Estas editando "{selectedItem.name || selectedItem.slug}", pero ya no coincide con los filtros activos.
                      </p>
                      <p className="mt-2 leading-7">
                        El item sigue abierto en el panel derecho para que no pierdas contexto. Puedes ajustar los filtros o
                        volver a mostrarlo en la lista.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={focusSelectedItemInFilters}
                          className="interactive-button rounded-full border border-amberGlow/20 bg-amberGlow/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-amberGlow"
                        >
                          Mostrar item en lista
                        </button>
                        <button
                          type="button"
                          onClick={() => setFilters(initialFilters)}
                          className="interactive-button rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-ivory"
                        >
                          Limpiar filtros
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <AdminMenuItemList
                    items={filteredDrafts}
                    onSelect={setSelectedDraftKey}
                    selectedDraftKey={selectedDraftKey}
                  />
                </div>

                <div className="min-w-0 xl:relative xl:z-0">
                  <AdminMenuEditorPanel
                    item={selectedItem}
                    changedFields={selectedChangedFields}
                    onChange={handleItemFieldChange}
                    onResetAll={resetAllChanges}
                    onResetItem={resetSelectedItem}
                    validation={selectedValidation}
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {activeSection === 'changes' ? (
          <>
            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Preparar aplicacion</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Estacion de control del catalogo
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Esta capa muestra exactamente que se aplicaria al catalogo oficial si hoy conectaras una accion real
                    de persistencia.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[24rem]">
                  <InlineMetric label="Items listos" value={String(adminApplyPayload.summary.readyItems)} />
                  <InlineMetric label="Items bloqueados" value={String(adminApplyPayload.summary.blockedItems)} />
                  <InlineMetric label="Aplicable" value={adminApplyPayload.summary.applicable ? 'Si' : 'No'} />
                  <InlineMetric label="Items a aplicar" value={String(adminApplyPayload.summary.totalChangedItems)} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35">
                  <div className="border-b border-white/10 px-4 py-4 sm:px-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Cambios que se aplicarian</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Revisa item por item que campos cambiarian y si el cambio ya esta listo o sigue bloqueado.
                    </p>
                  </div>

                  <div className="max-h-[30rem] overflow-y-auto divide-y divide-white/10">
                    {adminApplyPayload.items.length ? (
                      adminApplyPayload.items.map((item) => (
                        <div key={item.draftKey} className="px-4 py-4 sm:px-5">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate font-semibold text-ivory">{item.itemName}</h3>
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                                  {item.itemSlug}
                                </span>
                                <span
                                  className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                                    item.status === 'ready'
                                      ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                                      : 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                                  }`}
                                >
                                  {item.status === 'ready' ? 'Listo para aplicar' : 'Bloqueado'}
                                </span>
                              </div>

                              <div className="mt-3 space-y-3">
                                {item.changedFields.map((fieldChange) => (
                                  <div key={`${item.draftKey}-${fieldChange.field}`} className="rounded-[1.15rem] border border-white/10 bg-white/[0.03] p-3">
                                    <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">
                                      {fieldChange.fieldLabel}
                                    </p>
                                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                                      <div>
                                        <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">Antes</p>
                                        <p className="mt-1 text-sm leading-6 text-mist">{fieldChange.before}</p>
                                      </div>
                                      <div>
                                        <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">Despues</p>
                                        <p className="mt-1 text-sm leading-6 text-ivory">{fieldChange.after}</p>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>

                              {item.status === 'blocked' ? (
                                <p className="mt-3 text-xs leading-6 text-rose-100">
                                  {Object.values(item.validationErrors).join(' ')}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-sm text-mist sm:px-5">
                        Aun no hay cambios para preparar una aplicacion al catalogo.
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Estado de aplicacion</p>
                    <div className="mt-4 space-y-3 text-sm leading-7 text-mist">
                      <ReviewStatusRow
                        label="Hay cambios listos"
                        ok={adminApplyPayload.summary.readyItems > 0}
                        okText="Si"
                        pendingText="No"
                      />
                      <ReviewStatusRow
                        label="No hay items bloqueados"
                        ok={adminApplyPayload.summary.blockedItems === 0}
                        okText="Si"
                        pendingText="No"
                      />
                      <ReviewStatusRow
                        label="Payload aplicable"
                        ok={adminApplyPayload.summary.applicable}
                        okText="Si"
                        pendingText="Revisar"
                      />
                      <ReviewStatusRow
                        label="Accion local al JSON disponible"
                        ok={adminApplyPayload.summary.readyItems > 0}
                        okText="Si"
                        pendingText="Pendiente"
                      />
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Guardar en Supabase</p>
                    <p className="mt-3 text-sm leading-7 text-mist">
                      Esta es la nueva persistencia principal para GitHub Pages. Guarda solo cambios validos y registra trazabilidad basica en Supabase.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleSaveToSupabase}
                        disabled={!adminApplyPayload.summary.readyItems || !isSupabaseConfigured()}
                        className="interactive-button rounded-full border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Guardar cambios reales en Supabase
                      </button>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-mist">
                        {isSupabaseConfigured() ? 'Supabase listo' : 'Faltan env vars'}
                      </span>
                    </div>
                    <div className="mt-4 rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-xs leading-6 text-mist">
                      Lectura publica: Supabase primero, con fallback temporal a <span className="text-ivory">menu.json</span>.
                      <br />
                      Guardado admin: Supabase real, sin depender del filesystem local.
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Excel y sincronizacion</p>
                    <p className="mt-3 text-sm leading-7 text-mist">
                      Compara el estado actual de Supabase contra el Excel base, genera un Excel derivado desde la app o
                      importa un Excel actualizado para decidir si Supabase debe sincronizarse.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenBaseExcel('compare')}
                        className="interactive-button rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-ivory"
                      >
                        Comparar con Excel base
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenBaseExcel('derive')}
                        className="interactive-button rounded-full border border-cyanGlow/20 bg-cyanGlow/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-cyanGlow"
                      >
                        Generar Excel derivado
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenExcelImport}
                        className="interactive-button rounded-full border border-amberGlow/20 bg-amberGlow/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-amberGlow"
                      >
                        Importar Excel y preparar sincronizacion
                      </button>
                    </div>
                    {exportFeedback ? <p className="mt-4 text-xs leading-6 text-cyanGlow/85">{exportFeedback}</p> : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Revision antes de guardar</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    {editedCount
                      ? `${editedCount} item${editedCount === 1 ? '' : 's'} listo${editedCount === 1 ? '' : 's'} para revisar`
                      : 'Sin cambios para persistir'}
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Esta vista resume exactamente que cambiaria en una persistencia real: items editados, campos tocados,
                    errores activos y estado final del payload.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-3 xl:min-w-[24rem]">
                  <InlineMetric label="Items con cambios" value={String(editedCount)} />
                  <InlineMetric label="Con errores" value={String(invalidCount)} />
                  <InlineMetric label="Listos para guardar" value={isPayloadReady ? 'Si' : 'No'} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35">
                  <div className="border-b border-white/10 px-4 py-4 sm:px-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Resumen de cambios</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Selecciona un item para volver al editor con foco en ese draft.
                    </p>
                  </div>

                  <div className="max-h-[26rem] overflow-y-auto divide-y divide-white/10">
                    {changedDraftSummaries.length ? (
                      changedDraftSummaries.map(({ draftKey, changedFields, fieldCount, hasErrors, item, validation }) => (
                        <button
                          key={draftKey}
                          type="button"
                          onClick={() => {
                            setSelectedDraftKey(draftKey);
                            setActiveSection('editor');
                          }}
                          className="block w-full px-4 py-4 text-left transition hover:bg-white/[0.03] sm:px-5"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate font-semibold text-ivory">{item.name}</h3>
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                                  {humanizeAdminLabel(getAdminMenuCategory(item))}
                                </span>
                                {hasErrors ? (
                                  <span className="rounded-full border border-rose-200/20 bg-rose-200/10 px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-rose-100">
                                    Revisar
                                  </span>
                                ) : (
                                  <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-emerald-200">
                                    Listo
                                  </span>
                                )}
                              </div>
                              <p className="mt-2 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                {getAdminMenuSubgroup(item)}
                              </p>
                              <p className="mt-3 text-sm leading-7 text-mist">
                                Campos: <span className="text-ivory">{changedFields.join(', ')}</span>
                              </p>
                              {!validation.isValid ? (
                                <p className="mt-2 text-xs leading-6 text-rose-100">
                                  {Object.values(validation.errors).join(' ')}
                                </p>
                              ) : null}
                            </div>

                            <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                              {fieldCount} cambio{fieldCount === 1 ? '' : 's'}
                            </div>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-sm text-mist sm:px-5">
                        Aun no hay items modificados para revisar antes de un futuro guardado.
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Checklist de persistencia</p>
                    <div className="mt-4 space-y-3 text-sm leading-7 text-mist">
                      <ReviewStatusRow label="Hay cambios pendientes" ok={editedCount > 0} okText="Si" pendingText="No" />
                      <ReviewStatusRow label="Todos los drafts son validos" ok={invalidCount === 0} okText="Si" pendingText="No" />
                      <ReviewStatusRow label="Payload serializado disponible" ok={pendingPayloadPreview.length > 0} okText="Si" pendingText="No" />
                      <ReviewStatusRow label="Accion de guardado real conectada" ok={false} okText="Si" pendingText="Pendiente" />
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Siguiente integracion</p>
                    <p className="mt-3 text-sm leading-7 text-mist">
                      Este bloque ya separa claramente revision, validacion y payload. La siguiente accion real puede
                      conectarse aqui como <span className="text-ivory">saveDrafts(payload)</span> hacia archivo, JSON o backend.
                    </p>
                    <div className="mt-4 rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-xs leading-6 text-mist">
                      Estado actual: listo para integrar una accion de guardado sin rehacer el editor.
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Importar Excel con aprobacion</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Revision antes de sincronizar Supabase
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Cuando importas un Excel, el sistema no sobrescribe nada de inmediato. Primero arma el diff contra Supabase,
                    valida el payload y solo despues te deja aprobar la sincronizacion.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[24rem]">
                  <InlineMetric label="Archivo preparado" value={excelImportPreview?.fileName ?? 'Ninguno'} />
                  <InlineMetric label="Items importados" value={String(excelImportPreview?.totalChangedItems ?? 0)} />
                  <InlineMetric label="Bloqueados" value={String(excelImportPreview?.blockedItems ?? 0)} />
                  <InlineMetric label="Aplicable" value={excelImportPreview?.applicable ? 'Si' : 'No'} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Resumen de sincronizacion</p>
                    <span
                      className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                        excelImportPreview?.applicable
                          ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                          : 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                      }`}
                    >
                      {excelImportPreview?.applicable ? 'Lista para aprobar' : 'Requiere revision'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    {excelImportPreview
                      ? `El archivo ${excelImportPreview.fileName} produjo ${excelImportPreview.totalChangedItems} item${excelImportPreview.totalChangedItems === 1 ? '' : 's'} con cambios frente a Supabase.`
                      : 'Importa un Excel actualizado para preparar su sincronizacion con Supabase sin aplicar cambios ciegos.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleOpenExcelImport}
                      className="interactive-button rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-ivory"
                    >
                      Seleccionar Excel
                    </button>
                    <button
                      type="button"
                      onClick={handleApproveExcelImport}
                      disabled={!excelImportPreview?.applicable}
                      className={`interactive-button rounded-full px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] ${
                        excelImportPreview?.applicable
                          ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                          : 'cursor-not-allowed border border-white/10 bg-white/[0.03] text-mist/70'
                      }`}
                    >
                      Aprobar y sincronizar Supabase
                    </button>
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Cambios legibles del Excel importado</p>
                  <div className="mt-4 max-h-[20rem] overflow-y-auto space-y-3">
                    {(excelImportPreview?.changedReadableChanges ?? []).length ? (
                      excelImportPreview!.changedReadableChanges.map((change, index) => (
                        <div key={`${change.draftKey}-${change.field}-${index}`} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-ivory">{change.itemName}</span>
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-cyanGlow/85">
                              {change.fieldLabel}
                            </span>
                          </div>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-mist">{change.itemSlug}</p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl border border-white/10 bg-obsidian/45 p-3">
                              <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">Supabase actual</p>
                              <p className="mt-2 text-sm leading-6 text-mist">{change.before}</p>
                            </div>
                            <div className="rounded-xl border border-cyanGlow/20 bg-cyanGlow/10 p-3">
                              <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">Excel importado</p>
                              <p className="mt-2 text-sm leading-6 text-ivory">{change.after}</p>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                        Aun no hay un Excel importado preparado para sincronizacion.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Estado frente al Excel</p>
                  <p className="mt-2 text-sm leading-7 text-mist">
                    Vista corta del estado de sincronizacion para saber rapido si Supabase esta alineado, tiene cambios
                    pendientes o quedo desincronizado frente al archivo comparado.
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] ${
                    excelSyncReport?.status === 'synced'
                      ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                      : excelSyncReport?.status === 'pending'
                        ? 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                        : excelSyncReport?.status === 'desynced'
                          ? 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                          : 'border border-white/10 bg-white/[0.04] text-mist'
                  }`}
                >
                  {excelSyncReport
                    ? excelSyncReport.status === 'synced'
                      ? 'Sincronizado'
                      : excelSyncReport.status === 'pending'
                        ? 'Cambios pendientes'
                        : 'Desincronizado'
                    : 'Sin comparar'}
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <InlineMetric label="Archivo" value={excelSyncReport?.fileName ?? 'Sin leer'} />
                <InlineMetric label="Excel base" value={excelSyncReport?.baseExcelModifiedAt ? formatSnapshotDate(excelSyncReport.baseExcelModifiedAt) : 'Sin leer'} />
                <InlineMetric label="Comparacion" value={excelSyncReport?.generatedAt ? formatSnapshotDate(excelSyncReport.generatedAt) : 'Pendiente'} />
                <InlineMetric label="Hojas afectadas" value={String(excelSyncReport?.summary.sheetDifferences ?? 0)} />
                <InlineMetric label="Items con diferencias" value={String(excelSyncReport?.summary.itemDifferences ?? 0)} />
                <InlineMetric label="Campos distintos" value={String(excelSyncReport?.summary.fieldDifferences ?? 0)} />
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Diferencias legibles con Excel</p>
                  <p className="mt-2 text-sm leading-7 text-mist">
                    Revision humana de los campos que no coinciden entre Supabase y el archivo comparado.
                  </p>
                </div>
                <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                  {excelSyncReport?.summary.fieldDifferences ?? 0} diferencia{(excelSyncReport?.summary.fieldDifferences ?? 0) === 1 ? '' : 's'}
                </div>
              </div>
              <div className="mt-4 max-h-[28rem] overflow-y-auto space-y-3">
                {(excelSyncReport?.items ?? []).length ? (
                  excelSyncReport!.items.map((item) => (
                    <div key={item.draftKey} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ivory">{item.itemName}</span>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                          {item.hojaOrigen}
                        </span>
                        <span
                          className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                            item.status === 'pending'
                              ? 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                              : 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                          }`}
                        >
                          {item.status === 'pending' ? 'Pendiente' : 'Desincronizado'}
                        </span>
                      </div>
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-mist">
                        {item.itemSlug} · {item.tipo} · {item.subgrupo}
                      </p>
                      <div className="mt-3 space-y-3">
                        {item.differences.length ? (
                          item.differences.map((diff) => (
                            <div key={`${item.draftKey}-${diff.field}`} className="rounded-xl border border-white/10 bg-obsidian/45 p-3">
                              <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">{diff.fieldLabel}</p>
                              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                                <div>
                                  <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">
                                    {excelSyncReport?.referenceLabel ?? 'Referencia'}
                                  </p>
                                  <p className="mt-1 text-sm leading-6 text-mist">{diff.before}</p>
                                </div>
                                <div>
                                  <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">
                                    {excelSyncReport?.currentLabel ?? 'Actual'}
                                  </p>
                                  <p className="mt-1 text-sm leading-6 text-ivory">{diff.after}</p>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-obsidian/45 p-3 text-sm text-mist">
                            Este item no tiene diff de campos, pero si una inconsistencia estructural frente al Excel base.
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                    Cuando hagas la comparacion, aqui apareceran las diferencias legibles frente al Excel base.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Cambios legibles del borrador actual</p>
              <p className="mt-2 text-sm leading-7 text-mist">
                Revision humana de lo que cambiaste, sin depender solo del JSON crudo.
              </p>
              <div className="mt-4 max-h-[28rem] overflow-y-auto space-y-3">
                {currentReadableChanges.length ? (
                  currentReadableChanges.map((change, index) => (
                    <div key={`${change.draftKey}-${change.field}-${index}`} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ivory">{change.itemName}</span>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-cyanGlow/85">
                          {change.fieldLabel}
                        </span>
                      </div>
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-mist">{change.itemSlug}</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-white/10 bg-obsidian/45 p-3">
                          <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">Antes</p>
                          <p className="mt-2 text-sm leading-6 text-mist">{change.before}</p>
                        </div>
                        <div className="rounded-xl border border-cyanGlow/20 bg-cyanGlow/10 p-3">
                          <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">Despues</p>
                          <p className="mt-2 text-sm leading-6 text-ivory">{change.after}</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                    Aun no hay cambios legibles para mostrar.
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}

        {false ? (
          <>
            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Snapshots</p>
                  <p className="mt-2 text-sm leading-7 text-mist">
                    Guarda o importa copias de seguridad del borrador y conserva una bitacora de la sesion.
                  </p>
                  <p className="mt-2 text-xs leading-6 text-mist">
                    Guardar snapshot genera un JSON formal del borrador actual con metadata, filtros activos y cambios serializados.
                  </p>
                  {exportFeedback ? (
                    <p className="mt-3 text-xs leading-6 text-cyanGlow/85">{exportFeedback}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <button
                    type="button"
                    onClick={handleOpenImportSnapshot}
                    className="interactive-button rounded-full border border-cyanGlow/20 bg-transparent px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-cyanGlow"
                  >
                    Importar snapshot
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveSnapshot}
                    disabled={!pendingPayloadPreview.length}
                    className="interactive-button rounded-full border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Guardar snapshot
                  </button>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Excel base y sincronizacion</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Estado frente a ZafiroMenu.xlsx
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Selecciona el Excel base para comparar contra el estado vivo del catalogo en Supabase y, si lo necesitas,
                    genera un Excel derivado con la misma estructura del archivo original pero con los cambios actuales ya aplicados.
                  </p>
                  {exportFeedback ? (
                    <p className="mt-3 text-xs leading-6 text-cyanGlow/85">{exportFeedback}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <button
                    type="button"
                    onClick={() => handleOpenBaseExcel('compare')}
                    className="interactive-button rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-ivory"
                  >
                    Comparar con Excel base
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenBaseExcel('derive')}
                    className="interactive-button rounded-full border border-cyanGlow/20 bg-cyanGlow/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-cyanGlow"
                  >
                    Generar Excel derivado
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenExcelImport}
                    className="interactive-button rounded-full border border-amberGlow/20 bg-amberGlow/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-amberGlow"
                  >
                    Importar Excel y preparar sincronizacion
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Estado de sincronizacion</p>
                    <span
                      className={`rounded-full px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.18em] ${
                        excelSyncReport?.status === 'synced'
                          ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                          : excelSyncReport?.status === 'pending'
                            ? 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                            : excelSyncReport?.status === 'desynced'
                              ? 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                              : 'border border-white/10 bg-white/[0.04] text-mist'
                      }`}
                    >
                      {excelSyncReport
                        ? excelSyncReport?.status === 'synced'
                          ? 'Sincronizado'
                          : excelSyncReport?.status === 'pending'
                            ? 'Cambios pendientes'
                            : 'Desincronizado'
                        : 'Sin comparar'}
                    </span>
                  </div>

                  <p className="mt-3 text-sm leading-7 text-mist">
                    {excelSyncReport
                      ? excelSyncReport?.status === 'synced'
                        ? `${excelSyncReport?.currentLabel ?? 'Actual'} y ${excelSyncReport?.referenceLabel ?? 'Referencia'} coinciden hoja por hoja y campo por campo.`
                        : excelSyncReport?.status === 'pending'
                          ? `Hay diferencias controladas entre ${(excelSyncReport?.currentLabel ?? 'Actual').toLowerCase()} y ${(excelSyncReport?.referenceLabel ?? 'Referencia').toLowerCase()}.`
                          : `Hay diferencias estructurales o elementos sin correspondencia entre ${(excelSyncReport?.currentLabel ?? 'Actual').toLowerCase()} y ${(excelSyncReport?.referenceLabel ?? 'Referencia').toLowerCase()}.`
                      : 'Aun no hay una comparacion cargada. Ejecuta la comparacion o importa un Excel para ver el estado real de sincronizacion.'}
                  </p>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <InlineMetric label="Archivo" value={excelSyncReport?.fileName ?? 'Sin leer'} />
                    <InlineMetric label="Excel base" value={excelSyncReport?.baseExcelModifiedAt ? formatSnapshotDate(excelSyncReport!.baseExcelModifiedAt) : 'Sin leer'} />
                    <InlineMetric label="Comparacion" value={excelSyncReport?.generatedAt ? formatSnapshotDate(excelSyncReport!.generatedAt) : 'Pendiente'} />
                    <InlineMetric label="Hojas afectadas" value={String(excelSyncReport?.summary.sheetDifferences ?? 0)} />
                    <InlineMetric label="Items con diferencias" value={String(excelSyncReport?.summary.itemDifferences ?? 0)} />
                    <InlineMetric label="Campos distintos" value={String(excelSyncReport?.summary.fieldDifferences ?? 0)} />
                    <InlineMetric label="Drafts invalidos" value={String(excelSyncReport?.summary.invalidDrafts ?? invalidCount)} />
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Motivo del estado</p>
                  <div className="mt-4 space-y-3 text-sm leading-7 text-mist">
                    <ReviewStatusRow
                      label="Sin diferencias de hojas"
                      ok={(excelSyncReport?.sheetNamesOnlyInSource.length ?? 0) === 0 && (excelSyncReport?.sheetNamesOnlyInReference.length ?? 0) === 0}
                      okText="Si"
                      pendingText="No"
                    />
                    <ReviewStatusRow
                      label="Sin items faltantes"
                      ok={(excelSyncReport?.summary.missingInSource ?? 0) === 0 && (excelSyncReport?.summary.missingInReference ?? 0) === 0}
                      okText="Si"
                      pendingText="No"
                    />
                    <ReviewStatusRow
                      label="Catalogo alineado al archivo comparado"
                      ok={excelSyncReport?.status === 'synced'}
                      okText="Si"
                      pendingText="No"
                    />
                  </div>
                  {excelSyncReport ? (
                    <div className="mt-4 rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-xs leading-6 text-mist">
                      Solo en {(excelSyncReport?.currentLabel ?? 'Actual').toLowerCase()}:{' '}
                      {excelSyncReport?.sheetNamesOnlyInSource?.length ? excelSyncReport?.sheetNamesOnlyInSource?.join(', ') : 'Ninguna'}
                      <br />
                      Solo en {(excelSyncReport?.referenceLabel ?? 'Referencia').toLowerCase()}:{' '}
                      {excelSyncReport?.sheetNamesOnlyInReference?.length ? excelSyncReport?.sheetNamesOnlyInReference?.join(', ') : 'Ninguna'}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Trazabilidad de sincronizacion Excel</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Bitacora de exportaciones, comparaciones e importaciones
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Cada operacion importante deja un rastro local de fecha, origen, archivo, items afectados y estado final de la revision.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[24rem]">
                  <InlineMetric label="Operaciones" value={String(excelOperationHistory.length)} />
                  <InlineMetric label="Ultima accion" value={excelOperationHistory[0] ? formatSnapshotDate(excelOperationHistory[0].createdAt) : 'Sin acciones'} />
                  <InlineMetric label="Ultimo origen" value={excelOperationHistory[0]?.source ?? 'Ninguno'} />
                  <InlineMetric label="Ultimo estado" value={excelOperationHistory[0]?.status ?? 'Sin estado'} />
                </div>
              </div>

              <div className="mt-5 max-h-[22rem] overflow-y-auto space-y-3">
                {excelOperationHistory.length ? (
                  excelOperationHistory.map((entry) => (
                    <div key={entry.id} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-ivory">{entry.summary}</span>
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                              {entry.source}
                            </span>
                            <span
                              className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                                entry.status === 'synced' || entry.status === 'applied'
                                  ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                                  : entry.status === 'pending'
                                    ? 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                                    : 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                              }`}
                            >
                              {entry.status}
                            </span>
                          </div>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                            {formatSnapshotDate(entry.createdAt)}
                          </p>
                          <p className="mt-3 text-sm leading-7 text-mist">
                            Archivo: {entry.fileName ?? 'Sin archivo asociado'} · Items: {entry.itemCount} · Campos: {entry.fieldCount}
                          </p>
                        </div>

                        <div className="min-w-[12rem] rounded-[1rem] border border-white/10 bg-obsidian/45 px-3 py-3 text-xs leading-6 text-mist">
                          {entry.generatedFiles.length ? entry.generatedFiles.join(' · ') : 'Sin archivos generados'}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                    Aun no hay operaciones de sincronizacion Excel registradas en esta sesion.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Historial y trazabilidad</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Bitacora del borrador
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Revisa snapshots guardados o importados durante esta sesion y valida cambios en un formato legible antes
                    de pensar en aplicar algo real al catalogo o al Excel.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[24rem]">
                  <InlineMetric label="Snapshots en sesion" value={String(snapshotHistory.length)} />
                  <InlineMetric label="Cambios legibles" value={String(currentReadableChanges.length)} />
                  <InlineMetric
                    label="Ultima accion"
                    value={snapshotHistory[0]?.source === 'imported' ? 'Importado' : snapshotHistory[0] ? 'Guardado' : 'Sin acciones'}
                  />
                  <InlineMetric label="Base para Excel" value="Lista" />
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35">
                  <div className="border-b border-white/10 px-4 py-4 sm:px-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Snapshots de la sesion</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Cada entrada conserva fecha, estado y resumen de lo que se exporto o importo.
                    </p>
                  </div>

                  <div className="max-h-[28rem] overflow-y-auto divide-y divide-white/10">
                    {snapshotHistory.length ? (
                      snapshotHistory.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => setSelectedHistoryEntryId(entry.id)}
                          className={`block w-full px-4 py-4 text-left transition sm:px-5 ${
                            selectedHistoryEntry?.id === entry.id ? 'bg-cyanGlow/8' : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-ivory">
                                  {entry.source === 'saved' ? 'Snapshot guardado' : 'Snapshot importado'}
                                </h3>
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                                  {entry.snapshot.summary.editedItems} item{entry.snapshot.summary.editedItems === 1 ? '' : 's'}
                                </span>
                                <span
                                  className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                                    entry.snapshot.summary.payloadReady
                                      ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
                                      : 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                                  }`}
                                >
                                  {entry.snapshot.summary.payloadReady ? 'Listo' : 'Revisar'}
                                </span>
                              </div>
                              <p className="mt-2 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                {formatSnapshotDate(entry.createdAt)}
                              </p>
                              <p className="mt-3 text-sm leading-7 text-mist">
                                {entry.fileName ? `Archivo: ${entry.fileName}` : 'Archivo sin nombre asociado'}
                              </p>
                              <p className="mt-2 text-xs leading-6 text-mist">
                                Errores: {entry.snapshot.summary.invalidItems} · Cambios legibles: {entry.changes.length}
                                {entry.source === 'imported' && entry.missingCount !== undefined
                                  ? ` · Restaurados: ${entry.restoredCount ?? 0} · Sin coincidencia: ${entry.missingCount}`
                                  : ''}
                              </p>
                            </div>

                            <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                              {entry.source === 'saved' ? 'Sesion' : 'Importado'}
                            </div>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-sm text-mist sm:px-5">
                        Aun no hay snapshots en esta sesion. Cuando guardes o importes uno, aparecera aqui como bitacora.
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Cambios legibles del snapshot</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Vista pensada para revisar cambios delicados del snapshot seleccionado sin depender solo del JSON crudo.
                    </p>
                    <div className="mt-4 max-h-[22rem] overflow-y-auto space-y-3">
                      {(selectedHistoryEntry?.changes ?? []).length ? (
                        selectedHistoryEntry!.changes.map((change, index) => (
                          <div key={`${change.draftKey}-${change.field}-${index}`} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-ivory">{change.itemName}</span>
                              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-cyanGlow/85">
                                {change.fieldLabel}
                              </span>
                            </div>
                            <p className="mt-2 text-xs uppercase tracking-[0.18em] text-mist">{change.itemSlug}</p>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <div className="rounded-xl border border-white/10 bg-obsidian/45 p-3">
                                <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">Antes</p>
                                <p className="mt-2 text-sm leading-6 text-mist">{change.before}</p>
                              </div>
                              <div className="rounded-xl border border-cyanGlow/20 bg-cyanGlow/10 p-3">
                                <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">Despues</p>
                                <p className="mt-2 text-sm leading-6 text-ivory">{change.after}</p>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                          Selecciona un snapshot del historial para revisar sus cambios legibles.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Puente hacia Excel</p>
                    <p className="mt-3 text-sm leading-7 text-mist">
                      Esta bitacora ya deja separados los cambios por item, campo, valor anterior y valor nuevo. Eso prepara
                      bien una futura salida de revision o aplicacion controlada frente a la fuente del catalogo.
                    </p>
                    <ul className="mt-4 space-y-2 text-sm leading-7 text-mist">
                      <li>Permite revisar cambios delicados antes de aplicarlos.</li>
                      <li>Facilita exportar una lista clara para comparar con Excel.</li>
                      <li>Deja lista la base para una futura capa de "aplicar cambios al catalogo".</li>
                    </ul>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Diferencias legibles con Excel</p>
                  <p className="mt-2 text-sm leading-7 text-mist">
                    Revision humana de que campos ya no coinciden entre el archivo comparado y el estado actual del catalogo. Esto ayuda a detectar rapido cambios delicados o no esperados.
                  </p>
                </div>
                <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                  {excelSyncReport?.summary.fieldDifferences ?? 0} diferencia{(excelSyncReport?.summary.fieldDifferences ?? 0) === 1 ? '' : 's'}
                </div>
              </div>

              <div className="mt-4 max-h-[28rem] overflow-y-auto space-y-3">
                {(excelSyncReport?.items ?? []).length ? (
                  excelSyncReport!.items.map((item) => (
                    <div key={item.draftKey} className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ivory">{item.itemName}</span>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                          {item.hojaOrigen}
                        </span>
                        <span
                          className={`rounded-full px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] ${
                            item.status === 'pending'
                              ? 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
                              : 'border border-rose-200/20 bg-rose-200/10 text-rose-100'
                          }`}
                        >
                          {item.status === 'pending' ? 'Pendiente' : 'Desincronizado'}
                        </span>
                      </div>
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-mist">
                        {item.itemSlug} · {item.tipo} · {item.subgrupo}
                      </p>
                      <div className="mt-3 space-y-3">
                        {item.differences.length ? (
                          item.differences.map((diff) => (
                            <div key={`${item.draftKey}-${diff.field}`} className="rounded-xl border border-white/10 bg-obsidian/45 p-3">
                              <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">{diff.fieldLabel}</p>
                              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                                <div>
                                  <p className="text-[0.58rem] uppercase tracking-[0.16em] text-mist">
                                    {excelSyncReport?.referenceLabel ?? 'Referencia'}
                                  </p>
                                  <p className="mt-1 text-sm leading-6 text-mist">{diff.before}</p>
                                </div>
                                <div>
                                  <p className="text-[0.58rem] uppercase tracking-[0.16em] text-cyanGlow/85">
                                    {excelSyncReport?.currentLabel ?? 'Actual'}
                                  </p>
                                  <p className="mt-1 text-sm leading-6 text-ivory">{diff.after}</p>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-obsidian/45 p-3 text-sm text-mist">
                            Este item no tiene diff de campos, pero si una inconsistencia estructural frente al Excel base.
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                    Cuando hagas la comparacion, aqui apareceran las diferencias legibles frente al Excel base.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Aplicaciones al catalogo</p>
                  <h2 className="mt-3 font-display text-[2rem] leading-none text-ivory sm:text-[2.35rem]">
                    Respaldo de lo aplicado
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-mist">
                    Cada aplicacion local al JSON deja una traza de respaldo con resumen, cantidad de items afectados y
                    archivos generados para volver sobre el proceso con control.
                  </p>
                </div>

                <div className="grid gap-3 text-sm text-mist sm:grid-cols-2 xl:min-w-[24rem]">
                  <InlineMetric label="Aplicaciones en sesion" value={String(applyHistory.length)} />
                  <InlineMetric label="Ultima aplicacion" value={applyHistory[0] ? formatSnapshotDate(applyHistory[0].createdAt) : 'Sin aplicar'} />
                  <InlineMetric label="Items aplicados" value={String(applyHistory[0]?.artifact.summary.appliedItems ?? 0)} />
                  <InlineMetric label="Salida Excel" value={applyHistory[0] ? 'Generada' : 'Pendiente'} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]">
                <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35">
                  <div className="border-b border-white/10 px-4 py-4 sm:px-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Bitacora de aplicaciones</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Acciones donde el catalogo JSON oficial de la sesion fue actualizado con respaldo previo y posterior.
                    </p>
                  </div>

                  <div className="max-h-[24rem] overflow-y-auto divide-y divide-white/10">
                    {applyHistory.length ? (
                      applyHistory.map((entry) => (
                        <div key={entry.id} className="px-4 py-4 sm:px-5">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-ivory">Aplicacion local al catalogo</h3>
                                <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-emerald-200">
                                  {entry.artifact.summary.appliedItems} item{entry.artifact.summary.appliedItems === 1 ? '' : 's'}
                                </span>
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-mist">
                                  {entry.artifact.summary.changedFields} campo{entry.artifact.summary.changedFields === 1 ? '' : 's'}
                                </span>
                              </div>
                              <p className="mt-2 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                {formatSnapshotDate(entry.createdAt)}
                              </p>
                              <p className="mt-3 text-sm leading-7 text-mist">
                                Archivos actualizados: <span className="text-ivory">public/data/menu.json</span>
                              </p>
                              <p className="mt-2 text-xs leading-6 text-mist">
                                Respaldos generados: {entry.fileTargets.length} archivo{entry.fileTargets.length === 1 ? '' : 's'}
                              </p>
                            </div>

                            <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                              Aplicado
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-sm text-mist sm:px-5">
                        Aun no hay aplicaciones al catalogo JSON en esta sesion. Cuando apliques cambios, la traza aparecera aqui.
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Archivos de respaldo</p>
                    <p className="mt-2 text-sm leading-7 text-mist">
                      Cada aplicacion genera respaldo antes y despues del catalogo, un artefacto completo de aplicacion y la salida pensada para Excel.
                    </p>
                    <div className="mt-4 max-h-[20rem] overflow-y-auto space-y-2">
                      {applyHistory[0]?.fileTargets.length ? (
                        applyHistory[0].fileTargets.map((target) => (
                          <div key={target} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-6 text-mist">
                            {target}
                          </div>
                        ))
                      ) : (
                        <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] p-4 text-sm text-mist">
                          Cuando apliques cambios, veras aqui la lista de archivos generados para respaldo y trazabilidad.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-obsidian/35 p-4 sm:p-5">
                    <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Puente hacia Excel</p>
                    <p className="mt-3 text-sm leading-7 text-mist">
                      La salida de aplicacion ya produce filas por item y campo con valor anterior y nuevo. Eso deja listo el
                      puente para revisar que deberia actualizarse luego en Excel sin escribirle todavia de forma automatica.
                    </p>
                    <ul className="mt-4 space-y-2 text-sm leading-7 text-mist">
                      <li>Respaldo formal del estado previo del catalogo.</li>
                      <li>Catalogo posterior listo para validacion humana.</li>
                      <li>Salida CSV/JSON orientada a filas y campos para Excel.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </AdminLayout>
  );
}

interface SummaryCardProps {
  accent?: 'amber' | 'cyan' | 'rose';
  label: string;
  note: string;
  value: string;
}

function SummaryCard({ accent = 'cyan', label, note, value }: SummaryCardProps) {
  const accentClass =
    accent === 'amber'
      ? 'bg-[linear-gradient(145deg,rgba(255,184,77,0.12),rgba(255,255,255,0.03))] text-amberGlow'
      : accent === 'rose'
        ? 'bg-[linear-gradient(145deg,rgba(251,113,133,0.12),rgba(255,255,255,0.03))] text-rose-200'
        : 'bg-[linear-gradient(145deg,rgba(36,107,255,0.12),rgba(255,255,255,0.03))] text-cyanGlow';

  return (
    <article className={`rounded-[1.6rem] border border-white/10 p-5 shadow-[0_16px_36px_rgba(0,0,0,0.2)] ${accentClass}`}>
      <p className="text-[0.68rem] uppercase tracking-[0.24em]">{label}</p>
      <p className="mt-4 font-display text-[2.2rem] leading-none text-ivory">{value}</p>
      <p className="mt-3 text-sm leading-6 text-mist">{note}</p>
    </article>
  );
}

interface InlineMetricProps {
  label: string;
  value: string;
}

function InlineMetric({ label, value }: InlineMetricProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-obsidian/35 px-4 py-3">
      <p className="text-[0.62rem] uppercase tracking-[0.22em] text-cyanGlow/75">{label}</p>
      <p className="mt-2 text-sm font-medium text-ivory">{value}</p>
    </div>
  );
}

interface ReviewStatusRowProps {
  label: string;
  ok: boolean;
  okText: string;
  pendingText: string;
}

function ReviewStatusRow({ label, ok, okText, pendingText }: ReviewStatusRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <span>{label}</span>
      <span
        className={`rounded-full px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.18em] ${
          ok
            ? 'border border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
            : 'border border-amberGlow/20 bg-amberGlow/10 text-amberGlow'
        }`}
      >
        {ok ? okText : pendingText}
      </span>
    </div>
  );
}

interface AdminSectionTabProps {
  active: boolean;
  label: string;
  onClick: () => void;
}

function AdminSectionTab({ active, label, onClick }: AdminSectionTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`interactive-button rounded-full px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] transition ${
        active
          ? 'border border-cyanGlow/25 bg-cyanGlow/10 text-cyanGlow'
          : 'border border-white/10 bg-white/[0.04] text-mist hover:text-ivory'
      }`}
    >
      {label}
    </button>
  );
}

function ensureActiveFilterOption(
  options: Array<{ label: string; value: string }>,
  activeValue: string,
  getLabel: (value: string) => string,
) {
  if (activeValue === 'all' || options.some((option) => option.value === activeValue)) {
    return options;
  }

  return [
    ...options,
    {
      value: activeValue,
      label: `${getLabel(activeValue)} (sin coincidencias)`,
    },
  ];
}

function formatSnapshotDate(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
