import { test, expect } from '../_fixtures/auth.fixture';
import { createWarehouse, openWarehouse, addNamespace } from '../_utils/warehouse';
import type { Locator } from '@playwright/test';
import type { StorageBackend } from '../_data/storage-backends';

// Local copies of the two form helpers: storage-backends.ts keeps them private,
// and this spec needs only these two — not worth widening that module's surface.
async function fillIfPresent(scope: Locator, label: RegExp, value: string) {
  const field = scope.getByLabel(label).filter({ visible: true }).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}

async function openLayoutOptions(scope: Locator) {
  const panel = scope
    .getByRole('button', { name: /Layout & options|Advanced Storage Options/i })
    .first();
  if (await panel.isVisible().catch(() => false)) {
    const expanded = await panel.getAttribute('aria-expanded');
    if (expanded !== 'true') await panel.click().catch(() => {});
    await scope.page().waitForTimeout(300);
  }
}

// The console must not blame CORS for a request the browser never sent
// (lakekeeper/lakekeeper#2010: an S3 endpoint on port 10080, which browsers refuse
// to connect to — it is on the Fetch standard's bad-ports list).
//
// The asymmetry is the whole point and compose gives it to us for free: SeaweedFS
// is published on the bad port as well, so lakekeeper (container → host LAN IP)
// reaches it and validates the warehouse, while the browser refuses before a
// packet leaves. The bucket's CORS is wide open, so any "CORS" wording here is
// provably wrong.
//
// chromium-only: the bad-ports list is identical across browsers, so a
// cross-browser pass buys nothing.
test.describe('storage reachability @authn', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const env = process.env;
  const badPort = env.S3_BADPORT_HOST_PORT || '10080';
  // Same host as the working local endpoint, different (blocked) port.
  const badEndpoint = (env.S3_LOCAL_ENDPOINT || 'http://seaweedfs:8333').replace(
    /:(\d+)(\/|$)/,
    `:${badPort}$2`,
  );

  const backend: StorageBackend = {
    key: 's3 (seaweedfs, blocked port)',
    tab: /S3 Compatible|S3.?Compat/i,
    enabled: env.S3_LOCAL_ENABLE !== '0',
    fill: async (scope) => {
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.S3_LOCAL_BUCKET || 'lakekeeper-test');
      await fillIfPresent(scope, /^Region( \*)?$/i, env.S3_LOCAL_REGION || 'us-east-1');
      await fillIfPresent(scope, /^Endpoint( \*)?$/i, badEndpoint);
      await fillIfPresent(scope, /Access Key ID/i, env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
      await fillIfPresent(
        scope,
        /Secret Access Key/i,
        env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret',
      );
      await openLayoutOptions(scope);
      const pathStyle = scope
        .getByLabel(/path[- ]style/i)
        .filter({ visible: true })
        .first();
      if (await pathStyle.isVisible().catch(() => false)) {
        await pathStyle.check().catch(() => pathStyle.click().catch(() => {}));
      }
    },
  };

  test('names the blocked port instead of blaming CORS', async ({
    bootstrappedPage: page,
  }, testInfo) => {
    test.skip(!backend.enabled, 'local SeaweedFS backend disabled');
    test.setTimeout(240000);

    const wh = await createWarehouse(page, backend);
    await openWarehouse(page, wh);
    const ns = 'badport_ns';
    await addNamespace(page, ns);

    // The table is created through the catalog API, not the browser: a staged
    // create would need the browser to write metadata, and writing is exactly
    // what this warehouse cannot do. Lakekeeper writes the metadata itself
    // server-side, which is all the Files/Preview tabs need to attempt a read.
    const token = await page.evaluate(() => {
      for (const store of [sessionStorage, localStorage])
        for (const k of Object.keys(store))
          if (k.startsWith('oidc.user')) {
            try {
              const v = JSON.parse(store.getItem(k) || '{}');
              if (v?.access_token) return v.access_token as string;
            } catch {
              /* not the entry we want */
            }
          }
      return '';
    });
    const api = process.env.LK_API_URL || 'http://localhost:8181';
    const created = await page.request.post(
      `${api}/catalog/v1/${encodeURIComponent(wh)}/namespaces/${ns}/tables`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        data: {
          name: 'badport_tbl',
          schema: {
            type: 'struct',
            'schema-id': 0,
            fields: [{ id: 1, name: 'val', required: false, type: 'string' }],
          },
        },
      },
    );
    expect(created.ok(), `table create failed: ${await created.text()}`).toBeTruthy();

    // Files: the storage explorer lists the table prefix directly from the browser.
    await page.goto(
      `/ui/warehouse/${await warehouseIdFromUrl(page, wh)}/namespace/${ns}/table/badport_tbl?tab=files`,
    );
    const filesAlert = page.locator('.v-alert').first();
    await expect(filesAlert).toBeVisible({ timeout: 60000 });
    const filesText = await filesAlert.innerText();
    await testInfo.attach('files-blocked-port', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(filesText).toMatch(/never left the browser/i);
    expect(filesText).toContain(badPort);
    expect(filesText).not.toMatch(/cors/i);

    // Preview: the same verdict, reached through LoQE rather than the explorer.
    await page.goto(
      `/ui/warehouse/${await warehouseIdFromUrl(page, wh)}/namespace/${ns}/table/badport_tbl?tab=preview`,
    );
    const previewAlert = page.locator('.v-alert').first();
    await expect(previewAlert).toBeVisible({ timeout: 120000 });
    const previewText = await previewAlert.innerText();
    await testInfo.attach('preview-blocked-port', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(previewText).toMatch(/never left the browser/i);
    expect(previewText).toContain(badPort);
    expect(previewText).not.toMatch(/cors/i);
  });
});

/** The warehouse id from the detail route we are already on (…/warehouse/<id>…). */
async function warehouseIdFromUrl(page: import('@playwright/test').Page, wh: string) {
  const m = /\/ui\/warehouse\/([0-9a-f-]{36})/i.exec(page.url());
  if (m) return m[1];
  await page.goto('/ui/warehouse');
  await page.getByText(wh, { exact: true }).first().click();
  await page.waitForURL(/\/ui\/warehouse\/[0-9a-f-]{36}/i, { timeout: 20000 });
  return /\/ui\/warehouse\/([0-9a-f-]{36})/i.exec(page.url())![1];
}
