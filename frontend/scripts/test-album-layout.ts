/**
 * 册页排布引擎纯逻辑测试（不依赖 IndexedDB / DOM）。
 * 用 node 运行：经 esbuild 打包为 ESM 后执行。
 */
import assert from 'node:assert/strict';
import {
  computeLayout,
  entryFootprint,
  splitBooks,
  textArea,
} from '../src/lib/utils/albumLayout';
import { DEFAULT_ALBUM_SETTINGS, type AlbumEntryInput, type AlbumRecordPage, type AlbumSettings } from '../src/lib/types/album';
import { ensureAlbumLayoutInSnapshot, normalizeLayoutRecord } from '../src/lib/utils/db';
import type { SealCarveSnapshot } from '../src/lib/utils/db';
import { ALBUM_LAYOUT_RECORD_ID } from '../src/lib/types/album';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function entry(
  id: string,
  orderNo: number,
  face = 25,
  overrides: Partial<AlbumEntryInput> = {},
): AlbumEntryInput {
  return {
    catalogId: id,
    orderNo,
    sealText: `印${orderNo}`,
    faceWidthMm: face,
    faceHeightMm: face,
    style: 'zhu',
    borderStyle: 'none',
    ...overrides,
  };
}

const settings: AlbumSettings = {
  ...DEFAULT_ALBUM_SETTINGS,
  paperWidthMm: 100,
  paperHeightMm: 100,
  marginMm: 10,
  gapMm: 0,
  annotationMm: 10, // 每方占位高 = 印面 + 10；版心高 80
  pagesPerBook: 2,
};

// 版心 80mm 高；25mm 印面 + 10 款识 = 35mm / 方 → 每页 2 方（70），第 3 方换页
test('版心与每方占位计算', () => {
  assert.deepEqual(textArea(settings), { widthMm: 80, heightMm: 80 });
  assert.equal(entryFootprint(entry('a', 1), settings).heightMm, 35);
});

test('同一条目不跨页：装不下整方移到下一页', () => {
  const layout = computeLayout([entry('a', 1), entry('b', 2), entry('c', 3)], settings, null);
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(layout.pages[0].entries.map((e) => e.catalogId), ['a', 'b']);
  assert.deepEqual(layout.pages[1].entries.map((e) => e.catalogId), ['c']);
});

test('每册固定页数，超出续册，总册数随页数变化', () => {
  const many = Array.from({ length: 6 }, (_, i) => entry(`e${i}`, i + 1)); // 6 方 = 3 页
  const layout = computeLayout(many, settings, null);
  assert.equal(layout.pageCount, 3);
  assert.equal(layout.bookCount, 2); // 每册 2 页 → 2 + 1
  assert.deepEqual([layout.books[0].pageNoStart, layout.books[0].pageNoEnd], [1, 2]);
  assert.deepEqual([layout.books[1].pageNoStart, layout.books[1].pageNoEnd], [3, 3]);
});

test('目录页码 = 第几册 / 全局页 / 册内页，随排布重算', () => {
  const many = Array.from({ length: 6 }, (_, i) => entry(`e${i}`, i + 1));
  const layout = computeLayout(many, settings, null);
  const first = layout.toc.find((r) => r.orderNo === 5)!; // e4 在第 3 页
  assert.deepEqual([first.bookNo, first.pageNo, first.pageInBook], [2, 3, 1]);
});

test('已校对且内容顺序未变的页沿用原页码', () => {
  const rows = [entry('a', 1), entry('b', 2), entry('c', 3)];
  const first = computeLayout(rows, settings, null);
  const prev: AlbumRecordPage[] = first.pages.map((p) => ({
    pageNo: p.pageNo,
    catalogIds: p.entries.map((e) => e.catalogId),
    proofread: true,
  }));
  // 同样输入重算：全部沿用
  const again = computeLayout(rows, settings, { pages: prev });
  assert.equal(again.lockedPageCount, 2);
  assert.ok(again.pages.every((p) => p.locked));
});

test('收录新方（前缀之后变化）：已校对前缀沿用，后续页顺延', () => {
  const base = [entry('a', 1), entry('b', 2), entry('c', 3)];
  const first = computeLayout(base, settings, null);
  const prev = first.pages.map((p) => ({
    pageNo: p.pageNo,
    catalogIds: p.entries.map((e) => e.catalogId),
    proofread: true,
  }));
  // 在开头插入一方 → 第 1 页内容变（a,b → x,a），前缀断裂，全部顺延重排
  const inserted = [entry('x', 1), ...base.map((e) => ({ ...e, orderNo: e.orderNo + 1 }))];
  const next = computeLayout(inserted, settings, { pages: prev });
  assert.equal(next.lockedPageCount, 0);
  assert.equal(next.pageCount, 2);
});

test('仅在末尾补录：前面已校对页沿用原页码，新增页顺延', () => {
  const base = [entry('a', 1), entry('b', 2), entry('c', 3)];
  const first = computeLayout(base, settings, null);
  const prev = first.pages.map((p) => ({
    pageNo: p.pageNo,
    catalogIds: p.entries.map((e) => e.catalogId),
    proofread: true,
  }));
  // 末尾追加一方高 60 的印（占位 70，剩 45 放不下）→ 独占新页；第 1 页[a,b]、第 2 页[c]内容均未变沿用
  const appended = [...base, entry('d', 4, 60)];
  const next = computeLayout(appended, settings, { pages: prev });
  assert.equal(next.pages[0].locked, true);
  assert.equal(next.pages[1].locked, true);
  assert.equal(next.pages[2].locked, false);
  assert.deepEqual(next.pages[1].entries.map((e) => e.catalogId), ['c']);
  assert.equal(next.pageCount, 3);
  assert.equal(next.bookCount, 2);
});

test('换序：交换前缀页内顺序导致该页不沿用，其后顺延', () => {
  const base = [entry('a', 1), entry('b', 2), entry('c', 3)];
  const first = computeLayout(base, settings, null);
  const prev = first.pages.map((p) => ({
    pageNo: p.pageNo,
    catalogIds: p.entries.map((e) => e.catalogId),
    proofread: true,
  }));
  const swapped = [entry('b', 1), entry('a', 2), entry('c', 3)];
  const next = computeLayout(swapped, settings, { pages: prev });
  assert.equal(next.pages[0].locked, false);
});

test('取消某页校对不中断内容前缀：其后已校对页仍沿用', () => {
  const base = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)];
  const first = computeLayout(base, settings, null); // 3 页
  const prev: AlbumRecordPage[] = first.pages.map((p) => ({
    pageNo: p.pageNo,
    catalogIds: p.entries.map((e) => e.catalogId),
    proofread: true,
  }));
  prev[0].proofread = false; // 第 1 页撤下校对，内容不变
  const next = computeLayout(base, settings, { pages: prev });
  assert.equal(next.pages[0].locked, false);
  assert.equal(next.pages[1].locked, true);
  assert.equal(next.pages[2].locked, true);
});

test('比整页版心还大的条目独占一页并标记 overflow', () => {
  const giant = entry('g', 1, 90, {}); // 90 + 10 款识 = 100 > 80 版心
  const layout = computeLayout([giant, entry('a', 2)], settings, null);
  assert.deepEqual(layout.pages[0].entries.map((e) => e.catalogId), ['g']);
  assert.equal(layout.pages[0].entries[0].overflow, true);
  assert.deepEqual(layout.pages[1].entries.map((e) => e.catalogId), ['a']);
  assert.ok(layout.overflowCatalogIds.includes('g'));
});

test('形制（边框 / 白文）改变占位进而改变每页方数', () => {
  const tile = entry('t', 1, 25, { borderStyle: 'tile' }); // 25+6+10=41
  const normal = entry('n', 2, 25);
  // tile 41 + normal 35 = 76 可同页；再来一方 35 → 111 超 80
  const layout = computeLayout([tile, normal, entry('c', 3)], settings, null);
  assert.deepEqual(layout.pages[0].entries.map((e) => e.catalogId), ['t', 'n']);
});

test('splitBooks 对空页集返回空数组', () => {
  assert.deepEqual(splitBooks([], 2), []);
});

test('旧备份缺少排布信息时补齐默认空排布（单例）', () => {
  const snapshot = { app: 'gbsealcarve' } as unknown as SealCarveSnapshot;
  const layouts = ensureAlbumLayoutInSnapshot(snapshot);
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0].id, ALBUM_LAYOUT_RECORD_ID);
  assert.deepEqual(layouts[0].pages, []);
  assert.deepEqual(layouts[0].settings, DEFAULT_ALBUM_SETTINGS);
});

test('残缺排布记录被规范化：非法设置回退默认、脏页数据被清洗', () => {
  const broken = {
    id: ALBUM_LAYOUT_RECORD_ID,
    layoutVersion: 99,
    settings: { ...DEFAULT_ALBUM_SETTINGS, paperWidthMm: -5, pagesPerBook: 0 },
    pages: [
      { pageNo: 1, catalogIds: ['a', 3, null as unknown as string], proofread: true },
      { pageNo: -2, catalogIds: 'not-array' as unknown as string[], proofread: 'yes' },
      null as unknown as AlbumRecordPage,
    ],
  };
  const fixed = normalizeLayoutRecord(broken);
  assert.equal(fixed.settings.paperWidthMm, DEFAULT_ALBUM_SETTINGS.paperWidthMm);
  assert.equal(fixed.settings.pagesPerBook, DEFAULT_ALBUM_SETTINGS.pagesPerBook);
  assert.equal(fixed.pages.length, 1); // 后两页被过滤
  assert.deepEqual(fixed.pages[0].catalogIds, ['a']); // 非字符串 id 被剔除
  assert.equal(fixed.pages[0].proofread, true);
});

test('补齐后的空排布可直接参与分册（首次排布不沿用任何页）', () => {
  const snapshot = {} as SealCarveSnapshot;
  const [record] = ensureAlbumLayoutInSnapshot(snapshot);
  const rows = Array.from({ length: 12 }, (_, i) => entry(`e${i}`, i + 1));
  const layout = computeLayout(rows, record.settings, { pages: record.pages });
  assert.equal(layout.lockedPageCount, 0);
  assert.ok(layout.pageCount >= 1);
  assert.equal(layout.toc.length, 12);
  assert.ok(layout.bookCount >= 1);
});

console.log(`\n全部通过：${passed} 项测试`);
