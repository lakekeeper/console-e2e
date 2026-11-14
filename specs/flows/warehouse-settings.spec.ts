import { Locator, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { recoverFromOffline } from '../_utils/app';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  createWarehouse,
  openWarehouse,
  warehouseName,
  selectTab,
  openWarehouseSettings,
  selectStorageProviderTab,
  warehouseDialog,
} from '../_utils/warehouse';

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

    // Opening it is a step of its own: the menu entry can swallow a click and
    // leave the menu open with no dialog behind it, so the helper retries.
    const dialog = await test.step('1 · open Warehouse settings from the header cog', () =>
      openWarehouseSettings(page));

    await test.step('2 · re-enter the storage credentials', async () => {
      // Same as the reachability spec: the settings rail labels the provider by
      // storage type, not by the create-dialog entry, so pick the single
      // provider entry rather than matching backend.tab.
      await selectStorageProviderTab(page, dialog);

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

  /** The Soft deletion switch of the Settings pane (labelled by its state). */
  const softSwitch = (dialog: Locator) =>
    dialog.getByRole('checkbox', { name: /^(Enabled|Disabled)$/ }).first();
  /** The dialog's own close (×, top left of its toolbar). */
  const closeButton = (dialog: Locator) => dialog.locator('.v-toolbar button:has(.mdi-close)').first();
  /** The deletion-profile chip on the Details tab. */
  const profileChip = (page: Page) =>
    page.locator('.v-chip').filter({ hasText: /^\s*(hard|soft)\s*$/ }).first();

  // The menu mounts the settings dialog before the warehouse has been read, so
  // its storage pane used to keep the placeholder profile (an empty S3 bucket)
  // until a save. Opening it straight after a reload is that race.
  test('the storage pane shows the stored profile, even opened right after a reload', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);
    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);

    await page.reload();
    await recoverFromOffline(page);
    const dialog = await openWarehouseSettings(page);
    await selectStorageProviderTab(page, dialog);

    const bucket = dialog.getByLabel(/^Bucket( \*)?$/i).filter({ visible: true }).first();
    await expect(bucket).toHaveValue(process.env.S3_LOCAL_BUCKET || 'lakekeeper-test', {
      timeout: 20000,
    });
  });

  // The dialog stays mounted inside the menu, so closing alone kept an edit for
  // the next open; "Discard and close" has to put the panes back.
  test('Discard and close throws the edit away for the next open', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);
    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);

    const dialog = await openWarehouseSettings(page);
    const name = dialog.getByLabel(/Warehouse Name/i).first();
    await expect(name).toHaveValue(wh, { timeout: 20000 });

    await test.step('1 · edit the name, then close and discard', async () => {
      await name.fill(`${wh}-edited`);
      await closeButton(dialog).click();
      await page.getByRole('button', { name: /^discard and close$/i }).click();
      await expect(dialog).toBeHidden({ timeout: 10000 });
    });

    await test.step('2 · reopened, the name is the stored one and nothing is unsaved', async () => {
      const again = await openWarehouseSettings(page);
      await expect(again.getByLabel(/Warehouse Name/i).first()).toHaveValue(wh, { timeout: 10000 });
      await expect(again.getByRole('button', { name: /^save settings$/i })).toBeDisabled();
    });
  });

  // Details holds its own copy of the warehouse; a save in Settings used to
  // leave its deletion-profile chip on the old value until the page reloaded.
  test('the Details tab shows a saved deletion profile without a reload', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);
    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);
    await selectTab(page, /^details$/i);

    const before = ((await profileChip(page).innerText({ timeout: 20000 })) || '').trim();
    const after = before === 'hard' ? 'soft' : 'hard';

    await test.step(`1 · switch soft deletion ${after === 'soft' ? 'on' : 'off'} and save`, async () => {
      const dialog = await openWarehouseSettings(page);
      await softSwitch(dialog).click();
      await dialog.getByRole('button', { name: /^save settings$/i }).click();
      await expect(page.getByText('Warehouse settings updated successfully')).toBeVisible({
        timeout: 20000,
      });
      await closeButton(dialog).click();
      await expect(dialog).toBeHidden({ timeout: 10000 });
    });

    await test.step(`2 · Details says ${after}, with no reload`, async () => {
      await expect(profileChip(page)).toHaveText(after, { timeout: 15000 });
    });
  });

  // The chip is where people look for the switch, so it opens the settings at it.
  test('the deletion-profile chip opens Settings at the soft-deletion switch', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const wh = warehouseName(backend!);
    await createWarehouse(page, backend!);
    await openWarehouse(page, wh);
    await selectTab(page, /^details$/i);

    await profileChip(page).click({ timeout: 20000 });
    const dialog = warehouseDialog(page);
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByRole('tab', { name: /^settings$/i })).toHaveAttribute('aria-selected', 'true');
    await expect(softSwitch(dialog)).toBeVisible();
  });
});
