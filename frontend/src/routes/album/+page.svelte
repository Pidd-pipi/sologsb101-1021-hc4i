<script lang="ts">
  /**
   * /album 册页排布
   * 纸张尺寸 / 页边距 / 印稿形制共同决定每页容量；同一条目不跨页，装不下续册。
   * 收录、撤下、换序后目录页码与总册数一起重算；已校对且内容与顺序未变的页沿用原页码。
   * 保存失败恢复上一版排布并可重试；消费 Album 排布与 Catalog / Design / Stone 派生数据。
   */
  import { onMount } from 'svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { PAPER_PRESETS, type AlbumEntryInput, type AlbumSettings } from '$lib/types/album';
  import {
    albumStore,
    discardDraft,
    loadAlbumEntries,
    previewSettings,
    refreshAlbum,
    retrySaveAlbum,
    saveAlbum,
    setPageProofread,
  } from '$lib/stores/albumStore';
  import { buildAlbumText, copyText, exportAlbumText } from '$lib/utils/export';
  import { push, ROUTES } from '$lib/router';

  let ready = $state(false);
  let entries = $state<AlbumEntryInput[]>([]);
  let saving = $state(false);
  let toast = $state('');
  let copied = $state(false);

  const view = $derived($albumStore);
  const layout = $derived(view.layout);
  const settings = $derived(view.draftSettings);

  onMount(async () => {
    await reload();
    ready = true;
  });

  async function reload(): Promise<void> {
    entries = await loadAlbumEntries();
    await refreshAlbum();
  }

  function showToast(text: string): void {
    toast = text;
    setTimeout(() => (toast = ''), 2800);
  }

  // 数据变化后同步：重新拉取已收录条目并按已保存记录刷新（不置脏）
  async function recompute(): Promise<void> {
    await reload();
    showToast('已按当前收录与排序刷新排布');
  }

  function patchSettings(patch: Partial<AlbumSettings>): void {
    previewSettings(patch, entries);
  }

  function applyPreset(width: number, height: number): void {
    patchSettings({ paperWidthMm: width, paperHeightMm: height });
  }

  function numberInput(field: keyof AlbumSettings, raw: string): void {
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0) return;
    patchSettings({ [field]: value } as Partial<AlbumSettings>);
  }

  async function handleSave(): Promise<void> {
    saving = true;
    const result = await saveAlbum(entries);
    saving = false;
    if (result.ok) showToast(`排布已保存：${result.lockedCount} 页沿用原页码，后续页已顺延`);
    else showToast(`保存失败，已恢复上一版排布：${result.error}`);
  }

  async function handleRetry(): Promise<void> {
    saving = true;
    const result = await retrySaveAlbum(entries);
    saving = false;
    if (result.ok) showToast('重试成功，排布已保存');
    else showToast(`仍保存失败：${result.error}`);
  }

  async function handleDiscard(): Promise<void> {
    await discardDraft(entries);
    showToast('已恢复到上一版排布');
  }

  function toggleProofread(pageNo: number, currentlyProofread: boolean): void {
    setPageProofread(pageNo, !currentlyProofread, entries);
  }

  async function handleCopy(): Promise<void> {
    if (!layout) return;
    copied = true;
    const ok = await copyText(buildAlbumText(layout));
    showToast(ok ? '册页排布已复制到剪贴板' : '浏览器未授权剪贴板');
    setTimeout(() => (copied = false), 1200);
  }

  // 页预览缩放：毫米 → 像素
  const previewWidthPx = 132;
  const scale = $derived(previewWidthPx / Math.max(1, settings.paperWidthMm));
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">册页排布与分册</h2>
      <p class="mt-1 text-sm text-ink-soft">
        纸张 · 页边距 · 印稿形制共同决定每页容量；一方不跨页，装不下续册，目录页码与总册数同步重算。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="gb-btn" onclick={() => void recompute()}>按当前收录重算</button>
      {#if layout}
        <button class="gb-btn" onclick={() => showToast(exportAlbumText(layout))}>导出排布</button>
        <button class="gb-btn" onclick={() => void handleCopy()}>{copied ? '已复制' : '复制'}</button>
      {/if}
    </div>
  </div>

  {#if toast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}
  {#if view.saveError}
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">
      <span>排布保存失败，已恢复上一版：{view.saveError}</span>
      <button class="gb-btn-danger px-2 py-1" onclick={() => void handleRetry()} disabled={saving}>重试保存</button>
    </div>
  {/if}

  {#if !ready}
    <div class="gb-panel text-sm text-ink-soft">正在读取册页排布…</div>
  {:else if !layout || layout.entryCount === 0}
    <EmptyPanel
      title="还没有可装订的已收录印谱"
      description="先到「印谱汇总」把条目标记为「已收录」，再回到这里设置纸张与页边距进行分页、续册。"
      actionText="去印谱汇总"
      onAction={() => push(ROUTES.catalog)}
    />
  {:else}
    <div class="flex flex-wrap gap-3">
      <StatBadge label="收录方数" value={layout.entryCount} suffix="方" tone="seal" />
      <StatBadge label="总册数" value={layout.bookCount} suffix="册" tone="jade" />
      <StatBadge label="总页数" value={layout.pageCount} suffix="页" />
      <StatBadge label="沿用原页码" value={layout.lockedPageCount} suffix="页" tone="amber" />
      <StatBadge label="每页容量上限" value={Math.max(0, settings.paperHeightMm - settings.marginMm * 2)} suffix="mm 版心高" tone="ink" />
    </div>

    <div class="grid gap-4 xl:grid-cols-[320px_1fr]">
      <!-- 版面参数 -->
      <section class="gb-panel space-y-3">
        <h3 class="text-base text-ink">纸张与版面</h3>
        <div>
          <span class="gb-label">纸张开数预设</span>
          <div class="flex flex-wrap gap-1.5">
            {#each PAPER_PRESETS as preset (preset.key)}
              <button
                class="gb-btn px-2 py-1 text-xs"
                class:border-seal={settings.paperWidthMm === preset.paperWidthMm && settings.paperHeightMm === preset.paperHeightMm}
                onclick={() => applyPreset(preset.paperWidthMm, preset.paperHeightMm)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="block">
            <span class="gb-label">纸宽 mm</span>
            <input class="gb-input" type="number" min="40" value={settings.paperWidthMm} onchange={(e) => numberInput('paperWidthMm', (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="gb-label">纸高 mm</span>
            <input class="gb-input" type="number" min="40" value={settings.paperHeightMm} onchange={(e) => numberInput('paperHeightMm', (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="gb-label">页边距 mm</span>
            <input class="gb-input" type="number" min="0" value={settings.marginMm} onchange={(e) => numberInput('marginMm', (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="gb-label">印蜕间距 mm</span>
            <input class="gb-input" type="number" min="0" value={settings.gapMm} onchange={(e) => numberInput('gapMm', (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="gb-label">款识栏 mm</span>
            <input class="gb-input" type="number" min="0" value={settings.annotationMm} onchange={(e) => numberInput('annotationMm', (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="gb-label">每册页数</span>
            <input class="gb-input" type="number" min="1" value={settings.pagesPerBook} onchange={(e) => numberInput('pagesPerBook', (e.currentTarget as HTMLInputElement).value)} />
          </label>
        </div>
        <p class="text-xs leading-relaxed text-ink-soft">
          版心 {Math.max(0, settings.paperWidthMm - settings.marginMm * 2)}×{Math.max(0, settings.paperHeightMm - settings.marginMm * 2)}
          mm；一方印按「印面 + 形制边距 + 款识栏」占位，当前页放不下就整方移到下一页。
        </p>
        {#if layout.overflowCatalogIds.length > 0}
          <p class="rounded-lg border border-seal/40 bg-seal/10 px-2 py-1.5 text-xs text-seal">
            有 {layout.overflowCatalogIds.length} 方比整页版心还大，已独占页；建议换大纸或缩小页边距。
          </p>
        {/if}
        <div class="flex flex-wrap gap-2 border-t border-line pt-3">
          <button class="gb-btn-primary" onclick={() => void handleSave()} disabled={saving || !view.dirty}>
            {saving ? '保存中…' : '保存排布'}
          </button>
          <button class="gb-btn" onclick={() => void handleDiscard()} disabled={!view.dirty}>放弃改动</button>
        </div>
        <p class="text-xs text-ink-soft">
          {#if view.dirty}有未保存的重算结果；保存失败会自动恢复上一版并可重试。{:else}当前排布已保存，页码与目录为生效版本。{/if}
        </p>
      </section>

      <!-- 分册与页预览 -->
      <section class="space-y-4">
        {#each layout.books as book (book.bookNo)}
          <div class="gb-panel">
            <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-base text-ink">第 {book.bookNo} 册</h3>
              <span class="text-xs text-ink-soft">全局第 {book.pageNoStart}–{book.pageNoEnd} 页 · 共 {book.pages.length} 页</span>
            </header>
            <div class="flex flex-wrap gap-3">
              {#each book.pages as page (page.pageNo)}
                {@const proofed = view.proofedPageNos.has(page.pageNo)}
                <div class="w-[168px] rounded-xl border p-2 {page.locked ? 'border-amber-500/60 bg-amber-50' : 'border-line bg-white'}">
                  <div class="mb-1 flex items-center justify-between text-xs text-ink-soft">
                    <span>第 {page.pageNo} 页</span>
                    {#if page.locked}<span title="已校对，内容与顺序未变，沿用原页码">校对·沿用</span>{/if}
                  </div>
                  <!-- 页缩略：外框为纸张，内框为版心 -->
                  <div
                    class="relative mx-auto border border-ink/30 bg-paper-light"
                    style="width:{previewWidthPx}px;height:{settings.paperHeightMm * scale}px"
                  >
                    <div
                      class="absolute border border-dashed border-jade/50"
                      style="left:{settings.marginMm * scale}px;top:{settings.marginMm * scale}px;width:{(settings.paperWidthMm - settings.marginMm * 2) * scale}px;height:{(settings.paperHeightMm - settings.marginMm * 2) * scale}px"
                    >
                      {#each page.entries as entry (entry.catalogId)}
                        <div
                          class="absolute flex items-center justify-center overflow-hidden rounded-[2px] border bg-seal/15 text-[8px] text-seal {entry.overflow
                            ? 'border-seal border-dashed'
                            : 'border-seal/50'}"
                          style="left:{entry.xMm * scale}px;top:{entry.yMm * scale}px;width:{entry.widthMm * scale}px;height:{entry.heightMm * scale}px"
                          title={`第 ${entry.orderNo} 方 ${entry.sealText}`}
                        >
                          {entry.sealText}
                        </div>
                      {/each}
                    </div>
                  </div>
                  <button
                    class="mt-2 w-full rounded-lg border px-2 py-1 text-xs {proofed
                      ? 'border-amber-500/60 text-amber-700'
                      : 'border-line text-ink-soft'}"
                    onclick={() => toggleProofread(page.pageNo, proofed)}
                  >
                    {proofed ? '已校对（取消）' : '标记校对'}
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </section>
    </div>

    <!-- 目录 -->
    <section class="gb-panel">
      <h3 class="mb-2 text-base text-ink">目录（页码随排布重算）</h3>
      <div class="overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th class="w-20">方次</th>
              <th>印文</th>
              <th class="w-24">册号</th>
              <th class="w-24">全局页码</th>
              <th class="w-28">册内页码</th>
            </tr>
          </thead>
          <tbody>
            {#each layout.toc as row (row.catalogId)}
              <tr>
                <td class="tabular-nums">{row.orderNo}</td>
                <td>{row.sealText}</td>
                <td>第 {row.bookNo} 册</td>
                <td>第 {row.pageNo} 页</td>
                <td>第 {row.pageInBook} 页</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <p class="text-xs text-ink-soft">
      校对规则：仅「已校对」且页内条目顺序与上一版完全一致的页沿用原页码；任一页变动后，该页起重新分页、后续页顺延，总册数随之变化。
    </p>
  {/if}
</div>
