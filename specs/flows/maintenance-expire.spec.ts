import { Locator, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { recoverFromOffline } from '../_utils/app';
import { openWarehouse, seedWarehouseWithNamespace } from '../_utils/warehouse';
import { isPlusApp, openMaintenance, selectMaintenancePane } from '../_utils/maintenance';

// Expire snapshots refuses ages under 24 hours unless `disable-min-age-check` is
// set in the same config: a typo like `max-snapshot-age-ms: 6000` would otherwise
// remove nearly all history of every table in the warehouse. The form used to
// accept any age ≥ 0 and only failed on save, and rounded a sub-day age to a
// whole day on display.
//
// Plus-only: the task-queue config comes from console-plus-components.
test.describe('expire snapshots maintenance @authz @cedar', () => {
  test.skip(!isPlusApp, 'maintenance is a console-plus surface');

  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  const FLOOR_MESSAGE = 'At least 1 day, unless the 24-hour minimum check is disabled';

  async function openExpireTab(page: Page): Promise<Locator> {
    const dialog = await openMaintenance(page);
    await selectMaintenancePane(dialog, /task configuration/i);
    const tab = dialog.getByRole('tab', { name: /expire snapshots/i }).first();
    for (let i = 0; i < 5 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) {
      await tab.click({ timeout: 8000 }).catch(() => {});
    }
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
    return dialog;
  }

  test('ages under a day need the 24-hour check disabled, and the choice is saved', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);
    const { wh } = await seedWarehouseWithNamespace(page, backend!);
    await openWarehouse(page, wh);

    let dialog = await openExpireTab(page);
    const snapshotAge = () => dialog.getByLabel('Max Snapshot Age (days)').first();
    const refAge = () => dialog.getByLabel('Max Reference Age (days)').first();
    const bypass = () => dialog.getByLabel('Disable 24-hour minimum check').first();
    const save = () => dialog.getByRole('button', { name: /save configuration/i });

    await test.step('1 · turn expiration on', async () => {
      const enable = dialog.getByLabel('Enable automatic snapshot expiration').first();
      await expect(enable).toBeVisible({ timeout: 20000 });
      if (!(await enable.isChecked())) {
        await enable.click();
        await page.getByRole('button', { name: /^enable$/i }).click();
      }
      await expect(snapshotAge()).toBeVisible({ timeout: 10000 });
    });

    await test.step('2 · half a day is refused while the check is on', async () => {
      await snapshotAge().fill('0.5');
      await refAge().fill('0.5');
      await expect(dialog.getByText(FLOOR_MESSAGE)).toHaveCount(2);
      await expect(save()).toBeDisabled();
    });

    await test.step('3 · disabling the check warns, clears the error and saves', async () => {
      await bypass().click();
      await expect(dialog.getByText(/The 24-hour safety floor is disabled/)).toBeVisible();
      await expect(dialog.getByText(FLOOR_MESSAGE)).toHaveCount(0);
      await expect(save()).toBeEnabled();
      await save().click();
      await expect(page.getByText('Task configuration saved.')).toBeVisible({ timeout: 20000 });
    });

    await test.step('4 · after a reload the switch is still on and the age reads 0.5, not 1', async () => {
      await page.reload();
      await recoverFromOffline(page);
      dialog = await openExpireTab(page);
      await expect(bypass()).toBeChecked({ timeout: 20000 });
      await expect(snapshotAge()).toHaveValue('0.5');
    });

    await test.step('5 · turning the check back on brings the floor back', async () => {
      await bypass().click();
      await expect(dialog.getByText(FLOOR_MESSAGE).first()).toBeVisible();
      await expect(save()).toBeDisabled();
      // Leave a sane config behind.
      await snapshotAge().fill('5');
      await refAge().fill('5');
      await expect(save()).toBeEnabled();
      await save().click();
      await expect(page.getByText('Task configuration saved.')).toBeVisible({ timeout: 20000 });
    });
  });
});
