import { Page, expect } from '@playwright/test';
import { login } from './auth';
import { recoverFromOffline } from './app';
import type { StorageBackend } from '../_data/storage-backends';

/** A clean, stable warehouse name from a backend key: demo-aws, demo-seaweedfs. */
export function warehouseName(backend: StorageBackend) {
  const slug = (backend.key.match(/\(([^)]+)\)/)?.[1] ?? backend.key).replace(/[^a-z0-9]/gi, '');
  return `demo-${slug}`;
}

async function gotoWarehouses(page: Page) {
  await page.goto('/ui/warehouse');
  await page.waitForLoadState('domcontentloaded');
  if (/\/ui\/login/.test(page.url())) {
    await login(page);
    await page.goto('/ui/warehouse');
  }
  // Shake off the transient "Lakekeeper Unreachable" page (auth-hydration race).
  await recoverFromOffline(page);
  // The warehouse nav tree does NOT auto-update after a create — refresh it so a
  // just-created warehouse actually appears (esp. for the seaweedfs journey).
  await refreshWarehouses(page);
}

/** Click the nav tree's "Refresh warehouses" button (if present) and let it settle. */
export async function refreshWarehouses(page: Page) {
  const btn = page.getByRole('button', { name: /refresh warehouse/i }).first();
  if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
  }
}

/** Create a warehouse for the given storage backend (idempotent-ish: if it already
 *  exists the list still shows it, which is all callers assert). Returns its name. */
export async function createWarehouse(page: Page, backend: StorageBackend) {
  const wh = warehouseName(backend);
  await gotoWarehouses(page);
  // Idempotent: a prior spec in this combo may have already created it (combos
  // share backend state, no per-test cleanup). Reuse it instead of colliding.
  const already =
    (await page.getByRole('treeitem', { name: new RegExp(wh) }).first().isVisible({ timeout: 3000 }).catch(() => false)) ||
    (await page.getByText(wh, { exact: true }).first().isVisible({ timeout: 1000 }).catch(() => false));
  if (already) return wh;
  await page.getByRole('button', { name: /add warehouse/i }).first().click();
  await page.getByLabel(/Warehouse Name/i).first().fill(wh);
  await page.getByRole('tab', { name: backend.tab }).click();
  const panel = page.locator('.v-window-item--active');
  await backend.fill(panel);
  await panel.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByText(wh, { exact: false }).first()).toBeVisible({ timeout: 20000 });
  return wh;
}

/** Open a warehouse's detail page by clicking its row name cell. Retries the click
 *  until the route changes (console-plus loads heavier and can miss the first click). */
export async function openWarehouse(page: Page, wh: string) {
  await gotoWarehouses(page);
  const nameCell = page.getByRole('row', { name: new RegExp(wh) }).getByText(wh, { exact: true });
  for (let i = 0; i < 4 && !/\/ui\/warehouse\/[^/]+/.test(page.url()); i++) {
    await nameCell.click().catch(() => {});
    await page.waitForURL(/\/ui\/warehouse\/[^/]+/, { timeout: 5000 }).catch(() => {});
  }
  await expect(page).toHaveURL(/\/ui\/warehouse\/[^/]+/, { timeout: 5000 });
}

/** Add a namespace on the currently-open warehouse detail page (idempotent). */
export async function addNamespace(page: Page, ns: string) {
  // Reuse if a prior spec already created it in this combo.
  if (await page.getByText(ns, { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false)) {
    return;
  }
  const addNs = page.getByRole('button', { name: /add namespace/i });
  await expect(addNs.first()).toBeVisible({ timeout: 15000 });
  await addNs.first().click();
  await page.getByLabel(/Namespace Name/i).fill(ns);
  const submit = page.getByRole('button', { name: /^add namespace$/i }).last();
  await expect(submit).toBeEnabled({ timeout: 5000 });
  await submit.click();
  await expect(page.getByText(ns, { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

/** Full seed: create warehouse + open it + add a namespace. Returns { wh, ns }. */
export async function seedWarehouseWithNamespace(
  page: Page,
  backend: StorageBackend,
  ns = 'demo_ns',
) {
  const wh = await createWarehouse(page, backend);
  await openWarehouse(page, wh);
  await addNamespace(page, ns);
  return { wh, ns };
}
