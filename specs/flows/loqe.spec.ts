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

    // PROVE the browser origin (the video has no address bar). The AWS bucket CORS
    // is pinned to http://localhost:3001 — if vite bumped the port, the write fails.
    // In served-UI (docker) the app is the image's embedded console at :8181 and the
    // seaweed bucket has wildcard CORS, so the allowed origin is the UI URL instead.
    const origin = new URL(page.url()).origin;
    console.log(`### LoQE page origin: ${origin}`);
    const expectedOrigin =
      process.env.SERVED_UI === '1'
        ? new URL(process.env.LK_UI_URL || 'http://localhost:8181').origin
        : 'http://localhost:3001';
    expect(origin, 'app must run on the CORS-allowed origin').toBe(expectedOrigin);

    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, 'demo_tbl');
  });
});
