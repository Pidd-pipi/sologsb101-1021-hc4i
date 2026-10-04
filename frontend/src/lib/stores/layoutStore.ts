/**
 * 册页排布 store（Svelte writable）
 * 维护当前排布、保存失败待重试版本；收录 / 撤下 / 换序 / 改排布参数后重算并落库。
 * 保存失败时当前排布保持上一版不变，失败版本进入 pendingLayout 供重试。
 */
import { get, writable } from 'svelte/store';
import type { Catalog } from '$lib/types/catalog';
import type { Design } from '$lib/types/design';
import type { Stone } from '$lib/types/stone';
import { DEFAULT_LAYOUT_SETTINGS, LAYOUT_ID, type LayoutSettings, type VolumeLayout } from '$lib/types/layout';
import { db, ensureLayout } from '$lib/utils/db';
import { buildLayoutEntries, computeLayout, entriesHash, normalizeSettings, settingsHash } from '$lib/utils/layout';

export const layout = writable<VolumeLayout | null>(null);
export const layoutReady = writable(false);
export const layoutSaving = writable(false);
/** 保存失败信息（空串表示正常） */
export const layoutError = writable('');
/** 保存失败、等待重试的排布版本 */
export const pendingLayout = writable<VolumeLayout | null>(null);

/** 落库：成功则切换当前排布；失败则保留上一版并把目标版本存入待重试 */
async function persist(target: VolumeLayout): Promise<boolean> {
  layoutSaving.set(true);
  try {
    await db.layouts.put(target);
    layout.set(target);
    pendingLayout.set(null);
    layoutError.set('');
    return true;
  } catch (err) {
    pendingLayout.set(target);
    layoutError.set(err instanceof Error ? err.message : '册页排布保存失败');
    return false;
  } finally {
    layoutSaving.set(false);
  }
}

/** 载入当前排布（库中缺失时由 db.ensureLayout 先补齐，这里兜底再读一次） */
export async function loadLayout(): Promise<void> {
  try {
    let row = await db.layouts.get(LAYOUT_ID);
    if (!row) {
      await ensureLayout();
      row = await db.layouts.get(LAYOUT_ID);
    }
    layout.set(row ?? null);
    layoutError.set('');
  } catch (err) {
    layoutError.set(err instanceof Error ? err.message : '册页排布读取失败');
  } finally {
    layoutReady.set(true);
  }
}

/**
 * 与谱录数据同步：收录 / 撤下 / 换序后重算目录页码与总册数。
 * 条目序列与排布参数均未变时直接跳过（避免校对标记等本地更新触发无谓重排）。
 */
export async function syncLayout(catalogs: Catalog[], designs: Design[], stones: Stone[]): Promise<void> {
  const entries = buildLayoutEntries(catalogs, designs, stones);
  const current = get(layout);
  const settings = current?.settings ?? DEFAULT_LAYOUT_SETTINGS;
  const sourceHash = entriesHash(entries);
  if (
    current &&
    current.sourceHash === sourceHash &&
    settingsHash(current.settings) === settingsHash(settings)
  ) {
    return;
  }
  const next = computeLayout(entries, settings, current, Date.now());
  await persist(next);
}

/** 应用新的排布参数（换纸张 / 改页边距 / 改每册页数）并整体重排 */
export async function updateLayoutSettings(
  rawSettings: LayoutSettings,
  catalogs: Catalog[],
  designs: Design[],
  stones: Stone[],
): Promise<void> {
  const settings = normalizeSettings(rawSettings);
  const entries = buildLayoutEntries(catalogs, designs, stones);
  const next = computeLayout(entries, settings, get(layout), Date.now());
  await persist(next);
}

/** 切换某页校对标记（仅内容页可标记） */
export async function toggleProofread(pageNo: number): Promise<void> {
  const current = get(layout);
  if (!current) return;
  const pages = current.pages.map((page) =>
    page.pageNo === pageNo && page.kind === 'content' ? { ...page, proofread: !page.proofread } : page,
  );
  await persist({ ...current, pages, updatedAt: Date.now() });
}

/** 保存失败后重试：把待重试版本重新落库 */
export async function retrySaveLayout(): Promise<void> {
  const pending = get(pendingLayout);
  if (pending) await persist(pending);
}

/** 导入备份 / 清空重播种后重新从库中载入 */
export async function reloadLayout(): Promise<void> {
  layoutReady.set(false);
  pendingLayout.set(null);
  await loadLayout();
}
