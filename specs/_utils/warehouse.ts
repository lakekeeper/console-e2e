import { Page, Locator, expect } from '@playwright/test';
import { login } from './auth';
import { recoverFromOffline } from './app';
import type { StorageBackend } from '../_data/storage-backends';

/** A clean, stable warehouse name from a backend key: demo-aws, demo-silo. */
/**
 * Warehouse name for a backend, namespaced to the browser pass.
 *
 * chromium, firefox and webkit run one after another against the SAME stack, so
 * anything a spec leaves behind (an OpenFGA grant, a warehouse whose endpoint it
 * deliberately blocked) is still there when the next browser starts. That read
 * as "firefox fails tests chromium passes" when it was really run order. Every
 * browser now gets its own warehouses; run.mjs sets E2E_RESOURCE_SUFFIX per pass.
 */
export function warehouseName(
  backend: StorageBackend,
  suffix = process.env.E2E_RESOURCE_SUFFIX || '',
) {
  const slug = (backend.key.match(/\(([^)]+)\)/)?.[1] ?? backend.key).replace(/[^a-z0-9]/gi, '');
  return `demo-${slug}${suffix ? `-${suffix.replace(/[^a-z0-9]/gi, '')}` : ''}`;
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
  // just-created warehouse actually appears (esp. for the silo journey).
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

/** The open "Add Warehouse" modal. It is fullscreen now (one rail: Settings ·
 *  a tab per storage provider · Tools), so the storage subform is no longer in
 *  a `.v-window-item--active` — scoping to the overlay is what isolates it. */
function createWarehouseDialog(page: Page) {
  return page.locator('.v-overlay__content').filter({ hasText: 'Add new warehouse' }).last();
}

/** Create a warehouse for the given storage backend (idempotent-ish: if it already
 *  exists the list still shows it, which is all callers assert). Returns its name. */
export async function createWarehouse(
  page: Page,
  backend: StorageBackend,
  suffix = process.env.E2E_RESOURCE_SUFFIX || '',
) {
  const wh = warehouseName(backend, suffix);
  await gotoWarehouses(page);
  // Idempotent: a prior spec in this combo may have already created it (combos
  // share backend state, no per-test cleanup). Reuse it instead of colliding.
  const already =
    (await page.getByRole('treeitem', { name: new RegExp(wh) }).first().isVisible({ timeout: 3000 }).catch(() => false)) ||
    (await page.getByText(wh, { exact: true }).first().isVisible({ timeout: 1000 }).catch(() => false));
  if (already) return wh;

  await page.getByRole('button', { name: /add warehouse/i }).first().click();
  const dialog = createWarehouseDialog(page);
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // The name lives in the rail's "Settings" pane, which is where the dialog opens.
  await dialog.getByLabel(/Warehouse Name/i).first().fill(wh);

  // Second, authoritative idempotency check. The list above can still be loading
  // when it is read (the nav tree does not refresh itself after a create), but the
  // dialog asks the server: a taken name disables Verify & Create and says so.
  // Without this a shared-state re-run stalls on a permanently disabled button.
  if (await dialog.getByText(/Name already taken/i).first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await dialog.getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
    await expect(dialog).toBeHidden({ timeout: 10000 }).catch(() => {});
    return wh;
  }

  // Provider rail. The pane it selects is a v-show div, not a window item, and
  // only the selected provider's form is mounted — so `dialog` is a safe scope.
  await dialog.getByRole('tab', { name: backend.tab }).click();
  await backend.fill(dialog, { warehouse: wh });

  // "Create" became "Verify & Create": it runs the server-side storage validation
  // first and only creates when that passes. It also switches the rail to the
  // Verify pane while the request is in flight, so give it room — a failed
  // validation leaves the dialog open with its report, which is the useful
  // failure to surface rather than a bare timeout on the list.
  const submit = dialog.getByRole('button', { name: /verify\s*&\s*create|^create$/i });
  await expect(submit).toBeEnabled({ timeout: 15000 });
  await submit.click();
  await expect(dialog).toBeHidden({ timeout: 60000 }).catch(async () => {
    const report = await dialog.innerText().catch(() => '');
    throw new Error(`warehouse create did not complete (validation report):\n${report.replace(/\s+/g, ' ').slice(0, 600)}`);
  });
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

/** Open a namespace from the warehouse detail page's Namespaces table.
 *  The name appears twice — the sidebar nav tree (which does NOT navigate on
 *  click) and the table row (which does) — so this takes the last match, and
 *  retries until the route actually changes: the first click is regularly
 *  swallowed while the page is still settling. */
export async function openNamespace(page: Page, ns: string) {
  // Wait for THIS namespace in the route, not merely any namespace route. The
  // old guard was `url does not already contain /namespace/`, which is false as
  // soon as you are on one — so opening a child from a namespace page returned
  // immediately without clicking, and every "nested" namespace was created as a
  // sibling of the first.
  const target = new RegExp(`/namespace/[^/]*${ns}(?:[/?]|$)`);
  const row = page.getByText(ns, { exact: true }).last();
  for (let i = 0; i < 5 && !target.test(page.url()); i++) {
    await row.click().catch(() => {});
    await page.waitForURL(target, { timeout: 6000 }).catch(() => {});
  }
  await expect(page).toHaveURL(target, { timeout: 10000 });
}

/** Add a namespace on the currently-open warehouse detail page (idempotent). */
export async function addNamespace(page: Page, ns: string) {
  // Reuse if a prior spec already created it in this combo.
  if (await page.getByText(ns, { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false)) {
    return;
  }
  // On a NAMESPACE page sub-namespaces live behind the "Namespaces" tab
  // (NamespaceNamespaces is v-if'd on it); on a WAREHOUSE page they are the
  // default view. Without this the activator is never rendered, the click lands
  // on nothing, and every nested namespace ends up a sibling of the first.
  if (/\/namespace\//.test(page.url())) await selectTab(page, /^namespaces$/i);

  // A namespace page renders NamespaceAddDialog TWICE (toolbar + the table's
  // no-data slot) and the dialog's own submit is also called "Add Namespace",
  // so an unfiltered .first() can click a hidden activator — the click lands on
  // nothing and the field never appears. Take the visible activator, then scope
  // the field and submit to the dialog that opened.
  const addNs = page.getByRole('button', { name: /^add namespace$/i }).filter({ visible: true });
  await expect(addNs.first()).toBeVisible({ timeout: 15000 });

  // Selecting the tab reloads the list, which re-renders the toolbar — a click
  // dispatched at the old node hits a detached element and silently opens
  // nothing. Retry until the dialog's field is actually on screen.
  const field = page.getByLabel(/Namespace Name/i).filter({ visible: true }).first();
  for (let i = 0; i < 4; i++) {
    if (await field.isVisible({ timeout: 2000 }).catch(() => false)) break;
    await addNs.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await expect(field, 'the Add Namespace dialog never opened').toBeVisible({ timeout: 10000 });
  await field.fill(ns);

  const submit = page.getByRole('button', { name: /^add namespace$/i }).filter({ visible: true }).last();
  await expect(submit).toBeEnabled({ timeout: 5000 });
  await submit.click();
  await expect(page.getByText(ns, { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

/** Full seed: create warehouse + open it + add a namespace. Returns { wh, ns }. */
export async function seedWarehouseWithNamespace(
  page: Page,
  backend: StorageBackend,
  ns = 'demo_ns',
  suffix = process.env.E2E_RESOURCE_SUFFIX || '',
) {
  const wh = await createWarehouse(page, backend, suffix);
  await openWarehouse(page, wh);
  await addNamespace(page, ns);
  return { wh, ns };
}


/**
 * Select a v-tab and make sure it STAYS selected.
 *
 * Vuetify resets the tab while the pane's data loads, so a single click often
 * registers as a hover and the window never switches — which is why the nested
 * journey kept looking for an "Add Table" button on the Namespaces pane. Click
 * until aria-selected sticks (the repo's own documented gotcha).
 */
export async function selectTab(page: Page, name: RegExp, scope?: Locator) {
  const root = scope ?? page;
  const tab = root.getByRole('tab', { name }).filter({ visible: true }).first();
  if (!(await tab.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await page.waitForLoadState('networkidle').catch(() => {});
  for (let i = 0; i < 6; i++) {
    if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') {
      await page.waitForLoadState('networkidle').catch(() => {});
      return true;
    }
    await tab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await expect(tab, `tab ${name} never became selected`).toHaveAttribute('aria-selected', 'true', {
    timeout: 10000,
  });
  return true;
}

/** Add an Iceberg table from the currently-open namespace page (idempotent).
 *  The schema starts empty, so a field has to be added before Create enables. */
export async function addTable(page: Page, tbl: string, field = 'a') {
  // Same tab gating as sub-namespaces: on a namespace page the table list (and
  // its "Add Table" button) only render when the Tables tab is selected.
  if (/\/namespace\//.test(page.url())) await selectTab(page, /^tables$/i);

  // Two buttons say "Add Table" here: TableRegister (mdi-table-arrow-down) and
  // TableCreate (mdi-table-plus). The window item uses v-show, so both sit in
  // the DOM even while the tab is hidden — an unfiltered .first() picked a
  // hidden node, and once visible it picked REGISTER rather than create. Target
  // the create icon explicitly.
  const add = page.locator('button:has(.mdi-table-plus)').filter({ visible: true }).first();
  await expect(add).toBeVisible({ timeout: 15000 });
  await add.click();

  const dialog = page.locator('.v-dialog').filter({ hasText: 'Create Table' }).last();
  await dialog.getByLabel(/Table Name/i).fill(tbl);
  await dialog.getByRole('button', { name: /add field/i }).click();
  await dialog.getByLabel(/Field Name/i).first().fill(field);

  const create = dialog.getByRole('button', { name: /^create table$/i });
  await expect(create).toBeEnabled({ timeout: 10000 });
  await create.click();
  // The dialog closes itself on success, after a short confirmation.
  await expect(dialog).toBeHidden({ timeout: 20000 });
}

/** The sidebar navigation tree's item for a name, whatever its depth. */
export function navTreeItem(page: Page, name: string) {
  return page.getByRole('treeitem', { name: new RegExp(`\\b${name}\\b`) }).first();
}

/** Select rows in the namespace's table list and bulk-delete them. */
export async function bulkDeleteTables(page: Page, names: string[]) {
  for (const name of names) {
    const row = page.getByRole('row', { name: new RegExp(`\\b${name}\\b`) }).first();
    await row.getByRole('checkbox').first().check();
  }
  await page.getByRole('button', { name: new RegExp(`^delete \\(${names.length}\\)$`, 'i') }).click();

  const dialog = page.locator('.v-dialog').filter({ hasText: /Delete \d+ tables?\?/ }).last();
  await dialog.getByRole('button', { name: /^delete$/i }).click();
  // The dialog stays open to report per-table outcomes; Cancel becomes Close.
  await expect(dialog.getByRole('button', { name: /^close$/i })).toBeVisible({ timeout: 30000 });
  await dialog.getByRole('button', { name: /^close$/i }).click();
}
