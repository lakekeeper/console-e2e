import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  addNamespace,
  addTable,
  createWarehouse,
  openNamespace,
  openWarehouse,
  selectTab,
  warehouseName,
} from '../_utils/warehouse';

// A namespace lists everything it holds under one "Contents" tab: child
// namespaces first, then tables, views and datasets. Type chips narrow it, the
// chip lives in the URL, and the old per-type `?tab=` links (nav tree entries,
// the redirect after a drop, bookmarks) still land on the right type.
test.describe('namespace contents @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Creating a table through the catalog needs no browser-side storage access.
  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  const chip = (page: import('@playwright/test').Page, name: string) =>
    page.locator('.nsc-types .v-chip').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();
  const row = (page: import('@playwright/test').Page, name: string) =>
    page.locator('.nsc-table tbody tr:has(td)').filter({ hasText: name }).first();

  test('one list for namespaces and tables, with type chips and old links', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);

    await test.step('1 · a namespace holding a child namespace and a table', async () => {
      await createWarehouse(page, backend!);
      await openWarehouse(page, wh);
      await addNamespace(page, 'cnt_parent');
      await openNamespace(page, 'cnt_parent');
      await addNamespace(page, 'cnt_child');
      await addTable(page, 'cnt_tbl');
    });

    const base = page.url().split('?')[0];

    await test.step('2 · All lists both, the namespace first, each with its type', async () => {
      await selectTab(page, /^contents$/i);
      await chip(page, 'All').click();
      await expect(chip(page, 'All')).toHaveClass(/v-chip--selected/);
      await expect(row(page, 'cnt_child')).toContainText('Namespace', { timeout: 15000 });
      await expect(row(page, 'cnt_tbl')).toContainText('Iceberg table');

      const names = await page.locator('.nsc-table tbody tr td.nsc-name').allInnerTexts();
      const at = (n: string) => names.findIndex((t) => t.trim() === n);
      expect(at('cnt_child'), 'namespaces come before tables').toBeLessThan(at('cnt_tbl'));
    });

    await test.step('3 · an old ?tab=tables link opens Contents on Tables', async () => {
      await page.goto(`${base}?tab=tables`);
      await expect(page.getByRole('tab', { name: /^contents$/i })).toHaveAttribute('aria-selected', 'true', {
        timeout: 30000,
      });
      await expect(chip(page, 'Tables')).toHaveClass(/v-chip--selected/);
      await expect(page.getByText('cnt_tbl', { exact: true }).last()).toBeVisible({ timeout: 15000 });
    });

    await test.step('4 · chips combine, and the choice survives a reload through ?type=', async () => {
      // On Tables from step 3: adding Views shows both.
      await chip(page, 'Views').click();
      await expect(page).toHaveURL(/[?&]type=tables(,|%2C)views/);
      await page.reload();
      await expect(chip(page, 'Tables')).toHaveClass(/v-chip--selected/, { timeout: 30000 });
      await expect(chip(page, 'Views')).toHaveClass(/v-chip--selected/);
      await expect(chip(page, 'All')).not.toHaveClass(/v-chip--selected/);
    });

    await test.step('5 · a row in All opens what it names', async () => {
      await chip(page, 'All').click();
      await row(page, 'cnt_tbl').locator('td.nsc-name').click();
      await expect(page).toHaveURL(/\/table\/cnt_tbl/, { timeout: 15000 });
    });
  });

  // A click on a row (not its name) shows the details beside the list; the ⓘ
  // button per row does the same from the keyboard. Folded, the panel is inert,
  // and focus that was inside it goes back to whatever opened it.
  test('row details: click or keyboard, folded panel inert, focus returned', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);

    await test.step('1 · a namespace holding a table', async () => {
      await createWarehouse(page, backend!);
      await openWarehouse(page, wh);
      await addNamespace(page, 'det_parent');
      await openNamespace(page, 'det_parent');
      await addTable(page, 'det_tbl');
      await selectTab(page, /^contents$/i);
      await chip(page, 'All').click();
      await expect(row(page, 'det_tbl')).toBeVisible({ timeout: 15000 });
    });

    const panel = page.locator('.dsp');
    const details = page.locator('.cdp');

    await test.step('2 · a click on the row opens its Iceberg details', async () => {
      // The Type cell: the name is a link to the table and the buttons act.
      await row(page, 'det_tbl').locator('td').nth(2).click();
      await expect(details.locator('.cdp-title')).toContainText('det_tbl', { timeout: 15000 });
      await expect(details.getByText(/^Iceberg v\d$/)).toBeVisible({ timeout: 20000 });
      await expect(details.getByText('UUID', { exact: true })).toBeVisible();
      await expect(panel).toHaveJSProperty('inert', false);
      await expect(row(page, 'det_tbl')).toHaveClass(/nsc-row--active/);
    });

    await test.step('3 · a second click on the row folds it, and the folded panel is inert', async () => {
      await row(page, 'det_tbl').locator('td').nth(2).click();
      await expect(panel).toHaveJSProperty('inert', true, { timeout: 5000 });
      await expect(panel).toHaveAttribute('aria-hidden', 'true');
    });

    const info = page.getByRole('button', { name: 'Details of det_tbl' });

    await test.step('4 · the ⓘ button opens it from the keyboard', async () => {
      await info.focus();
      await page.keyboard.press('Enter');
      await expect(panel).toHaveJSProperty('inert', false, { timeout: 5000 });
      await expect(info).toHaveAttribute('aria-pressed', 'true');
      await expect(details.locator('.cdp-title')).toContainText('det_tbl');
    });

    await test.step('5 · closing from inside the panel hands focus back to ⓘ', async () => {
      await details.getByRole('button', { name: 'Close' }).click();
      await expect(panel).toHaveJSProperty('inert', true, { timeout: 5000 });
      await expect(info).toBeFocused();
      await expect(info).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('6 · Open in the panel goes to the table', async () => {
      await info.click();
      await details.getByRole('button', { name: /^open$/i }).click();
      await expect(page).toHaveURL(/\/table\/det_tbl/, { timeout: 15000 });
    });
  });
});
