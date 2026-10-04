<script lang="ts">
  /**
   * /volumes 册页排布（装订成册）
   * 每页容量由纸张尺寸、印稿形制与页边距共同决定；条目不跨页，册满续册。
   * 收录 / 撤下 / 换序后目录页码与总册数一并重算；已校对页内容未变时沿用原页码。
   * 保存失败恢复上一版排布并可重试。消费 Catalog、Design、Stone 与 VolumeLayout。
   */
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { designs } from '$lib/stores/designStore';
  import { stones } from '$lib/stores/stoneStore';
  import {
    layout,
    layoutError,
    layoutReady,
    layoutSaving,
    loadLayout,
    pendingLayout,
    retrySaveLayout,
    syncLayout,
    toggleProofread,
    updateLayoutSettings,
  } from '$lib/stores/layoutStore';
  import type { Catalog } from '$lib/types/catalog';
  import type { LayoutPage, LayoutSettings, PaperSizeId } from '$lib/types/layout';
  import { DEFAULT_LAYOUT_SETTINGS, PAPER_SIZE_OPTIONS, PAPER_SIZES } from '$lib/types/layout';
  import { BORDER_STYLE_LABEL, DESIGN_STYLE_LABEL } from '$lib/types/design';
  import { entryHeightMm, usableHeightMm } from '$lib/utils/layout';
  import { buildTocRows, buildTocText, copyText, exportTocText } from '$lib/utils/export';

  // 印谱条目沿用 /catalog 的做法：通过 useIdbTable 的 liveQuery 订阅
  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let toast = $state('');

  // 排布参数表单草稿（从当前排布初始化一次）
  let draftPaper = $state<PaperSizeId>(DEFAULT_LAYOUT_SETTINGS.paperSize);
  let draftTop = $state(DEFAULT_LAYOUT_SETTINGS.margins.top);
  let draftBottom = $state(DEFAULT_LAYOUT_SETTINGS.margins.bottom);
  let draftLeft = $state(DEFAULT_LAYOUT_SETTINGS.margins.left);
  let draftRight = $state(DEFAULT_LAYOUT_SETTINGS.margins.right);
  let draftPerVolume = $state(DEFAULT_LAYOUT_SETTINGS.pagesPerVolume);
  let draftReady = false;

  const currentLayout = $derived($layout);

  // 当前排布载入后初始化设置草稿（只取一次，避免覆盖用户输入）
  $effect(() => {
    if (!draftReady && currentLayout) {
      draftReady = true;
      draftPaper = currentLayout.settings.paperSize;
      draftTop = currentLayout.settings.margins.top;
      draftBottom = currentLayout.settings.margins.bottom;
      draftLeft = currentLayout.settings.margins.left;
      draftRight = currentLayout.settings.margins.right;
      draftPerVolume = currentLayout.settings.pagesPerVolume;
    }
  });

  // 收录 / 撤下 / 换序 / 形制变化 → 重算目录页码与总册数（序列未变时 syncLayout 自动跳过）
  $effect(() => {
    if (!$layoutReady) return;
    void syncLayout($catalogRows, $designs, $stones);
  });

  const includedCount = $derived($catalogRows.filter((item) => item.included === 'included').length);

  const designById = $derived(new Map($designs.map((design) => [design.id, design])));
  const stoneById = $derived(new Map($stones.map((stone) => [stone.id, stone])));
  const catalogById = $derived(new Map($catalogRows.map((catalog) => [catalog.id, catalog])));

  interface EntryView {
    catalogId: string;
    sealText: string;
    formatLabel: string;
    heightMm: number;
  }

  function entryView(catalogId: string): EntryView {
    const catalog = catalogById.get(catalogId);
    const design = catalog ? designById.get(catalog.designId) : undefined;
    const stone = catalog ? stoneById.get(catalog.stoneId) : undefined;
    return {
      catalogId,
      sealText: design?.sealText ?? '（印稿已删除）',
      formatLabel: design ? `${DESIGN_STYLE_LABEL[design.style]}·${BORDER_STYLE_LABEL[design.borderStyle]}` : '未知形制',
      heightMm: entryHeightMm(design, stone),
    };
  }

  const usableMm = $derived(currentLayout ? usableHeightMm(currentLayout.settings) : 0);

  // 设置草稿对应的版心高度（随表单实时变化，便于预览调整效果）
  const draftUsableMm = $derived(
    usableHeightMm({
      paperSize: draftPaper,
      margins: { top: draftTop, bottom: draftBottom, left: draftLeft, right: draftRight },
      pagesPerVolume: draftPerVolume,
    }),
  );

  interface VolumeGroup {
    volumeNo: number;
    pages: LayoutPage[];
  }

  const volumes = $derived.by((): VolumeGroup[] => {
    const groups: VolumeGroup[] = [];
    for (const page of currentLayout?.pages ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.volumeNo === page.volumeNo) {
        last.pages.push(page);
      } else {
        groups.push({ volumeNo: page.volumeNo, pages: [page] });
      }
    }
    return groups;
  });

  const proofreadCount = $derived((currentLayout?.pages ?? []).filter((page) => page.proofread).length);

  const tocRows = $derived(
    currentLayout ? buildTocRows(currentLayout, $catalogRows, $designs, $stones) : [],
  );
  const tocText = $derived(
    currentLayout ? buildTocText(currentLayout, $catalogRows, $designs, $stones) : '',
  );

  const paperLabel = $derived(
    currentLayout ? PAPER_SIZES[currentLayout.settings.paperSize].label : '',
  );

  function showToast(text: string): void {
    toast = text;
    setTimeout(() => (toast = ''), 2600);
  }

  async function applySettings(): Promise<void> {
    const settings: LayoutSettings = {
      paperSize: draftPaper,
      margins: { top: draftTop, bottom: draftBottom, left: draftLeft, right: draftRight },
      pagesPerVolume: draftPerVolume,
    };
    await updateLayoutSettings(settings, $catalogRows, $designs, $stones);
    showToast(get(layoutError) ? '排布参数保存失败，已恢复上一版' : '已按新参数重新分册');
  }

  async function handleToggleProofread(page: LayoutPage): Promise<void> {
    await toggleProofread(page.pageNo);
    showToast(get(layoutError) ? '校对标记保存失败，已恢复上一版' : page.proofread ? `第 ${page.pageNo} 页已取消校对` : `第 ${page.pageNo} 页已标记校对`);
  }

  async function handleRetry(): Promise<void> {
    await retrySaveLayout();
    showToast(get(layoutError) ? '重试仍失败，请检查浏览器存储' : '重试成功，排布已保存');
  }

  function handleExportToc(): void {
    if (!currentLayout || tocRows.length === 0) return;
    showToast(exportTocText(currentLayout, $catalogRows, $designs, $stones));
  }

  onMount(() => {
    void loadLayout();
  });
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">册页排布</h2>
      <p class="mt-1 text-sm text-ink-soft">
        把已收录条目装订成册：每页容量由纸张尺寸、印稿形制与页边距决定，条目不跨页，册满续册。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="gb-btn" onclick={handleExportToc} disabled={!currentLayout || tocRows.length === 0}>导出目录</button>
      <button
        class="gb-btn"
        disabled={!currentLayout || tocRows.length === 0}
        onclick={async () => {
          const ok = await copyText(tocText);
          showToast(ok ? '册页目录已复制到剪贴板' : '浏览器未授权剪贴板');
        }}
      >
        复制目录
      </button>
    </div>
  </div>

  {#if toast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}

  {#if $layoutError && $pendingLayout}
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-seal/40 bg-seal/10 px-4 py-3 text-sm text-seal">
      <span>排布保存失败（{$layoutError}），已恢复上一版排布。</span>
      <button class="gb-btn-danger" onclick={() => void handleRetry()} disabled={$layoutSaving}>重试保存</button>
    </div>
  {/if}

  <section class="gb-panel">
    <h3 class="mb-3 text-base text-ink">排布参数</h3>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <label class="block sm:col-span-2">
        <span class="gb-label">纸张尺寸</span>
        <select class="gb-input" bind:value={draftPaper}>
          {#each PAPER_SIZE_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="gb-label">上边距 mm</span>
        <input class="gb-input" type="number" min="0" max="60" bind:value={draftTop} />
      </label>
      <label class="block">
        <span class="gb-label">下边距 mm</span>
        <input class="gb-input" type="number" min="0" max="60" bind:value={draftBottom} />
      </label>
      <label class="block">
        <span class="gb-label">左边距 mm</span>
        <input class="gb-input" type="number" min="0" max="60" bind:value={draftLeft} />
      </label>
      <label class="block">
        <span class="gb-label">右边距 mm / 每册页数</span>
        <div class="flex gap-2">
          <input class="gb-input" type="number" min="0" max="60" bind:value={draftRight} />
          <input class="gb-input" type="number" min="1" max="99" bind:value={draftPerVolume} title="每册页数" />
        </div>
      </label>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <button class="gb-btn-primary" onclick={() => void applySettings()} disabled={$layoutSaving}>应用并重排</button>
      <span class="text-xs text-ink-soft">
        换纸张或改边距后全部册页重排；当前参数版心可用高度 {draftUsableMm}mm。
      </span>
    </div>
  </section>

  <div class="flex flex-wrap gap-3">
    <StatBadge label="总册数" value={currentLayout?.totalVolumes ?? 0} suffix="册" tone="seal" />
    <StatBadge label="总页数" value={currentLayout?.totalPages ?? 0} suffix="页" tone="ink" />
    <StatBadge label="谱录已收录" value={includedCount} suffix="方" tone="jade" />
    <StatBadge label="已校对页" value={proofreadCount} suffix="页" tone="amber" />
  </div>

  {#if !$layoutReady}
    <div class="rounded-xl border border-line bg-paper-light px-4 py-6 text-sm text-ink-soft">正在读取册页排布…</div>
  {:else if !currentLayout || includedCount === 0}
    <EmptyPanel
      title="还没有可装订的条目"
      description="在「印谱汇总」把条目标记为已收录后，这里会按排布参数自动分页分册。"
      size="small"
    />
  {:else}
    {#each volumes as volume (volume.volumeNo)}
      <section class="gb-panel">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-base text-ink">第 {volume.volumeNo} 册</h3>
          <span class="text-xs text-ink-soft">
            {paperLabel} · 共 {volume.pages.length} 页（第 {volume.pages[0]?.pageNo}–{volume.pages[volume.pages.length - 1]?.pageNo} 页）
          </span>
        </header>
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {#each volume.pages as page (page.pageNo)}
            <div
              class="rounded-xl border p-3 {page.kind === 'filler'
                ? 'border-dashed border-line bg-black/[0.02]'
                : 'border-line bg-white/60'}"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-medium text-ink">
                  第 {page.pageNo} 页{page.kind === 'filler' ? '（补白）' : ''}
                </span>
                {#if page.kind === 'content'}
                  <button
                    class="gb-btn px-2 py-0.5 text-xs {page.proofread ? 'border-jade text-jade' : ''}"
                    title="已校对的页在内容与顺序未变时沿用原页码"
                    onclick={() => void handleToggleProofread(page)}
                  >
                    {page.proofread ? '已校对 ✓' : '标记校对'}
                  </button>
                {/if}
              </div>
              {#if page.kind === 'filler'}
                <p class="mt-2 text-xs text-ink-soft">为沿用已校对页码而留出的空页。</p>
              {:else}
                <ul class="mt-2 space-y-1">
                  {#each page.entryIds as catalogId (catalogId)}
                    {@const entry = entryView(catalogId)}
                    <li class="flex items-baseline justify-between gap-2 text-sm">
                      <span class="text-ink">{entry.sealText}</span>
                      <span class="text-xs text-ink-soft">{entry.formatLabel} · {entry.heightMm}mm</span>
                    </li>
                  {/each}
                </ul>
                <div class="mt-2">
                  <span class="block h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                    <span
                      class="block h-full rounded-full bg-seal"
                      style="width: {Math.min(100, Math.round((page.usedMm / usableMm) * 100))}%"
                    ></span>
                  </span>
                  <p class="mt-1 text-right text-xs text-ink-soft">{page.usedMm} / {usableMm}mm</p>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}

    <section class="gb-panel">
      <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">册页目录</h3>
        <span class="text-xs text-ink-soft">共 {tocRows.length} 方 · {currentLayout.totalPages} 页 · {currentLayout.totalVolumes} 册</span>
      </header>
      <pre class="max-h-[320px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{tocText}</pre>
    </section>
  {/if}

  <p class="text-xs text-ink-soft">
    收录、撤下或换序后，目录页码与总册数自动重算；已校对页只要内容与顺序未变就沿用原页码（空位以补白页填充），后续页再顺延。
  </p>
</div>
