import { Browser, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { gotoReady, recoverFromOffline } from '../_utils/app';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  ensureTable,
  openNamespace,
  openTable,
  openWarehouse,
  refreshWarehouses,
  seedWarehouseWithNamespace,
  selectTab,
  addNamespace,
} from '../_utils/warehouse';
import { grantOnCurrentPanel, revokeAllOnCurrentPanel } from '../_utils/permissions';

// A missing right must never look like missing data, and nothing may be offered
// that the server will refuse. These journeys check the namespace surfaces for a
// user (anna) who can see a namespace but not change it:
//
//   • the namespace's Tables list offers no Rename / Delete per row and no bulk
//     Delete — the rights are asked per row (batch check) before the click;
//   • the namespace Settings menu offers no "Delete namespace";
//   • the protection lookups on the table page raise no snackbar;
//   • a namespace she cannot see at all says so, in the header and in the
//     Settings menu, instead of a header with no id and an empty menu.
//
// OpenFGA only: the grants are made through the Grants tab. Under OpenFGA a
// namespace `describe` inherits down to its tables (describe → get_metadata) but
// carries none of the modify-backed rights (drop, rename, create_table, delete).
// A namespace she holds nothing on answers 404 "not found or access denied" —
// the catalog does not tell her it exists.
//
// Tier 2 (shared project), as in access-control.spec.ts: in a fresh project anna
// is denied the project's get_metadata and never sees the warehouse at all.
// Each test uses its own warehouse and revokes anna in afterEach.

const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

const SUFFIX = process.env.E2E_RESOURCE_SUFFIX || '';

/** Every snackbar text shown in this page, from the first paint on. A snackbar
 *  lasts a few seconds, so asserting at the end alone would miss it. */
async function watchSnackbars(target: Page) {
  await target.addInitScript(() => {
    const w = window as any;
    w.__e2eSnacks = [];
    new MutationObserver(() => {
      for (const el of Array.from(document.querySelectorAll('.v-snackbar__content'))) {
        const t = (el.textContent || '').trim();
        if (t && !w.__e2eSnacks.includes(t)) w.__e2eSnacks.push(t);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

async function snackbars(target: Page): Promise<string[]> {
  return target.evaluate(() => (window as any).__e2eSnacks ?? []);
}

/** anna, in her own context, on the warehouse's detail page. A restricted user's
 *  first calls 401 while the token hydrates, so reload until the row appears. */
async function annaOpensWarehouse(browser: Browser, wh: string) {
  const ctx = await browser.newContext({ baseURL: ANNA_BASE_URL });
  const page = await ctx.newPage();
  await watchSnackbars(page);
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

function warehouseIdFromUrl(target: Page): string {
  return target.url().match(/\/warehouse\/([^/?#]+)/)?.[1] ?? '';
}

/** The row of a table in the namespace's Tables list. */
function tableRow(target: Page, tbl: string) {
  return target.getByRole('row', { name: new RegExp(`\\b${tbl}\\b`) }).first();
}

/** Open the namespace header's Settings menu and return its list. */
async function openNamespaceSettings(target: Page) {
  const trigger = target.getByRole('button', { name: /^settings$/i }).filter({ visible: true }).first();
  const menu = target.locator('.v-overlay__content .v-list').filter({ visible: true }).last();
  for (let i = 0; i < 3; i++) {
    await trigger.click({ timeout: 10000 }).catch(() => {});
    if (await menu.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) return menu;
  }
  await expect(menu, 'the namespace Settings menu never opened').toBeVisible({ timeout: 5000 });
  return menu;
}

async function revokeAnna(page: Page, wh: string, ns: string) {
  try {
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    if (await selectTab(page, /^grants$/i)) await revokeAllOnCurrentPanel(page, 'anna');
  } catch {
    /* cleanup must never fail the test it is cleaning up after */
  }
}

test.describe('namespace refusals @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] }, isolatedProject: false });

  // The local Silo warehouse: no cloud credentials, runs wherever the suite does.
  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  const ns = 'nsref_ns';
  const hiddenNs = 'nsref_hidden';
  const tbl = 'nsref_tbl';
  let seeded: string | null = null;
  test.afterEach(async ({ bootstrappedPage: page }) => {
    if (seeded) await revokeAnna(page, seeded, ns);
    seeded = null;
  });

  test('anna with describe only is offered no Rename, Delete or protection snackbar', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.setTimeout(300_000);

    const { wh } = await test.step('1 · peter seeds a table and grants anna namespace describe', async () => {
      const seed = await seedWarehouseWithNamespace(page, backend!, ns, `nsrefro${SUFFIX}`);
      seeded = seed.wh;
      await openWarehouse(page, seed.wh);
      await openNamespace(page, ns);
      await ensureTable(page, tbl);
      // A namespace describe makes the warehouse visible (visible_below) and
      // inherits describe to the table; nothing modify-backed comes with it.
      await openWarehouse(page, seed.wh);
      await openNamespace(page, ns);
      await selectTab(page, /^grants$/i);
      await grantOnCurrentPanel(page, 'anna', ['describe']);
      return seed;
    });

    const { ctx, page: anna } = await annaOpensWarehouse(browser, wh);
    try {
      await test.step('2 · the Tables list shows the table with no row actions', async () => {
        await openNamespace(anna, ns);
        await selectTab(anna, /^tables$/i);
        const row = tableRow(anna, tbl);
        await expect(row, 'anna should see the table: describe inherits to it').toBeVisible({
          timeout: 20000,
        });
        // The per-row check has answered once the page is quiet; only then is
        // "no button" a no rather than "not asked yet".
        await anna.waitForLoadState('networkidle').catch(() => {});
        await anna.waitForTimeout(1500);
        await expect(row.locator('button:has(.mdi-pencil-outline)')).toHaveCount(0);
        await expect(row.locator('button:has(.mdi-delete-outline)')).toHaveCount(0);
      });

      await test.step('3 · selecting the row offers no bulk Delete', async () => {
        await tableRow(anna, tbl).getByRole('checkbox').first().check();
        await expect(anna.getByText(/1 selected/)).toBeVisible({ timeout: 5000 });
        await anna.waitForLoadState('networkidle').catch(() => {});
        await anna.waitForTimeout(1000);
        await expect(anna.getByRole('button', { name: /^delete \(1\)$/i })).toHaveCount(0);
      });

      await test.step('4 · the namespace Settings menu offers no Delete', async () => {
        const menu = await openNamespaceSettings(anna);
        await expect(menu.getByText('Namespace settings')).toBeVisible({ timeout: 10000 });
        await expect(menu.getByText('Delete namespace')).toHaveCount(0);
        await anna.keyboard.press('Escape').catch(() => {});
      });

      await test.step('5 · the table page loads its protection without a snackbar', async () => {
        await openTable(anna, tbl);
        await expect(anna.getByText('Protection', { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });
        await anna.waitForLoadState('networkidle').catch(() => {});
        await anna.waitForTimeout(1500);
        const snacks = await snackbars(anna);
        expect(
          snacks.filter((t) => /protection/i.test(t)),
          `no protection snackbar expected, saw: ${JSON.stringify(snacks)}`,
        ).toEqual([]);
        // She holds get_metadata on the table, so the tile has a value, not a refusal.
        await expect(anna.getByText('not visible to you', { exact: true })).toHaveCount(0);
      });
    } finally {
      await ctx.close();
    }
  });

  test('anna is told a namespace she cannot see is not visible to her', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.setTimeout(300_000);

    const { wh, whId } = await test.step('1 · peter seeds two namespaces, grants anna one', async () => {
      const seed = await seedWarehouseWithNamespace(page, backend!, ns, `nsrefmeta${SUFFIX}`);
      seeded = seed.wh;
      await openWarehouse(page, seed.wh);
      const id = warehouseIdFromUrl(page);
      expect(id, 'could not read the warehouse id from the route').not.toBe('');
      await addNamespace(page, hiddenNs);
      await openWarehouse(page, seed.wh);
      await openNamespace(page, ns);
      await selectTab(page, /^grants$/i);
      await grantOnCurrentPanel(page, 'anna', ['describe']);
      return { wh: seed.wh, whId: id };
    });

    const { ctx, page: anna } = await annaOpensWarehouse(browser, wh);
    try {
      await test.step('2 · deep-linked to the other namespace, the header says why it is blank', async () => {
        await gotoReady(anna, `/ui/warehouse/${whId}/namespace/${hiddenNs}`);
        await expect(
          anna.getByText(/does not exist or you do not have sufficient rights/i).first(),
        ).toBeVisible({ timeout: 20000 });
        await expect(anna.getByText(/not visible to you/i).first()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step('3 · its Settings menu says nothing is available, rather than opening empty', async () => {
        const menu = await openNamespaceSettings(anna);
        await expect(menu.getByText('No settings available to you.')).toBeVisible({
          timeout: 10000,
        });
        await expect(menu.getByText('Delete namespace')).toHaveCount(0);
        await expect(menu.getByText('Namespace settings')).toHaveCount(0);
        await anna.keyboard.press('Escape').catch(() => {});
      });
    } finally {
      await ctx.close();
    }
  });

  // Positive control: the gates must not lock out whoever does hold the rights.
  test('peter is offered Rename, Delete and bulk Delete on the same list', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(240_000);
    const { wh } = await seedWarehouseWithNamespace(page, backend!, ns, `nsrefpeter${SUFFIX}`);
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    await ensureTable(page, tbl);

    await test.step('1 · the row offers Rename and Delete once its rights have answered', async () => {
      await selectTab(page, /^tables$/i);
      const row = tableRow(page, tbl);
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row.locator('button:has(.mdi-pencil-outline)')).toBeVisible({ timeout: 20000 });
      await expect(row.locator('button:has(.mdi-delete-outline)')).toBeVisible({ timeout: 20000 });
    });

    await test.step('2 · selecting the row offers bulk Delete', async () => {
      await tableRow(page, tbl).getByRole('checkbox').first().check();
      await expect(page.getByRole('button', { name: /^delete \(1\)$/i })).toBeVisible({
        timeout: 20000,
      });
      await tableRow(page, tbl).getByRole('checkbox').first().uncheck();
    });

    await test.step('3 · the Settings menu offers Delete namespace', async () => {
      const menu = await openNamespaceSettings(page);
      await expect(menu.getByText('Delete namespace')).toBeVisible({ timeout: 15000 });
      await expect(menu.getByText('No settings available to you.')).toHaveCount(0);
      await page.keyboard.press('Escape').catch(() => {});
    });

    await test.step('4 · the namespace details carry its id, not a refusal', async () => {
      await selectTab(page, /^details$/i);
      await expect(page.getByText('Namespace ID').first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/You are not allowed to read this namespace/)).toHaveCount(0);
      await expect(page.getByText(/not visible to you/i)).toHaveCount(0);
    });
  });
});
