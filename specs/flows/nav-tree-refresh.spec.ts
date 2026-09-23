import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  addNamespace,
  addTable,
  bulkDeleteTables,
  createWarehouse,
  navTreeItem,
  openNamespace,
  openWarehouse,
  warehouseName,
} from '../_utils/warehouse';

// The navigation tree keys its nodes by the DOT-separated namespace path, while
// the catalog API uses \x1F. Every page that mutates a table has to convert
// before asking the tree to refresh — and for a TOP-LEVEL namespace the two
// spellings are identical, so a missing conversion looks perfectly fine.
//
// This journey therefore works THREE levels deep, where the two forms differ.
// It also deletes in a batch, because the refresh used to fire once per table:
// N reloads of the same node for one observable change.
test.describe('nav tree refresh @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);
  test.skip(!backend, 'no browser-reachable storage backend for deep flows');

  test('a nested namespace refreshes its tree node on create and batch delete', async ({
    bootstrappedPage: page,
  }) => {
    // Warehouse + three nested namespaces + two tables + a batch delete, each a
    // real round-trip. The 30s default is for single-screen checks.
    test.setTimeout(240_000);
    const wh = warehouseName(backend!);
    const tables = ['nested_t1', 'nested_t2'];
    let listCalls = 0;

    await test.step('1 · warehouse with a three-level namespace', async () => {
      await createWarehouse(page, backend!);
      await openWarehouse(page, wh);
      await addNamespace(page, 'lvl_a');
      await openNamespace(page, 'lvl_a');
      await addNamespace(page, 'lvl_b');
      await openNamespace(page, 'lvl_b');
      await addNamespace(page, 'lvl_c');
      await openNamespace(page, 'lvl_c');
      // Three segments deep: the API path is lvl_a\x1Flvl_b\x1Flvl_c and the
      // tree id is lvl_a.lvl_b.lvl_c. Anything that skips the conversion from
      // here on silently refreshes nothing.
      await expect(page).toHaveURL(/lvl_a.*lvl_b.*lvl_c/);
    });

    await test.step('2 · a created table appears in the tree without a reload', async () => {
      await addTable(page, tables[0]);
      await expect(navTreeItem(page, tables[0])).toBeVisible({ timeout: 20000 });
    });

    await test.step('3 · a batch delete refreshes the node once, not once per table', async () => {
      await addTable(page, tables[1]);
      await expect(navTreeItem(page, tables[1])).toBeVisible({ timeout: 20000 });

      // Count only the child listings triggered by the delete itself.
      await page.route('**/v1/**/namespaces/**/tables**', (route) => {
        listCalls++;
        return route.continue();
      });

      await bulkDeleteTables(page, tables);

      for (const name of tables) {
        await expect(navTreeItem(page, name)).toBeHidden({ timeout: 20000 });
      }
      // Two tables deleted. A per-item refresh reloaded the node once per
      // success on top of the list the page reloads for itself; one refresh for
      // the batch keeps this in single digits.
      expect(listCalls, 'the tree reloaded once per deleted table').toBeLessThan(6);
    });
  });
});
