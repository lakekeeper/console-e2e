import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { recoverFromOffline } from '../_utils/app';
import {
  ensureTable,
  openNamespace,
  openTable,
  openWarehouse,
  seedWarehouseWithNamespace,
} from '../_utils/warehouse';
import {
  MANIFEST_REWRITE_HINT,
  OPTIMIZE_DEFAULT_STEPS,
  OPTIMIZE_STEPS,
  isPlusApp,
  maintenanceDialog,
  openMaintenance,
  selectMaintenancePane,
  selectOptimizeConfigTab,
} from '../_utils/maintenance';

// Optimize maintenance, as console-plus offers it. Three things this covers,
// each of which failed silently rather than loudly when it was broken:
//
//  1. The queue-config key was renamed `enabled` -> `enable-optimize`. A client
//     on the old name is refused outright by the server ("unknown field
//     `enabled`"), and a client that reads the old name shows every warehouse as
//     Inactive while writing to a field nobody reads.
//  2. Saving the task configuration reported nothing at all: the write landed,
//     no snackbar was raised, and the unsaved-changes dot stayed lit — the one
//     visible signal said the save had failed.
//  3. The bulk schedule dialog offered no step picker, and closed itself on a
//     successful run, so the results it had just filled in vanished with the
//     closing animation.
//
// Plus-only: all of it comes from console-plus-components and the OSS console
// has no equivalent surface.
test.describe('optimize maintenance @authz @cedar', () => {
  test.skip(!isPlusApp, 'maintenance is a console-plus surface');

  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  test('the optimize queue config saves and says so', async ({ bootstrappedPage: page }) => {
    // Warehouse create plus two round-trips through the queue-config endpoint.
    test.setTimeout(180_000);

    const { wh } = await seedWarehouseWithNamespace(page, backend!);
    await openWarehouse(page, wh);

    const dialog = await openMaintenance(page);
    await selectMaintenancePane(dialog, /task configuration/i);
    await selectOptimizeConfigTab(dialog);

    // A refusal is rendered in place instead of the form — saving then skips
    // optimize entirely, so the rest of this test would assert nothing.
    const readRefusal = dialog.getByText(
      /not visible to you|does not offer the optimize queue|Could not read the optimize configuration/i,
    );
    await expect(readRefusal).toHaveCount(0);

    const master = dialog.getByLabel('Enable optimize').first();
    await expect(master).toBeVisible({ timeout: 20000 });
    const wasOn = await master.isChecked();

    await master.click();
    await expect(master).toBeChecked({ checked: !wasOn });

    // The rail marks the pane dirty; a successful save must clear it.
    const dirtyPane = dialog.getByRole('tab', { name: /task configuration/i }).first();
    await expect(dirtyPane.locator('.v-badge, .mdi-circle-small, [class*="dot"]').first()).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByRole('button', { name: /save configuration/i }).click();

    await test.step('the save reports itself', async () => {
      await expect(page.getByText('Task configuration saved.')).toBeVisible({ timeout: 20000 });
    });

    await test.step('and the unsaved-changes dot clears', async () => {
      await expect(
        dirtyPane.locator('.v-badge, .mdi-circle-small, [class*="dot"]').first(),
      ).toBeHidden({ timeout: 15000 });
    });

    await test.step('the new value survives a reload', async () => {
      await page.reload();
      await recoverFromOffline(page);
      const reopened = await openMaintenance(page);
      await selectMaintenancePane(reopened, /task configuration/i);
      await selectOptimizeConfigTab(reopened);
      await expect(reopened.getByLabel('Enable optimize').first()).toBeChecked({
        checked: !wasOn,
        timeout: 20000,
      });
    });

    // Leave the warehouse as it was found: combos share backend state.
    const restore = maintenanceDialog(page);
    await restore.getByLabel('Enable optimize').first().click();
    await restore.getByRole('button', { name: /save configuration/i }).click();
    await expect(page.getByText('Task configuration saved.')).toBeVisible({ timeout: 20000 });
  });

  test('the table schedule pane narrows an optimize run to steps', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180_000);

    const { wh, ns } = await seedWarehouseWithNamespace(page, backend!);
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    const tbl = `opt_steps_${(process.env.E2E_RESOURCE_SUFFIX || 'x').replace(/\W/g, '')}`;
    await ensureTable(page, tbl);
    await openTable(page, tbl);

    const dialog = await openMaintenance(page);
    await selectMaintenancePane(dialog, /schedule task/i);

    // Optimize is the one task made of steps, so the picker appears only once it
    // is the chosen task.
    await expect(dialog.getByText('STEPS', { exact: true })).toHaveCount(0);
    await dialog.getByText('Optimize', { exact: true }).first().click();

    await test.step('every step is offered, the usual pair preselected', async () => {
      for (const step of OPTIMIZE_STEPS) {
        await expect(dialog.getByText(step, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });
      }
      await expect(dialog.getByText(/The usual run: compaction and manifest rewrite/i)).toBeVisible();
      // The default pair sends no step list at all, so the caption must NOT be
      // the narrowed one — that difference is the whole behaviour.
      await expect(dialog.getByText(MANIFEST_REWRITE_HINT)).toHaveCount(0);
    });

    await test.step('narrowing to the manifest rewrite explains what it does', async () => {
      await dialog.getByText(OPTIMIZE_DEFAULT_STEPS[0], { exact: true }).first().click();
      await expect(dialog.getByText(/Only the chosen steps run/i)).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByText(MANIFEST_REWRITE_HINT)).toBeVisible();
    });

    await test.step('and dropping it takes the explanation away', async () => {
      await dialog.getByText('Rewrite manifests', { exact: true }).first().click();
      await expect(dialog.getByText(/Pick at least one step/i)).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByText(MANIFEST_REWRITE_HINT)).toHaveCount(0);
    });
  });

  test('the bulk schedule dialog offers the same steps and keeps its results', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(240_000);

    const { wh, ns } = await seedWarehouseWithNamespace(page, backend!);
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    const tbl = `opt_bulk_${(process.env.E2E_RESOURCE_SUFFIX || 'x').replace(/\W/g, '')}`;
    await ensureTable(page, tbl);

    await page.goto('/ui/maintenance');
    await page.waitForLoadState('domcontentloaded');
    await recoverFromOffline(page);

    await page.getByRole('button', { name: /schedule/i }).first().click();
    const dialog = page
      .locator('.v-overlay__content')
      .filter({ hasText: 'Schedule maintenance task' })
      .last();
    await expect(dialog).toBeVisible({ timeout: 30000 });

    // Pick the table in the tree on the left.
    await dialog.getByText(wh, { exact: true }).first().click();
    await dialog.getByText(tbl, { exact: true }).first().click();
    await expect(dialog.getByText(/SELECTED TABLES \(1\)/i)).toBeVisible({ timeout: 20000 });

    const optimize = dialog.getByRole('checkbox', { name: /^optimize$/i }).first();
    await optimize.check();

    await test.step('the steps appear, the usual pair preselected', async () => {
      // Regression: these were rendered through a v-chip-group, whose slide-group
      // measured zero inside the dialog's scrolling flex column and hid every
      // chip — heading and caption visible, nothing between them.
      for (const step of OPTIMIZE_STEPS) {
        await expect(dialog.getByText(step, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });
      }
      await expect(dialog.getByText(/The usual run: compaction and manifest rewrite/i)).toBeVisible();
    });

    await test.step('an empty pick blocks scheduling, with a reason', async () => {
      for (const step of OPTIMIZE_DEFAULT_STEPS) {
        await dialog.getByText(step, { exact: true }).first().click();
      }
      await expect(dialog.getByText(/Pick at least one optimize step/i)).toBeVisible({
        timeout: 10000,
      });
    });

    await test.step('the manifest rewrite explains itself once narrowed', async () => {
      await dialog.getByText('Rewrite manifests', { exact: true }).first().click();
      await expect(dialog.getByText(MANIFEST_REWRITE_HINT)).toBeVisible({ timeout: 10000 });
    });

    await test.step('a successful run leaves its results on screen', async () => {
      await dialog.getByRole('button', { name: /^schedule$/i }).last().click();
      // The dialog used to close itself when nothing failed, taking the results
      // with it. It must stay up, and the footer must offer Close.
      await expect(dialog.getByText(/scheduled/i).first()).toBeVisible({ timeout: 60000 });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: /^close$/i })).toBeVisible();
    });
  });
});
