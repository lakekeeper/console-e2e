import { test, expect } from '../_fixtures/auth.fixture';
import { login } from '../_utils/auth';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace } from '../_utils/warehouse';
import { openLoqeAndAttach, createTableViaLoqe, loqeExec } from '../_utils/loqe';

// Storage CORS gate, demonstrated through the REAL LoQE query path (not a synthetic
// fetch). The Lakekeeper catalog API is CORS-* so the object tree loads on ANY
// origin — but reading table DATA (parquet/avro) is a direct browser→S3 request
// that needs the bucket's CORS to allow the app's ORIGIN. The AWS bucket allows
// http://localhost:3001 only:
//   • on :3001  → `SELECT *` succeeds (rows render)
//   • on :3002  → `SELECT *` fails with the in-app "Query Error … CORS" box
// Both screenshots are attached to the report so the actual UI error is visible.
// authn-only: needs the second :3002 app server (started just for this mode) and
// login works on both ports (the lakekeeper OIDC client allows redirect '*').
test.describe('storage CORS @authn', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const deep = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);

  test('LoQE SELECT * works on :3001 but is CORS-blocked on :3002', async (
    { bootstrappedPage: page, browser },
    testInfo,
  ) => {
    test.skip(!deep, 'no browser-reachable (origin-scoped CORS) storage backend configured');
    test.setTimeout(300000);
    const tbl = 'demo_tbl';

    // Seed (idempotent — reuses the table the loqe test made in this combo).
    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);
    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, tbl);
    const sql = `select * from "${wh}"."${ns}"."${tbl}";`;

    // :3001 — the allowed origin. SELECT * resolves and renders rows.
    const ok = await loqeExec(page, sql);
    await testInfo.attach('select-star-on-3001-ALLOWED', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
    expect(ok.errored, `SELECT * on :3001 should work (got: ${ok.errorText})`).toBeFalsy();
    await expect(page.locator('.loqe-result-table').first()).toBeVisible({ timeout: 15000 });

    // :3002 — a different origin. The tree still loads (catalog API is CORS-*), but
    // reading the table data from S3 is blocked → the in-app Query Error / CORS box.
    const ctx = await browser.newContext({
      baseURL: `http://localhost:3002`,
      recordVideo: { dir: testInfo.outputDir }, // capture the :3002 failure on video
    });
    const p2 = await ctx.newPage();
    try {
      await login(p2); // peter on :3002 (OIDC client redirect '*')
      await openLoqeAndAttach(p2, wh, ns); // tree loads via catalog API
      const blocked = await loqeExec(p2, sql);
      await testInfo.attach('select-star-on-3002-CORS-ERROR', {
        body: await p2.screenshot({ fullPage: false }),
        contentType: 'image/png',
      });
      // The data read must be BLOCKED on :3002, AND console-components must surface
      // its FRIENDLY "Configure CORS" guidance — not a raw DuckDB error. chromium
      // and firefox fail differently underneath (chromium: "HTTP Error … CORS";
      // firefox: "Cannot read N bytes from memory buffer"), but LoQEEngine's
      // cross-browser detection now translates BOTH into the same actionable box.
      // This assertion guards that fix.
      console.log(`### :3002 SELECT * blocked with: ${blocked.errorText.replace(/\s+/g, ' ').slice(0, 160)}`);
      expect(blocked.errored, 'SELECT * on :3002 should fail (origin not allowed by bucket CORS)').toBeTruthy();
      expect(
        blocked.errorText,
        'console-components should show the friendly "Configure CORS" message (both browsers)',
      ).toMatch(/Could not access|Configure CORS/i);
      await p2.waitForTimeout(1500); // let the video capture the error box
    } finally {
      await ctx.close();
    }
  });
});
