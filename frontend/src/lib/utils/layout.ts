/**
 * 册页排布算法（纯函数，不触碰 IndexedDB）
 * - 每页容量由纸张尺寸、印稿形制（边框式样 + 印面大小）与页边距共同决定
 * - 同一条目不跨页：装不下即换页；每册页数装满即续册
 * - 已校对页在「内容 + 顺序 + 排布参数」未变时沿用原页码，空位以补白页填充，后续页顺延
 */
import type { Catalog } from '$lib/types/catalog';
import type { Design, BorderStyle } from '$lib/types/design';
import type { Stone } from '$lib/types/stone';
import {
  DEFAULT_LAYOUT_SETTINGS,
  LAYOUT_ID,
  PAPER_SIZES,
  type LayoutPage,
  type LayoutSettings,
  type VolumeLayout,
} from '$lib/types/layout';
import { parseSizeMm } from './stone';

/** 参与排布的条目（已收录，按排序号升序） */
export interface LayoutEntryInput {
  catalogId: string;
  /** 条目在版心中的高度（毫米），由印稿形制决定 */
  heightMm: number;
}

/* ------------------------------ 条目高度模型 ------------------------------ */

/** 题签 + 释文行的基础高度（毫米） */
export const ENTRY_BASE_MM = 26;
/** 印蜕框相对印面的放大比例 */
export const FACE_SCALE = 1.15;
/** 印蜕框上下留白（毫米） */
export const FACE_PADDING_MM = 8;
/** 边框式样对印蜕框的加高（毫米）：瓦当圆框最高，借边次之 */
export const BORDER_EXTRA_MM: Record<BorderStyle, number> = {
  none: 0,
  double: 4,
  borrow: 6,
  tile: 12,
};

/** 单条目的版心高度：基础行高 + 印蜕框（印面长边放大）+ 边框加高 */
export function entryHeightMm(design: Design | undefined, stone: Stone | undefined): number {
  const size = stone ? parseSizeMm(stone.sizeMm) : { lengthMm: 25, widthMm: 25, heightMm: 60 };
  const faceMm = Math.max(size.lengthMm, size.widthMm);
  const borderExtra = design ? BORDER_EXTRA_MM[design.borderStyle] : 0;
  return ENTRY_BASE_MM + Math.round(faceMm * FACE_SCALE) + FACE_PADDING_MM + borderExtra;
}

/** 版心可用高度：纸高 − 上下页边距（保底 40mm，防止边距设置过大导致无法排布） */
export function usableHeightMm(settings: LayoutSettings): number {
  const paper = PAPER_SIZES[settings.paperSize] ?? PAPER_SIZES[DEFAULT_LAYOUT_SETTINGS.paperSize];
  return Math.max(40, paper.heightMm - settings.margins.top - settings.margins.bottom);
}

/** 页码 → 册号（页码跨册连续，每册 pagesPerVolume 页） */
export function volumeOfPage(pageNo: number, settings: LayoutSettings): number {
  const per = Math.max(1, Math.floor(settings.pagesPerVolume));
  return Math.floor((pageNo - 1) / per) + 1;
}

/* ------------------------------ 指纹与哈希 ------------------------------ */

/** djb2 字符串哈希（短指纹，足够做内容比对） */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 排布参数指纹：换纸张 / 改边距 / 改每册页数后全部重排，校对页不再沿用 */
export function settingsHash(settings: LayoutSettings): string {
  const { margins } = settings;
  return hashText(
    `${settings.paperSize}|${margins.top},${margins.bottom},${margins.left},${margins.right}|${settings.pagesPerVolume}`,
  );
}

/** 单页内容指纹：条目序列 + 排布参数 */
export function pageFingerprint(entryIds: string[], sHash: string): string {
  return hashText(`${sHash}#${entryIds.join(',')}`);
}

/** 已收录条目序列指纹：收录 / 撤下 / 换序后变化，用于触发重排 */
export function entriesHash(entries: LayoutEntryInput[]): string {
  return hashText(entries.map((entry) => `${entry.catalogId}:${entry.heightMm}`).join('|'));
}

/** 从业务表构建排布输入：仅「已收录」条目，按排序号升序 */
export function buildLayoutEntries(
  catalogs: Catalog[],
  designs: Design[],
  stones: Stone[],
): LayoutEntryInput[] {
  return catalogs
    .filter((catalog) => catalog.included === 'included')
    .sort((a, b) => (a.orderNo === b.orderNo ? a.createdAt - b.createdAt : a.orderNo - b.orderNo))
    .map((catalog) => {
      const design = designs.find((item) => item.id === catalog.designId);
      const stone = stones.find((item) => item.id === catalog.stoneId);
      return { catalogId: catalog.id, heightMm: entryHeightMm(design, stone) };
    });
}

/* ------------------------------ 排布主流程 ------------------------------ */

interface Anchor {
  /** 锚点首条目在新序列中的下标 */
  start: number;
  entryIds: string[];
  /** 沿用的原页码 */
  pageNo: number;
}

/** 在序列中查找连续子序列（从 from 起），返回起始下标；未找到返回 -1 */
function findSubsequence(haystack: string[], needle: string[], from: number): number {
  outer: for (let index = from; index + needle.length <= haystack.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** 收集可沿用的校对锚点：已校对、条目序列在新序列中仍连续出现、页码递增 */
function collectAnchors(entries: LayoutEntryInput[], settings: LayoutSettings, previous: VolumeLayout | null): Anchor[] {
  if (!previous || settingsHash(previous.settings) !== settingsHash(settings)) return [];
  const ids = entries.map((entry) => entry.catalogId);
  const anchors: Anchor[] = [];
  let searchFrom = 0;
  let lastPinned = 0;
  for (const page of previous.pages) {
    if (page.kind !== 'content' || !page.proofread || page.entryIds.length === 0) continue;
    if (page.pageNo <= lastPinned) continue;
    const start = findSubsequence(ids, page.entryIds, searchFrom);
    if (start < 0) continue;
    anchors.push({ start, entryIds: [...page.entryIds], pageNo: page.pageNo });
    searchFrom = start + page.entryIds.length;
    lastPinned = page.pageNo;
  }
  return anchors;
}

/** 计算一段条目按版心高度贪心装页所需的页数（条目不跨页） */
function countSegmentPages(segment: LayoutEntryInput[], usableMm: number): number {
  let count = 0;
  let used = 0;
  for (const entry of segment) {
    if (used > 0 && used + entry.heightMm > usableMm) {
      count += 1;
      used = 0;
    }
    used += entry.heightMm;
  }
  return used > 0 ? count + 1 : count;
}

/**
 * 重排整谱：
 * 1. 已收录条目按序贪心装页，条目不跨页，页满续页，册满续册；
 * 2. 上一版已校对页内容（条目与顺序）未变的，沿用原页码——
 *    前面空出的页以补白页填充；前面装不下时该校对页与后续页一起顺延；
 * 3. 目录页码与总册数随排布结果一并重算。
 */
export function computeLayout(
  entries: LayoutEntryInput[],
  settings: LayoutSettings,
  previous: VolumeLayout | null,
  now: number,
): VolumeLayout {
  const sHash = settingsHash(settings);
  const usableMm = usableHeightMm(settings);
  const heightOf = new Map(entries.map((entry) => [entry.catalogId, entry.heightMm]));
  const anchors = collectAnchors(entries, settings, previous);

  const pages: LayoutPage[] = [];
  let nextPageNo = 1;

  const pushContent = (entryIds: string[], proofread: boolean): void => {
    pages.push({
      pageNo: nextPageNo,
      volumeNo: volumeOfPage(nextPageNo, settings),
      entryIds: [...entryIds],
      kind: 'content',
      proofread,
      usedMm: entryIds.reduce((sum, id) => sum + (heightOf.get(id) ?? 0), 0),
      fingerprint: pageFingerprint(entryIds, sHash),
    });
    nextPageNo += 1;
  };

  const pushFiller = (): void => {
    pages.push({
      pageNo: nextPageNo,
      volumeNo: volumeOfPage(nextPageNo, settings),
      entryIds: [],
      kind: 'filler',
      proofread: false,
      usedMm: 0,
      fingerprint: '',
    });
    nextPageNo += 1;
  };

  /** 贪心装页：当前页装不下该条目即换页（条目永不跨页） */
  const packSegment = (segment: LayoutEntryInput[]): void => {
    let ids: string[] = [];
    let used = 0;
    for (const entry of segment) {
      if (ids.length > 0 && used + entry.heightMm > usableMm) {
        pushContent(ids, false);
        ids = [];
        used = 0;
      }
      ids.push(entry.catalogId);
      used += entry.heightMm;
    }
    if (ids.length > 0) pushContent(ids, false);
  };

  let cursor = 0;
  for (const anchor of anchors) {
    const segment = entries.slice(cursor, anchor.start);
    const need = countSegmentPages(segment, usableMm);
    const available = anchor.pageNo - nextPageNo;
    packSegment(segment);
    if (need <= available) {
      // 锚点页码够放：补白填满空位，校对页沿用原页码
      while (nextPageNo < anchor.pageNo) pushFiller();
    }
    // 否则锚点随顺延后的页码落位（内容仍未变，保留校对标记）
    pushContent(anchor.entryIds, true);
    cursor = anchor.start + anchor.entryIds.length;
  }
  packSegment(entries.slice(cursor));

  const totalPages = pages.length > 0 ? pages[pages.length - 1]?.pageNo ?? 0 : 0;
  const totalVolumes = totalPages === 0 ? 0 : Math.ceil(totalPages / Math.max(1, Math.floor(settings.pagesPerVolume)));

  return {
    id: LAYOUT_ID,
    settings: {
      paperSize: settings.paperSize,
      margins: { ...settings.margins },
      pagesPerVolume: Math.max(1, Math.floor(settings.pagesPerVolume)),
    },
    pages,
    totalPages,
    totalVolumes,
    sourceHash: entriesHash(entries),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** 规范化排布参数（边界值钳制），供设置表单与导入补齐共用 */
export function normalizeSettings(input: LayoutSettings): LayoutSettings {
  const paperSize = PAPER_SIZES[input.paperSize] ? input.paperSize : DEFAULT_LAYOUT_SETTINGS.paperSize;
  const margin = (value: number): number => (Number.isFinite(value) ? Math.min(60, Math.max(0, Math.round(value))) : 0);
  return {
    paperSize,
    margins: {
      top: margin(input.margins.top),
      bottom: margin(input.margins.bottom),
      left: margin(input.margins.left),
      right: margin(input.margins.right),
    },
    pagesPerVolume: Number.isFinite(input.pagesPerVolume)
      ? Math.min(99, Math.max(1, Math.floor(input.pagesPerVolume)))
      : DEFAULT_LAYOUT_SETTINGS.pagesPerVolume,
  };
}
