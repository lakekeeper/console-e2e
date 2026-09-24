import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse, warehouseName } from '../_utils/warehouse';

// Saving storage from the fullscreen settings dialog used to report success in a
// snackbar and leave the dialog sitting there, which reads as "nothing
// happened". The close IS the observable outcome of that fix, and only a real
// save exercises it — the panes re-seed from the updated warehouse first, so the
// unsaved-changes guard has to have nothing left to complain about.
test.describe('warehouse settings @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // The local Silo warehouse, not a cloud one: this needs no credentials beyond
  // what the compose stack already has, so it runs everywhere the suite does.
  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  test('the settings dialog closes itself after a storage save', async ({
    bootstrappedPage: page,
  }) => {
    // Warehouse create (idempotent — reuses demo-silo) plus a server-side
    // storage validation on save.
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);

    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);

    await test.step('1 · open Warehouse settings from the header cog', async () => {
      // Icon-only button, so it has no accessible name. `mdi-cog-outline` on the
      // menu entry is a different class and does not collide with this.
      await page.locator('button:has(.mdi-cog)').first().click();
      await page.getByText('Warehouse settings', { exact: true }).click();
    });

    const dialog = page.locator('.v-overlay__content').filter({ hasText: /Warehouse settings|STORAGE PROVIDER/i }).last();
    await expect(dialog).toBeVisible({ timeout: 15000 });

    await test.step('2 · re-enter the storage credentials', async () => {
      await dialog.getByRole('tab', { name: backend!.tab }).click();

      // Only the CREDENTIALS. The profile fields (bucket, region, endpoint) are
      // rendered readonly here because the stored profile is what the warehouse
      // already points at — filling them times out against a readonly input.
      // Credentials are write-only server-side, so they always have to be
      // retyped, which is exactly what "Update credentials" saves.
      const access = dialog.getByLabel(/Access Key ID/i).filter({ visible: true }).first();
      const secret = dialog.getByLabel(/Secret Access Key/i).filter({ visible: true }).first();
      await expect(access).toBeVisible({ timeout: 15000 });
      await access.fill(process.env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
      await secret.fill(process.env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret');
    });

    await test.step('3 · save, and the dialog closes itself', async () => {
      const update = dialog.getByRole('button', { name: /^update credentials$/i });
      await expect(update).toBeEnabled({ timeout: 15000 });
      await update.click();
      await expect(dialog).toBeHidden({ timeout: 60000 });
    });
  });
});
