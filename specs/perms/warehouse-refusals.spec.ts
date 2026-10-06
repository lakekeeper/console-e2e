import { Browser, Locator, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { gotoReady, recoverFromOffline } from '../_utils/app';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  openNamespace,
  openWarehouse,
  openWarehouseSettings,
  refreshWarehouses,
  seedWarehouseWithNamespace,
  selectTab,
  selectStorageProviderTab,
} from '../_utils/warehouse';
import { grantOnCurrentPanel, revokeAllOnCurrentPanel } from '../_utils/permissions';

// A missing right must never look like missing data, and nothing may be offered
// that the server will refuse. These journeys check the warehouse surfaces for a
// user (anna) who can see a warehouse but not change it:
//
//   • the settings dialog shows every pane read-only, says which change is not
//     allowed, and offers no Save / Update / Test access;
//   • the Statistics tab is not offered without the statistics right, and the
//     OSS home page says the API-call chart is refused instead of hiding it.
//
// OpenFGA only: the grants are made through the Grants tab. Under OpenFGA a
// warehouse `describe` grants get_metadata and endpoint statistics but none of
// the modify-backed rights (rename, storage, protection, format policy, soft
// deletion). A `describe` on a namespace only makes the warehouse visible
// (`visible_below`) without `describe_effective`, so endpoint statistics are
// refused while the warehouse still opens.
//
// Tier 2 (shared project), as in access-control.spec.ts: in a fresh project anna
// is denied the project's get_metadata and never sees the warehouse at all.
// Each test uses its own warehouse (never demo-silo-<browser>, which
// access-control asserts anna cannot see) and revokes anna in afterEach.

const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

// The API-call chart on the home page is HomeStatistics only in the OSS console;
// console-plus draws it in HomeInsights.
const isOssConsole =
  process.env.SERVED_UI === '1'
    ? process.env.SERVED_APP === 'console'
    : (process.env.APP || 'console') === 'console';

const SUFFIX = process.env.E2E_RESOURCE_SUFFIX || '';

/** anna, in her own context, on the warehouse's detail page. A restricted user's
 *  first calls 401 while the token hydrates, so reload until the row appears. */
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

/** The settings pane asserts shared by the describe-only cases. */
async function expectSettingsReadOnly(dialog: Locator) {
  // Every part of the pane says it is refused — after the rights have answered,
  // so give it the time that takes.
  await expect(dialog.getByText('You are not allowed to rename this warehouse.')).toBeVisible({
    timeout: 20000,
  });
  await expect(
    dialog.getByText('You are not allowed to change the format policy of this warehouse.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('You are not allowed to change deletion protection on this warehouse.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('You are not allowed to change soft deletion on this warehouse.'),
  ).toBeVisible();

  // Read-only, not merely unsaved: the name cannot be typed into.
  await expect(dialog.getByLabel(/Warehouse Name/i).first()).toHaveAttribute('readonly', /.*/);

  // Nothing the server would refuse is offered.
  await expect(dialog.getByRole('button', { name: /save settings/i })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /test access/i })).toHaveCount(0);
}

async function revokeAnna(page: Page, wh: string, ns: string) {
  try {
    await openWarehouse(page, wh);
    if (await selectTab(page, /^grants$/i)) await revokeAllOnCurrentPanel(page, 'anna');
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    if (await selectTab(page, /^grants$/i)) await revokeAllOnCurrentPanel(page, 'anna');
  } catch {
    /* cleanup must never fail the test it is cleaning up after */
  }
}

test.describe('warehouse refusals @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] }, isolatedProject: false });

  // The local Silo warehouse: no cloud credentials, runs wherever the suite does.
  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  const ns = 'refusal_ns';
  let seeded: string | null = null;
  test.afterEach(async ({ bootstrappedPage: page }) => {
    if (seeded) await revokeAnna(page, seeded, ns);
    seeded = null;
  });

  test('anna with describe on a warehouse sees its settings read-only and cannot save', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.setTimeout(300_000);

    const { wh } = await test.step('1 · peter seeds a warehouse and grants anna describe', async () => {
      const seed = await seedWarehouseWithNamespace(page, backend!, ns, `rfdescribe${SUFFIX}`);
      seeded = seed.wh;
      await openWarehouse(page, seed.wh);
      await selectTab(page, /^grants$/i);
      await grantOnCurrentPanel(page, 'anna', ['describe']);
      return seed;
    });

    const { ctx, page: anna } = await annaOpensWarehouse(browser, wh);
    try {
      const dialog = await test.step('2 · anna opens Warehouse settings', () =>
        openWarehouseSettings(anna));

      await test.step('3 · the settings pane is read-only and says why', () =>
        expectSettingsReadOnly(dialog));

      await test.step('4 · the storage pane is read-only and offers no update', async () => {
        await selectStorageProviderTab(anna, dialog);
        await expect(
          dialog.getByText(/You are not allowed to change the storage of this warehouse\./),
        ).toBeVisible({ timeout: 15000 });
        await expect(dialog.getByRole('button', { name: /update credentials/i })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: /update profile/i })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: /^verify$/i })).toHaveCount(0);
        const access = dialog.getByLabel(/Access Key ID/i).filter({ visible: true }).first();
        if (await access.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
          await expect(access).toHaveAttribute('readonly', /.*/);
        }
      });
    } finally {
      await ctx.close();
    }
  });

  test('anna without the statistics right is not offered warehouse statistics', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.setTimeout(300_000);

    const { wh } = await test.step('1 · peter grants anna describe on a namespace only', async () => {
      const seed = await seedWarehouseWithNamespace(page, backend!, ns, `rfstats${SUFFIX}`);
      seeded = seed.wh;
      await openWarehouse(page, seed.wh);
      await openNamespace(page, ns);
      await selectTab(page, /^grants$/i);
      await grantOnCurrentPanel(page, 'anna', ['describe']);
      return seed;
    });

    if (isOssConsole) {
      await test.step('2 · the home chart says the API-call statistics are refused', async () => {
        const homeCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
        try {
          const home = await homeCtx.newPage();
          await login(home, TEST_USER_2);
          await recoverFromOffline(home);
          await expect(
            home.getByText('You are not allowed to read API call statistics for this project.'),
          ).toBeVisible({ timeout: 30000 });
        } finally {
          await homeCtx.close();
        }
      });
    }

    const { ctx, page: anna } = await annaOpensWarehouse(browser, wh);
    try {
      await test.step('3 · the warehouse opens, but Statistics is not offered', async () => {
        // Details renders the configuration (get_metadata holds via the
        // namespace grant) rather than a refusal.
        await selectTab(anna, /^details$/i);
        await expect(anna.getByText(/General Information/i).first()).toBeVisible({
          timeout: 15000,
        });
        await expect(
          anna.getByText("You are not allowed to read this warehouse's configuration."),
        ).toHaveCount(0);
        await expect(anna.getByRole('tab', { name: /^statistics$/i })).toHaveCount(0);
      });

      await test.step('4 · the settings are read-only here too', async () => {
        const dialog = await openWarehouseSettings(anna);
        await expectSettingsReadOnly(dialog);
      });
    } finally {
      await ctx.close();
    }
  });

  // Positive control: the gates must not lock out whoever does hold the rights.
  test('peter still edits and saves the warehouse settings', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(240_000);
    const { wh } = await seedWarehouseWithNamespace(page, backend!, ns, `rfpeter${SUFFIX}`);
    await openWarehouse(page, wh);

    const dialog = await test.step('1 · peter opens Warehouse settings', () =>
      openWarehouseSettings(page));

    await test.step('2 · nothing is refused, everything is offered', async () => {
      const save = dialog.getByRole('button', { name: /save settings/i });
      await expect(save).toBeVisible({ timeout: 20000 });
      await expect(dialog.getByRole('button', { name: /test access/i })).toBeVisible();
      await expect(dialog.getByText(/You are not allowed to/)).toHaveCount(0);
      await expect(dialog.getByLabel(/Warehouse Name/i).first()).not.toHaveAttribute(
        'readonly',
        /.*/,
      );
    });

    await test.step('3 · toggling protection saves, with no refusal in the pane', async () => {
      const protection = dialog.getByRole('switch', { name: /deletion protect/i }).first();
      const toggle = (await protection.count())
        ? protection
        : dialog.getByLabel(/deletion protect/i).first();
      await toggle.click();
      const save = dialog.getByRole('button', { name: /save settings/i });
      await expect(save).toBeEnabled({ timeout: 10000 });
      await save.click();
      await expect(page.getByText('Warehouse settings updated successfully').first()).toBeVisible({
        timeout: 15000,
      });
      await expect(dialog.getByText(/You are not allowed to|Could not change/)).toHaveCount(0);

      // Put it back so a later run starts from an unprotected warehouse.
      await toggle.click();
      await expect(save).toBeEnabled({ timeout: 10000 });
      await save.click();
    });

    await test.step('4 · the storage pane offers its updates', async () => {
      await selectStorageProviderTab(page, dialog);
      await expect(dialog.getByRole('button', { name: /update credentials/i })).toBeVisible({
        timeout: 15000,
      });
      await expect(
        dialog.getByText(/You are not allowed to change the storage of this warehouse/),
      ).toHaveCount(0);
    });
  });
});
