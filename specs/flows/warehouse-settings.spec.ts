import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse, warehouseName } from '../_utils/warehouse';

// Saving storage from the fullscreen settings dialog used to report success in a
// snackbar and leave the dialog sitting there, which reads as "nothing
// happened". The close is the whole observable outcome of the fix, and only a
// real save exercises it — the panes re-seed from the updated warehouse first,
// so the unsaved-changes guard has to have nothing left to complain about.
test.describe('warehouse settings @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);
  test.skip(!backend, 'no browser-reachable storage backend for deep flows');

  test('the settings dialog closes itself after a storage save', async ({
    bootstrappedPage: page,
  }) => {
    // Warehouse create + a server-side storage validation on save.
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);

    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);

    await test.step('1 · open Warehouse settings from the header cog', async () => {
      // The header's cog is an icon-only button, so it has no accessible name;
      // `mdi-cog-outline` on the menu entry is a different class and does not
      // collide with this.
      await page.locator('button:has(.mdi-cog)').first().click();
      await page.getByText('Warehouse settings', { exact: true }).click();
    });

    const dialog = page.locator('.v-overlay__content').filter({ hasText: /Warehouse|Settings/ }).last();
    await expect(dialog).toBeVisible({ timeout: 15000 });

    await test.step('2 · re-enter storage credentials and save', async () => {
      // Credentials are write-only, so the pane cannot pre-fill them — the same
      // filler the create flow uses puts them back.
      await dialog.getByRole('tab', { name: backend!.tab }).click();
      await backend!.fill(dialog);

      const update = dialog.getByRole('button', { name: /^update credentials$/i });
      await expect(update).toBeEnabled({ timeout: 15000 });
      await update.click();
    });

    await test.step('3 · the dialog closes itself', async () => {
      await expect(dialog).toBeHidden({ timeout: 30000 });
    });
  });
});
