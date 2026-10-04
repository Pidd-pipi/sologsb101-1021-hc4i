/**
 * 册页排布 store（Svelte writable）
 *
 * 职责：
 * - 从 IndexedDB 读取已收录印谱条目 + 印稿形制 + 印石尺寸，组装排布输入；
 * - 调用纯函数引擎 computeLayout 得到页 / 册 / 目录；
 * - 保存排布：先在内存保留上一版，写库失败时回滚并保留「待重试方案」；
 * - 校对标记按页维护；已校对且内容与顺序未变的页沿用原页码。
 *
 * 跨页状态不留在组件：/album 页只读本 store 并调用动作函数。
 */
import { get, writable } from 'svelte/store';
import {
  ALBUM_LAYOUT_RECORD_ID,
  ALBUM_LAYOUT_VERSION,
  createEmptyLayoutRecord,
  DEFAULT_ALBUM_SETTINGS,
  type AlbumEntryInput,
  type AlbumLayout,
  type AlbumLayoutRecord,
  type AlbumRecordPage,
  type AlbumSettings,
} from '$lib/types/album';
import { db, normalizeLayoutRecord } from '$lib/utils/db';
import { parseSizeMm } from '$lib/utils/stone';
import { computeLayout, layoutToRecordPages } from '$lib/utils/albumLayout';

/** 组装排布输入：只取「已收录」条目，按 orderNo、createdAt 升序 */
export async function loadAlbumEntries(): Promise<AlbumEntryInput[]> {
  const [catalogs, designs, stones] = await Promise.all([
    db.catalogs.toArray(),
    db.designs.toArray(),
    db.stones.toArray(),
  ]);
  const designById = new Map(designs.map((design) => [design.id, design]));
  const stoneById = new Map(stones.map((stone) => [stone.id, stone]));

  return catalogs
    .filter((catalog) => catalog.included === 'included')
    .sort((a, b) => (a.orderNo === b.orderNo ? a.createdAt - b.createdAt : a.orderNo - b.orderNo))
    .map((catalog) => {
      const design = designById.get(catalog.designId);
      const stone = stoneById.get(catalog.stoneId) ?? (design ? stoneById.get(design.stoneId) : undefined);
      const size = stone ? parseSizeMm(stone.sizeMm) : { lengthMm: 25, widthMm: 25 };
      const entry: AlbumEntryInput = {
        catalogId: catalog.id,
        orderNo: catalog.orderNo,
        sealText: design?.sealText ?? '（印稿已删除）',
        faceWidthMm: size.lengthMm,
        faceHeightMm: size.widthMm,
        style: design?.style ?? 'zhu',
        borderStyle: design?.borderStyle ?? 'none',
      };
      return entry;
    });
}

/** 读取排布单例记录；旧备份残缺时规范化补齐（不落库，等保存时写回） */
export async function loadLayoutRecord(): Promise<AlbumLayoutRecord> {
  const record = await db.albumLayouts.get(ALBUM_LAYOUT_RECORD_ID);
  if (!record) return createEmptyLayoutRecord({ ...DEFAULT_ALBUM_SETTINGS });
  return normalizeLayoutRecord(record);
}

export interface AlbumState {
  ready: boolean;
  /** 当前生效（已保存）的排布；无已收录条目时为 null */
  layout: AlbumLayout | null;
  /** 库中持久化的上一版记录（用于页码沿用比对与失败回滚） */
  record: AlbumLayoutRecord | null;
  /** 已校对页码集合（全局页号） */
  proofedPageNos: Set<number>;
  /** 草稿设置：尚未保存的纸张 / 边距 / 每册页数调整 */
  draftSettings: AlbumSettings;
  /** 是否有未保存改动 */
  dirty: boolean;
  /** 最近一次保存失败信息（空串表示正常） */
  saveError: string;
  /** 保存失败后保留的待重试方案 */
  pendingRetry: { settings: AlbumSettings; recordPages: AlbumRecordPage[]; proofed: Set<number> } | null;
  /** 上一次重算沿用原页码的页数 */
  lastLockedCount: number;
}

function initialState(): AlbumState {
  return {
    ready: false,
    layout: null,
    record: null,
    proofedPageNos: new Set<number>(),
    draftSettings: { ...DEFAULT_ALBUM_SETTINGS },
    dirty: false,
    saveError: '',
    pendingRetry: null,
    lastLockedCount: 0,
  };
}

export const albumStore = writable<AlbumState>(initialState());

/** 把当前草稿页 + 校对标记组装成「上一版」用于沿用比对 */
function draftPrevious(state: AlbumState): { pages: AlbumRecordPage[] } | null {
  if (state.layout && state.layout.pages.length > 0) {
    return { pages: layoutToRecordPages(state.layout, state.proofedPageNos) };
  }
  return state.record ? { pages: state.record.pages } : null;
}

/** 依据当前条目、草稿设置重算排布（不落库） */
export function recomputeAlbum(entries: AlbumEntryInput[], state: AlbumState): AlbumState {
  // 以「当前草稿页 + 校对标记」为上一版：刚标记的校对即时锁定页码，
  // 内容或顺序变化导致页边界变动时，前缀之后的页顺延并自动取消校对。
  const previous = draftPrevious(state);
  const layout = computeLayout(entries, state.draftSettings, previous);
  // 校对集合中：仍沿用（locked）的页保留；进入重排段的页取消校对
  const validProofed = new Set<number>();
  layout.pages.forEach((page) => {
    if (page.locked && state.proofedPageNos.has(page.pageNo)) validProofed.add(page.pageNo);
  });
  return {
    ...state,
    layout,
    proofedPageNos: validProofed,
    lastLockedCount: layout.lockedPageCount,
    dirty: true,
    saveError: '',
  };
}

/** 从数据库完整刷新（导入 / 重播种 / 首次进入页面时调用） */
export async function refreshAlbum(): Promise<void> {
  const [entries, record] = await Promise.all([loadAlbumEntries(), loadLayoutRecord()]);
  const layout = computeLayout(entries, record.settings, { pages: record.pages });
  // 校对态只保留仍沿用（内容顺序未变）的页；重排段需要重新校对
  const proofed = new Set<number>();
  layout.pages.forEach((page) => {
    if (page.locked) proofed.add(page.pageNo);
  });
  // 当前已收录条目序列与已保存排布不一致（收录 / 撤下 / 换序）时视为待保存
  const savedSignature = record.pages
    .flatMap((page) => page.catalogIds)
    .join('|');
  const currentSignature = entries.map((entry) => entry.catalogId).join('|');
  const dirty = savedSignature !== currentSignature;
  albumStore.set({
    ready: true,
    layout,
    record,
    proofedPageNos: proofed,
    draftSettings: { ...record.settings },
    dirty,
    saveError: '',
    pendingRetry: null,
    lastLockedCount: layout.lockedPageCount,
  });
}

/** 修改草稿设置并重算（不保存） */
export function previewSettings(patch: Partial<AlbumSettings>, entries: AlbumEntryInput[]): void {
  const state = get(albumStore);
  const nextSettings = { ...state.draftSettings, ...patch };
  const next = recomputeAlbum(entries, { ...state, draftSettings: sanitizeSettings(nextSettings) });
  albumStore.set(next);
}

/** 标记 / 取消校对某页（未保存；保存后才参与后续沿用） */
export function setPageProofread(pageNo: number, proofread: boolean, entries: AlbumEntryInput[]): void {
  const state = get(albumStore);
  const proofed = new Set(state.proofedPageNos);
  if (proofread) proofed.add(pageNo);
  else proofed.delete(pageNo);
  albumStore.set(recomputeAlbum(entries, { ...state, proofedPageNos: proofed }));
}

function sanitizeSettings(settings: AlbumSettings): AlbumSettings {
  const maxMargin = Math.min(settings.paperWidthMm, settings.paperHeightMm) / 2 - 1;
  return {
    ...settings,
    marginMm: Math.min(Math.max(0, settings.marginMm), Math.max(0, maxMargin)),
    pagesPerBook: Math.max(1, Math.floor(settings.pagesPerBook)),
  };
}

export interface SaveAlbumResult {
  ok: boolean;
  error: string;
  lockedCount: number;
}

/** 把当前草稿排布写库；失败则回滚内存到上一版，并保留可重试方案 */
export async function saveAlbum(entries: AlbumEntryInput[]): Promise<SaveAlbumResult> {
  const state = get(albumStore);
  if (!state.layout) return { ok: true, error: '', lockedCount: 0 };
  const settings = sanitizeSettings(state.draftSettings);
  const previousSnapshot = snapshotState(state);

  // 当前草稿排布即待保存版本（重算已在预览 / 校对时完成）
  const computed = state.layout.settings === settings ? state.layout : computeLayout(entries, settings, draftPrevious(state));
  const recordPages = layoutToRecordPages(computed, state.proofedPageNos);

  try {
    const now = Date.now();
    const record: AlbumLayoutRecord = {
      id: ALBUM_LAYOUT_RECORD_ID,
      layoutVersion: ALBUM_LAYOUT_VERSION,
      settings,
      pages: recordPages,
      updatedAt: now,
    };
    await db.albumLayouts.put(record);
    albumStore.set({
      ...state,
      layout: computed,
      record,
      draftSettings: settings,
      dirty: false,
      saveError: '',
      pendingRetry: null,
      lastLockedCount: computed.lockedPageCount,
    });
    return { ok: true, error: '', lockedCount: computed.lockedPageCount };
  } catch (err) {
    // 保存失败：恢复上一版排布，保留待重试方案
    albumStore.set(previousSnapshot);
    const message = err instanceof Error ? err.message : '排布写入本地数据库失败';
    albumStore.update((current) => ({
      ...current,
      saveError: message,
      pendingRetry: { settings, recordPages, proofed: new Set(state.proofedPageNos) },
    }));
    return { ok: false, error: message, lockedCount: state.lastLockedCount };
  }
}

function snapshotState(state: AlbumState): AlbumState {
  return {
    ...state,
    proofedPageNos: new Set(state.proofedPageNos),
    pendingRetry: state.pendingRetry
      ? { ...state.pendingRetry, proofed: new Set(state.pendingRetry.proofed) }
      : null,
  };
}

/** 用保存失败时保留的方案重试 */
export async function retrySaveAlbum(entries: AlbumEntryInput[]): Promise<SaveAlbumResult> {
  const state = get(albumStore);
  const pending = state.pendingRetry;
  if (!pending) return { ok: true, error: '', lockedCount: state.lastLockedCount };
  // 恢复保存失败时保留的待重试方案（页 / 设置 / 校对标记原样），再走统一保存
  const layout = computeLayout(entries, pending.settings, { pages: pending.recordPages });
  albumStore.set({
    ...state,
    layout,
    draftSettings: pending.settings,
    proofedPageNos: new Set(pending.proofed),
    dirty: true,
    saveError: '',
  });
  return saveAlbum(entries);
}

/** 丢弃草稿，恢复到已保存的上一版排布 */
export async function discardDraft(entries: AlbumEntryInput[]): Promise<void> {
  const state = get(albumStore);
  if (!state.record) return;
  const layout = computeLayout(entries, state.record.settings, { pages: state.record.pages });
  const proofed = new Set<number>();
  layout.pages.forEach((page) => {
    if (page.locked) proofed.add(page.pageNo);
  });
  albumStore.set({
    ...state,
    layout,
    proofedPageNos: proofed,
    draftSettings: { ...state.record.settings },
    dirty: false,
    saveError: '',
    pendingRetry: null,
    lastLockedCount: layout.lockedPageCount,
  });
}
