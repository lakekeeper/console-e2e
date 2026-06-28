import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace } from '../_utils/warehouse';
import { openLoqeAndAttach, createTableViaLoqe } from '../_utils/loqe';

// LoQE = in-browser DuckDB-WASM SQL engine. Needs SharedArrayBuffer (cross-origin
// isolation). Probe: does the engine initialize headless? ("Ready" chip).
test.describe('loqe @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('DuckDB-WASM engine initializes', async ({ bootstrappedPage: page }) => {
    await page.goto('/ui/loqe');
    await page.waitForLoadState('domcontentloaded');
    // Init can take a while (WASM download + worker). "Ready" chip = initialized.
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });
  });

  // The full Iceberg round-trip: attach a warehouse catalog, CREATE a table (writes
  // parquet + commits metadata to S3 from the browser), then read it back. Needs a
  // browser-reachable bucket whose CORS allows WRITES for the app origin, and (for
  // AWS) an STS-enabled warehouse — see _data/storage-backends.ts. Skipped if no
  // deep-flow backend is configured.
  const deep = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);
  test('create + query an Iceberg table via LoQE', async ({ bootstrappedPage: page }) => {
    test.skip(!deep, 'no browser-reachable storage backend with write CORS configured');
    test.setTimeout(180000);

    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);

    // PROVE the browser origin (the video has no address bar). The bucket CORS is
    // pinned to http://localhost:3001 — if vite bumped the port, the write fails.
    const origin = new URL(page.url()).origin;
    console.log(`### LoQE page origin: ${origin}`);
    expect(origin, 'app must run on the CORS-allowed origin').toBe('http://localhost:3001');

    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, 'demo_tbl');
  });
});
