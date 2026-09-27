import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse } from '../_utils/warehouse';
import { gotoTagDefinitions } from '../_utils/tags';
import { login, TEST_USER_2, TEST_MODE } from '../_utils/auth';
import { seedNamespaces, seedTagDefinitions, grantNamespaces, findUserId, seededName } from '../_utils/seed';
import { expectTableScrollsWithinViewport, visibleDataTable, expectNoPageScroll } from '../_utils/layout';

// Long lists.
//
// The shells of both apps are pinned to the viewport (fixed body, no page-level
// scrollbar), so every list page has to bound its own height and scroll inside
// itself. A page that gets that wrong looks perfect with the handful of rows the
// journey specs create and silently clips everything past the fold in real
// catalogs — the rows are in the DOM, the table is "visible", and nothing errors.
//
// These two seed enough rows to make the geometry decide, over the API rather
// than through 200 dialogs (see _utils/seed.ts), and assert on the geometry: the
// table ends above the fold, its own wrapper scrolls, the last row is reachable
// and the fixed header stays put.
const ROWS = 200;

// anna logs in from her own context (same pattern as governance-tags.spec.ts):
// it does NOT inherit the Playwright config baseURL.
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

test.describe('large lists — namespaces @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS[0];

  test(`${ROWS} namespaces: the warehouse table fits the page and scrolls`, async ({
    bootstrappedPage: page,
    browser,
  }) => {
    // Warehouse creation is a real (validated) create and the seed is 200+200
    // requests on top of it.
    test.setTimeout(240000);

    const wh = await createWarehouse(page, backend);
    await openWarehouse(page, wh);
    const warehouseId = page.url().match(/\/ui\/warehouse\/([^/?#]+)/)?.[1] || '';
    expect(warehouseId, 'could not read the warehouse id from the route').not.toBe('');

    const namespaces = await test.step(`seed ${ROWS} namespaces`, () =>
      seedNamespaces(page, warehouseId, ROWS),
    );

    // The "user assign" half: every seeded namespace also carries a grant, so the
    // list renders rows whose permissions were actually resolved rather than a
    // uniformly empty ACL. Only OpenFGA takes grant writes — authn has no
    // authorizer at all, and cedar decides access from its policy file.
    if (TEST_MODE === 'authz') {
      await test.step(`grant ${TEST_USER_2.username} select on all ${ROWS}`, async () => {
        // Lakekeeper only knows a user once they have authenticated, so register
        // her with a throwaway login first.
        const annaCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
        await login(await annaCtx.newPage(), TEST_USER_2);
        await annaCtx.close();

        const annaId = await findUserId(page, TEST_USER_2.username);
        await grantNamespaces(page, warehouseId, namespaces, annaId, ['select']);
      });
    }

    // Reopen so the table loads the seeded rows rather than the empty list it
    // mounted with — WarehouseNamespaces only fetches on mount.
    await openWarehouse(page, wh);

    const table = visibleDataTable(page);
    await expect(table.getByText(seededName('ns', 1), { exact: true })).toBeVisible({ timeout: 20000 });
    // 50 rows per page is the component's default; fewer means the list never
    // filled and the geometry assertions below would pass vacuously.
    await expect.poll(() => table.locator('tbody tr').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(50);

    await expectTableScrollsWithinViewport(page, table, 'warehouse namespaces');
  });
});

test.describe('large lists — tag definitions @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(`${ROWS} tag definitions: the governance table fits the page and scrolls`, async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180000);

    // Project-scoped vocabulary — no warehouse and no storage backend needed,
    // which is what lets this one cover @noauth too.
    await test.step(`seed ${ROWS} tag definitions`, () => seedTagDefinitions(page, ROWS));

    await gotoTagDefinitions(page);

    const table = visibleDataTable(page);
    await expect(table.getByText(seededName('e2e.scale', 1, '.'), { exact: true })).toBeVisible({ timeout: 20000 });
    await expect.poll(() => table.locator('tbody tr').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(50);

    await expectTableScrollsWithinViewport(page, table, 'governance tag definitions');
    // The manager's two-column pane is itself a bounded region — a tall table
    // inside it must not push the page, which the shell cannot scroll.
    await expectNoPageScroll(page, 'governance page');
  });
});
