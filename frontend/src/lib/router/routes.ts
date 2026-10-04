/**
 * 路由表（history 模式真实路径）
 * /stones、/designs、/carve、/impressions、/catalog、/volumes
 * 直接访问真实路径即可命中；刷新由 nginx / vite 的 SPA fallback 回退 index.html。
 */
import type { Component } from 'svelte';
import { ROUTES } from '$lib/router';
import StonesPage from '../../routes/stones/+page.svelte';
import DesignsPage from '../../routes/designs/+page.svelte';
import CarvePage from '../../routes/carve/+page.svelte';
import ImpressionsPage from '../../routes/impressions/+page.svelte';
import CatalogPage from '../../routes/catalog/+page.svelte';
import VolumesPage from '../../routes/volumes/+page.svelte';
import NotFoundPage from '../../routes/NotFound.svelte';

export const routes: Record<string, Component> = {
  '/': StonesPage,
  [ROUTES.stones]: StonesPage,
  [ROUTES.designs]: DesignsPage,
  [ROUTES.carve]: CarvePage,
  [ROUTES.impressions]: ImpressionsPage,
  [ROUTES.catalog]: CatalogPage,
  [ROUTES.volumes]: VolumesPage,
  '*': NotFoundPage
};

export default routes;
