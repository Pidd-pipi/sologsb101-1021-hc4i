/**
 * 册页排布（Album）数据模型
 *
 * 把已收录的印谱条目按「纸张尺寸 + 页边距 + 印稿形制」排成页，页再按每册页数装订成册：
 * - 同一条目（一方印）不可拆到两页；当前页放不下就整体移到下一页；
 * - 一册装不下固定页数就续新册；
 * - 已校对且内容与顺序未变的页沿用原页码，后续页顺延。
 *
 * 排布结果中页码为全谱连续的全局页号；册号、册内页码都由全局页号派生，
 * 因此换纸张、改每册页数只需重算一次，目录页码与总册数同时更新。
 */

/** 装订纸张与版面参数（毫米；每册页数为装订容量） */
export interface AlbumSettings {
  /** 纸宽（毫米） */
  paperWidthMm: number;
  /** 纸高（毫米） */
  paperHeightMm: number;
  /** 四周边距（毫米） */
  marginMm: number;
  /** 印蜕之间的间距（毫米） */
  gapMm: number;
  /** 款识释文栏预估高度（毫米），随形制增减 */
  annotationMm: number;
  /** 每册页数：线装一册能容纳的固定页数，超出即续册 */
  pagesPerBook: number;
}

/** 开数预设：常用印谱纸张尺寸（毫米） */
export interface PaperPreset {
  key: string;
  label: string;
  paperWidthMm: number;
  paperHeightMm: number;
}

export const PAPER_PRESETS: readonly PaperPreset[] = [
  { key: 'album-square', label: '册页方开 240×300', paperWidthMm: 240, paperHeightMm: 300 },
  { key: '16kai', label: '十六开 185×260', paperWidthMm: 185, paperHeightMm: 260 },
  { key: '32kai', label: '三十二开 130×184', paperWidthMm: 130, paperHeightMm: 184 },
  { key: 'hand-fold', label: '经折小册 150×220', paperWidthMm: 150, paperHeightMm: 220 },
];

export const DEFAULT_ALBUM_SETTINGS: AlbumSettings = {
  paperWidthMm: 240,
  paperHeightMm: 300,
  marginMm: 18,
  gapMm: 6,
  annotationMm: 12,
  pagesPerBook: 12,
};

export function createDefaultAlbumSettings(): AlbumSettings {
  return { ...DEFAULT_ALBUM_SETTINGS };
}

/** 参与排布的一方印（由 Catalog + Design + Stone 派生） */
export interface AlbumEntryInput {
  /** 对应印谱条目 id */
  catalogId: string;
  /** 排序号（即「第几方」） */
  orderNo: number;
  /** 印文（目录与页内展示） */
  sealText: string;
  /** 印面宽（毫米，取印石长×宽） */
  faceWidthMm: number;
  /** 印面高（毫米） */
  faceHeightMm: number;
  /** 朱文 / 白文（影响款识栏估算） */
  style: 'zhu' | 'bai';
  /** 边框形制：无框 / 双边 / 借边 / 瓦当（决定印蜕占地） */
  borderStyle: 'none' | 'double' | 'borrow' | 'tile';
}

/** 落位后的一方印：在页内的占位（毫米，以版心左上角为原点） */
export interface LaidOutEntry {
  catalogId: string;
  orderNo: number;
  sealText: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** 单条比整页版心还大：仍保证不拆页，独占一页并给出溢出标记 */
  overflow: boolean;
}

/** 排布后的一页 */
export interface AlbumPage {
  /** 全谱连续页码，从 1 起 */
  pageNo: number;
  entries: LaidOutEntry[];
  /** 已校对：内容与顺序沿用上一版（锁定页码） */
  proofread: boolean;
  /** 本页是否为上一版沿用（未重新分页） */
  locked: boolean;
}

/** 一册（由连续的固定页数装订而成） */
export interface AlbumBook {
  /** 册号，从 1 起 */
  bookNo: number;
  pageNoStart: number;
  pageNoEnd: number;
  pages: AlbumPage[];
}

/** 目录行：一方印落在第几册第几页 */
export interface AlbumTocRow {
  orderNo: number;
  catalogId: string;
  sealText: string;
  bookNo: number;
  /** 全谱连续页码 */
  pageNo: number;
  /** 册内页码 */
  pageInBook: number;
}

/** 一次排布的完整结果 */
export interface AlbumLayout {
  settings: AlbumSettings;
  /** 参与排布的条目总数（已收录） */
  entryCount: number;
  pages: AlbumPage[];
  books: AlbumBook[];
  toc: AlbumTocRow[];
  /** 总册数 */
  bookCount: number;
  /** 总页数 */
  pageCount: number;
  /** 沿用原页码的已校对页数 */
  lockedPageCount: number;
  /** 独占页仍超出版心的条目 id（无法正常容纳，提示换大纸或缩小边距） */
  overflowCatalogIds: string[];
  /** 重算时间戳 */
  computedAt: number;
}

/**
 * 持久化在 IndexedDB（albumLayouts 表）的排布记录。
 * 只存「页码 → 条目 id 序列 + 校对标记」与当时的设置；
 * 坐标、目录、册划分都由排布引擎按当前条目重新计算。
 */
export interface AlbumLayoutRecord {
  /** 单行单例：全谱只有一份排布 */
  id: 'default';
  /** 排布信息结构版本；旧备份缺失整份记录时按当前版本补齐 */
  layoutVersion: number;
  settings: AlbumSettings;
  pages: AlbumRecordPage[];
  updatedAt: number;
}

/** 持久化记录中的一页：条目 id 按页内顺序排列 */
export interface AlbumRecordPage {
  pageNo: number;
  catalogIds: string[];
  proofread: boolean;
}

/** 当前排布信息结构版本 */
export const ALBUM_LAYOUT_VERSION = 1;

export const ALBUM_LAYOUT_RECORD_ID = 'default' as const;

export function createEmptyLayoutRecord(settings: AlbumSettings, now: number = Date.now()): AlbumLayoutRecord {
  return {
    id: ALBUM_LAYOUT_RECORD_ID,
    layoutVersion: ALBUM_LAYOUT_VERSION,
    settings,
    pages: [],
    updatedAt: now,
  };
}
