/**
 * 册页排布引擎（纯函数，便于单测与失败重试回放）
 *
 * 容量规则：
 * - 每页可排区域（版心）= 纸张 − 两侧页边距；
 * - 一方印在页内占用一个竖向矩形：高 = 印面高 + 形制边距 + 款识释文栏，
 *   宽 = 印面宽 + 形制边距（双边 / 瓦当多留一圈边）。条目自上而下顺序堆叠；
 * - 同一条目不跨页：当前页剩余高度放不下就整方移到下一页；
 * - 条目比整页版心还高时独占一页（标记 overflow，提示换大纸或缩小边距）。
 *
 * 续册规则：按 settings.pagesPerBook 把全局页依次装订成册，超出即续册。
 *
 * 页码沿用规则（混合模型）：
 * - 内容一致性按前缀扫描：从首页起，页内条目 id 序列与上一版逐页一致即视为「内容前缀未断」；
 *   一旦某页内容或顺序变化，该页及其后永久进入重排段（后续页码顺延）。
 * - 是否沿用还要该页「已校对」：取消某页校对只会让该页不沿用，不会中断内容前缀，
 *   因此其后内容未变且已校对的页仍沿用原页码。
 */
import type {
  AlbumBook,
  AlbumEntryInput,
  AlbumLayout,
  AlbumPage,
  AlbumRecordPage,
  AlbumSettings,
  AlbumTocRow,
  LaidOutEntry,
} from '$lib/types/album';

export interface LayoutTextArea {
  widthMm: number;
  heightMm: number;
}

/** 版心尺寸（毫米） */
export function textArea(settings: AlbumSettings): LayoutTextArea {
  return {
    widthMm: Math.max(0, settings.paperWidthMm - settings.marginMm * 2),
    heightMm: Math.max(0, settings.paperHeightMm - settings.marginMm * 2),
  };
}

/** 印稿形制对印蜕占地的修正（毫米）：双边、瓦当多留一圈边 */
const BORDER_PADDING: Record<AlbumEntryInput['borderStyle'], number> = {
  none: 0,
  double: 4,
  borrow: 2,
  tile: 6,
};

/** 一方印在页内的占位尺寸（毫米） */
export function entryFootprint(
  entry: AlbumEntryInput,
  settings: AlbumSettings,
): { widthMm: number; heightMm: number } {
  const padding = BORDER_PADDING[entry.borderStyle];
  return {
    widthMm: entry.faceWidthMm + padding,
    // 白文线条占地略大，款识栏多估 2mm
    heightMm: entry.faceHeightMm + padding + settings.annotationMm + (entry.style === 'bai' ? 2 : 0),
  };
}

interface PackedItem {
  entry: AlbumEntryInput;
  footprint: { widthMm: number; heightMm: number };
  overflow: boolean;
}

interface PackedPage {
  items: PackedItem[];
}

/** 贪心分页：顺序装条目，当前页放不下就换页（条目不跨页） */
function packAll(entries: AlbumEntryInput[], settings: AlbumSettings): PackedPage[] {
  const area = textArea(settings);
  const pages: PackedPage[] = [];
  let current: PackedPage = { items: [] };
  let usedHeight = 0;

  const startFreshPage = (): void => {
    if (current.items.length > 0) {
      pages.push(current);
      current = { items: [] };
      usedHeight = 0;
    }
  };

  entries.forEach((entry) => {
    const footprint = entryFootprint(entry, settings);
    const overflow = footprint.heightMm > area.heightMm;
    const needsGap = current.items.length > 0 ? settings.gapMm : 0;
    if (!overflow && current.items.length > 0 && usedHeight + needsGap + footprint.heightMm > area.heightMm) {
      startFreshPage();
    }
    const gap = current.items.length > 0 ? settings.gapMm : 0;
    current.items.push({ entry, footprint, overflow });
    if (overflow) {
      // 比整页版心还高：独占一页，后续条目另起新页
      pages.push(current);
      current = { items: [] };
      usedHeight = 0;
    } else {
      usedHeight += gap + footprint.heightMm;
    }
  });
  if (current.items.length > 0) pages.push(current);
  return pages;
}

function pageIdsEqual(prev: AlbumRecordPage | undefined, group: PackedPage): boolean {
  if (!prev || prev.catalogIds.length !== group.items.length) return false;
  return prev.catalogIds.every((id, index) => id === group.items[index]?.entry.catalogId);
}

/**
 * 计算排布。
 * @param entries 已收录条目，按印谱顺序传入
 * @param settings 纸张 / 边距 / 每册页数
 * @param previous 上一版持久化记录（旧备份或首次排布时传 null）
 */
export function computeLayout(
  entries: AlbumEntryInput[],
  settings: AlbumSettings,
  previous: { pages: AlbumRecordPage[] } | null,
): AlbumLayout {
  const area = textArea(settings);
  const packed = packAll(entries, settings);
  const prevPages = previous?.pages ?? [];

  // 2) 落位并判断沿用：内容前缀未断 + 该页已校对 → 沿用原页码；
  //    内容前缀在某页断裂后，其后全部重排顺延（即使取消校对也不断前缀）。
  const pages: AlbumPage[] = [];
  let lockedLen = 0;
  let prefixIntact = true;
  packed.forEach((group, index) => {
    const prev = prevPages[index];
    const sameContent = !!prev && prev.pageNo === index + 1 && pageIdsEqual(prev, group);
    if (!sameContent) prefixIntact = false;
    const locked = prefixIntact && sameContent && !!prev && prev.proofread;
    if (locked) lockedLen += 1;
    pages.push(buildPage(index + 1, group, area.widthMm, settings, locked));
  });

  const books = splitBooks(pages, settings.pagesPerBook);
  const toc = buildToc(entries, pages, books);
  const overflowCatalogIds = pages
    .flatMap((page) => page.entries)
    .filter((entry) => entry.overflow)
    .map((entry) => entry.catalogId);

  return {
    settings,
    entryCount: entries.length,
    pages,
    books,
    toc,
    bookCount: books.length,
    pageCount: pages.length,
    lockedPageCount: lockedLen,
    overflowCatalogIds,
    computedAt: Date.now(),
  };
}

/** 把一页条目换算为页内坐标（水平居中、自上而下堆叠） */
function buildPage(
  pageNo: number,
  group: PackedPage,
  areaWidthMm: number,
  settings: AlbumSettings,
  locked: boolean,
): AlbumPage {
  let y = 0;
  const laidOut: LaidOutEntry[] = group.items.map((item, index) => {
    if (index > 0) y += settings.gapMm;
    const laid: LaidOutEntry = {
      catalogId: item.entry.catalogId,
      orderNo: item.entry.orderNo,
      sealText: item.entry.sealText,
      xMm: Math.max(0, (areaWidthMm - item.footprint.widthMm) / 2),
      yMm: y,
      widthMm: item.footprint.widthMm,
      heightMm: item.footprint.heightMm,
      overflow: item.overflow,
    };
    y += item.footprint.heightMm;
    return laid;
  });
  return { pageNo, entries: laidOut, proofread: locked, locked };
}

/** 按每册固定页数装订：超出 pagesPerBook 即续册 */
export function splitBooks(pages: AlbumPage[], pagesPerBook: number): AlbumBook[] {
  const perBook = Math.max(1, Math.floor(pagesPerBook));
  const books: AlbumBook[] = [];
  for (let start = 0; start < pages.length; start += perBook) {
    const slice = pages.slice(start, start + perBook);
    books.push({
      bookNo: books.length + 1,
      pageNoStart: slice[0]?.pageNo ?? start + 1,
      pageNoEnd: slice[slice.length - 1]?.pageNo ?? start + 1,
      pages: slice,
    });
  }
  return books;
}

/** 目录：一方印 → 第几册 / 全局页号 / 册内页号 */
export function buildToc(entries: AlbumEntryInput[], pages: AlbumPage[], books: AlbumBook[]): AlbumTocRow[] {
  const pageIndex = new Map<number, { book: AlbumBook; pageInBook: number }>();
  books.forEach((book) => {
    book.pages.forEach((page, index) => {
      pageIndex.set(page.pageNo, { book, pageInBook: index + 1 });
    });
  });

  const orderByCatalog = new Map(entries.map((entry) => [entry.catalogId, entry]));
  const rows: AlbumTocRow[] = [];
  pages.forEach((page) => {
    const located = pageIndex.get(page.pageNo);
    if (!located) return;
    page.entries.forEach((laid) => {
      const source = orderByCatalog.get(laid.catalogId);
      if (!source) return;
      rows.push({
        orderNo: source.orderNo,
        catalogId: laid.catalogId,
        sealText: laid.sealText,
        bookNo: located.book.bookNo,
        pageNo: page.pageNo,
        pageInBook: located.pageInBook,
      });
    });
  });
  return rows.sort((a, b) => a.orderNo - b.orderNo);
}

/** 排布结果 → 持久化记录内容（页码 / 条目 id 序列 / 校对标记） */
export function layoutToRecordPages(layout: AlbumLayout, proofedPageNos: Set<number>): AlbumRecordPage[] {
  return layout.pages.map((page) => ({
    pageNo: page.pageNo,
    catalogIds: page.entries.map((entry) => entry.catalogId),
    proofread: proofedPageNos.has(page.pageNo),
  }));
}
