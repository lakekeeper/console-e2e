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
});
