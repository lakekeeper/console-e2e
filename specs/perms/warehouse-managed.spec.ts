import { Browser, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { gotoReady, recoverFromOffline } from '../_utils/app';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  openWarehouse,
  openWarehouseSettings,
  refreshWarehouses,
  seedWarehouseWithNamespace,
  selectStorageProviderTab,
  selectTab,
} from '../_utils/warehouse';
import { grantOnCurrentPanel, revokeAllOnCurrentPanel } from '../_utils/permissions';

// `managed-by: instance-admin` keeps a warehouse's spec — name, storage and
// credentials, protection, status, deletion — for instance admins. Its owners
// keep the deletion profile, the format-version policy and task-queue config.
//
// The console used to hide Warehouse settings from a non-admin altogether, so an
// owner could not reach even the parts the server lets them change. Now the
// dialog opens, and only the admin-only parts are locked, each saying why.
//
// OpenFGA only: anna gets `modify` (rename, storage, protection, soft deletion,
// format policy) through the Grants tab; peter is the instance admin
// (LAKEKEEPER__INSTANCE_ADMINS in modes/authz.env). Tier 2 like the other
// refusal specs: in a fresh project anna never sees the warehouse.

const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

const SUFFIX = process.env.E2E_RESOURCE_SUFFIX || '';
const MANAGED_REASON = 'Managed by an instance admin: only instance admins can change this.';

/** The managed-by switch, labelled by its state. */
const managedSwitch = (scope: Page | ReturnType<Page['locator']>) =>
  scope.getByRole('checkbox', { name: /^(Self-managed|Managed by instance admin)$/ }).first();

async function annaOpensWarehouse(browser: Browser, wh: string) {
  const ctx = await browser.newContext({ baseURL: ANNA_BASE_URL });
  const page = await ctx.newPage();
  await login(page, TEST_USER_2);
  const row = page.getByRole('row', { name: new RegExp(wh) }).getByText(wh, { exact: true });
  for (let i = 0; i < 5; i++) {
    await gotoReady(page, '/ui/warehouse');
    await refreshWarehouses(page);
    if (await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) break;
    await page.reload().catch(() => {});
    await recoverFromOffline(page);
  }
  await expect(row, `anna should see ${wh} once granted`).toBeVisible({ timeout: 10000 });
  for (let i = 0; i < 4 && !/\/ui\/warehouse\/[^/]+/.test(page.url()); i++) {
    await row.click().catch(() => {});
    await page.waitForURL(/\/ui\/warehouse\/[^/]+/, { timeout: 5000 }).catch(() => {});
  }
  await expect(page).toHaveURL(/\/ui\/warehouse\/[^/]+/, { timeout: 5000 });
  return { ctx, page };
}

test.describe('warehouse managed by an instance admin @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] }, isolatedProject: false });

  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  let seeded: string | null = null;
  test.afterEach(async ({ bootstrappedPage: page }) => {
    if (!seeded) return;
    try {
      await openWarehouse(page, seeded);
      if (await selectTab(page, /^grants$/i)) await revokeAllOnCurrentPanel(page, 'anna');
    } catch {
      /* cleanup must never fail the test it is cleaning up after */
    }
    seeded = null;
  });

  test('an owner who is not an instance admin edits what is theirs; the rest is locked with the reason', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.setTimeout(300_000);

    const { wh } = await test.step('1 · peter marks a warehouse managed and grants anna modify', async () => {
      const seed = await seedWarehouseWithNamespace(page, backend!, 'managed_ns', `rfmanaged${SUFFIX}`);
      seeded = seed.wh;
      await openWarehouse(page, seed.wh);

      const dialog = await openWarehouseSettings(page);
      const managed = managedSwitch(dialog);
      await expect(managed).toBeVisible({ timeout: 20000 });
      if (!(await managed.isChecked())) {
        await managed.click();
        await dialog.getByRole('button', { name: /^save settings$/i }).click();
        await expect(page.getByText('Warehouse settings updated successfully')).toBeVisible({
          timeout: 20000,
        });
      }
      await dialog.locator('.v-toolbar button:has(.mdi-close)').first().click();

      await openWarehouse(page, seed.wh);
      await selectTab(page, /^grants$/i);
      await grantOnCurrentPanel(page, 'anna', ['describe', 'modify']);
      return seed;
    });

    const { ctx, page: anna } = await annaOpensWarehouse(browser, wh);
    try {
      const dialog = await test.step('2 · the menu says the warehouse is managed, and still offers Settings', async () => {
        await anna.locator('button:has(.mdi-cog)').first().click();
        await expect(anna.getByText('Managed by instance admin').first()).toBeVisible({ timeout: 15000 });
        await expect(anna.getByText('Storage, name and protection are admin-only')).toBeVisible();
        await anna.keyboard.press('Escape');
        return openWarehouseSettings(anna);
      });

      await test.step('3 · name and protection are locked, saying why', async () => {
        const name = dialog.getByLabel(/Warehouse Name/i).first();
        await expect(name).toHaveAttribute('readonly', /.*/, { timeout: 20000 });
        await expect(dialog.getByText(MANAGED_REASON)).toHaveCount(2);
        // Only instance admins see the managed-by switch at all.
        await expect(managedSwitch(dialog)).toHaveCount(0);
      });

      await test.step('4 · the deletion profile is anna’s: she changes it and it saves', async () => {
        const soft = dialog.getByRole('checkbox', { name: /^(Enabled|Disabled)$/ }).first();
        await expect(
          dialog.getByText('You are not allowed to change soft deletion on this warehouse.'),
        ).toHaveCount(0);
        await soft.click();
        await dialog.getByRole('button', { name: /^save settings$/i }).click();
        await expect(anna.getByText('Warehouse settings updated successfully')).toBeVisible({
          timeout: 20000,
        });
      });

      await test.step('5 · the storage pane is read-only, saying why', async () => {
        await selectStorageProviderTab(anna, dialog);
        await expect(
          dialog.getByText(/managed by an instance admin: only instance admins can change its storage/i),
        ).toBeVisible({ timeout: 15000 });
        await expect(dialog.getByRole('button', { name: /update credentials/i })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: /update profile/i })).toHaveCount(0);
      });
    } finally {
      await ctx.close();
    }

    await test.step('6 · peter, the instance admin, still has every part editable', async () => {
      await openWarehouse(page, wh);
      const dialog = await openWarehouseSettings(page);
      await expect(dialog.getByLabel(/Warehouse Name/i).first()).not.toHaveAttribute('readonly', /.*/, {
        timeout: 20000,
      });
      await expect(dialog.getByText(MANAGED_REASON)).toHaveCount(0);
      await expect(managedSwitch(dialog)).toBeChecked();
    });
  });
});
