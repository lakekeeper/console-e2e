import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse, addNamespace, warehouseName, refreshWarehouses } from '../_utils/warehouse';

// End-to-end JOURNEY (ordered steps in ONE isolated test) — the realistic flow a
// user does: create warehouse → see it in the nav → open it → add a namespace.
// Each step shows as a numbered entry (with its own screenshot) in the HTML report.
// (Creating/querying a TABLE lives in flows/loqe.spec.ts, not here.)
//
// One journey PER enabled storage backend (AWS always; SeaweedFS when
// S3_LOCAL_ENABLE=1; R2/ADLS/OneLake/GCS when their creds are set).
test.describe('warehouse lifecycle @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  for (const backend of ENABLED_BACKENDS) {
    test(`warehouse → namespace journey (${backend.key})`, async ({ bootstrappedPage: page }) => {
      const wh = warehouseName(backend);
      const ns = 'demo_ns';

      await test.step('1 · create warehouse', async () => {
        await createWarehouse(page, backend);
      });

      await test.step('2 · warehouse appears in nav tree', async () => {
        await page.goto('/ui/warehouse');
        await page.waitForLoadState('domcontentloaded');
        // The tree doesn't auto-refresh after a create, and the refresh button only
        // appears once the tree has loaded — so click "Refresh warehouses" and check
        // in a loop until the just-created warehouse shows up.
        const treeitem = page.getByRole('treeitem', { name: new RegExp(wh) });
        for (let i = 0; i < 4; i++) {
          if (await treeitem.first().isVisible({ timeout: 5000 }).catch(() => false)) break;
          await refreshWarehouses(page);
        }
        await expect(treeitem.first()).toBeVisible({ timeout: 10000 });
      });

      // Deep flows need the detail page's storage explorer to reach the endpoint
      // from the browser — only for browser-reachable backends (not local SeaweedFS).
      if (backend.deepFlows === false) return;

      await test.step('3 · open warehouse + create namespace', async () => {
        await openWarehouse(page, wh);
        await addNamespace(page, ns);
      });

      // TODO(step 4 · delete warehouse): actions menu → Delete → DeleteConfirmDialog.
    });
  }
});
