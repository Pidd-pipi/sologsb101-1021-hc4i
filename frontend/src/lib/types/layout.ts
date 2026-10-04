/**
 * 册页排布（VolumeLayout）数据模型
 * 把已收录的印谱条目按纸张尺寸、印稿形制与页边距装订成册：
 * 条目不跨页，页满续页，册满续册；已校对页在内容与顺序未变时沿用原页码。
 */

/** 纸张尺寸：十六开 / 三十二开 / A4 / A5 */
export type PaperSizeId = 'k16' | 'k32' | 'a4' | 'a5';

export interface PaperSizeSpec {
  id: PaperSizeId;
  label: string;
  /** 纸宽（毫米） */
  widthMm: number;
  /** 纸高（毫米） */
  heightMm: number;
}

export const PAPER_SIZES: Record<PaperSizeId, PaperSizeSpec> = {
  k16: { id: 'k16', label: '十六开', widthMm: 185, heightMm: 260 },
  k32: { id: 'k32', label: '三十二开', widthMm: 130, heightMm: 185 },
  a4: { id: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
  a5: { id: 'a5', label: 'A5', widthMm: 148, heightMm: 210 },
};

export const PAPER_SIZE_OPTIONS: ReadonlyArray<{ value: PaperSizeId; label: string }> = (
  Object.keys(PAPER_SIZES) as PaperSizeId[]
).map((id) => {
  const spec = PAPER_SIZES[id];
  return { value: id, label: `${spec.label}（${spec.widthMm}×${spec.heightMm}mm）` };
});

/** 页边距（毫米） */
export interface PageMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 排布参数：纸张 + 页边距 + 每册页数上限 */
export interface LayoutSettings {
  paperSize: PaperSizeId;
  margins: PageMargins;
  /** 每册页数上限，装满即续册 */
  pagesPerVolume: number;
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  paperSize: 'k16',
  margins: { top: 18, bottom: 18, left: 16, right: 16 },
  pagesPerVolume: 12,
};

/** 页类型：内容页 / 补白页（为沿用已校对页码而留出的空页） */
export type LayoutPageKind = 'content' | 'filler';

export interface LayoutPage {
  /** 全局页码（跨册连续，从 1 开始） */
  pageNo: number;
  /** 所属册号（由页码与每册页数派生） */
  volumeNo: number;
  /** 本页印谱条目 id（有序；补白页为空） */
  entryIds: string[];
  kind: LayoutPageKind;
  /** 已校对：内容与顺序未变时重排仍沿用原页码 */
  proofread: boolean;
  /** 本页已用版心高度（毫米） */
  usedMm: number;
  /** 内容指纹（条目序列 + 排布参数），用于判断校对页是否可沿用 */
  fingerprint: string;
}

/** 一版完整的册页排布（单条记录，id 固定） */
export interface VolumeLayout {
  id: string;
  settings: LayoutSettings;
  pages: LayoutPage[];
  totalPages: number;
  totalVolumes: number;
  /** 参与排布的已收录条目序列指纹，用于识别「收录 / 撤下 / 换序」后的变化 */
  sourceHash: string;
  createdAt: number;
  updatedAt: number;
}

/** 排布记录主键（全库只保存当前一版） */
export const LAYOUT_ID = 'current';
