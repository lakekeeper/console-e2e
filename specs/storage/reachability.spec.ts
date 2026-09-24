import { test, expect } from '../_fixtures/auth.fixture';
import { createWarehouse, openWarehouse, addNamespace, selectTab } from '../_utils/warehouse';
import { openLoqeAndAttach, createTableViaLoqe } from '../_utils/loqe';
import type { Locator } from '@playwright/test';
import type { StorageBackend } from '../_data/storage-backends';
import { chooseVendedCredentials } from '../_data/storage-backends';

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
// The asymmetry is the whole point and compose gives it to us for free: Silo
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
  const badEndpoint = (env.S3_LOCAL_ENDPOINT || 'http://silo:9000').replace(
    /:(\d+)(\/|$)/,
    `:${badPort}$2`,
  );

  const backend: StorageBackend = {
    key: 's3 (silo, blocked port)',
    tab: /S3 Compatible|S3.?Compat/i,
    enabled: env.S3_LOCAL_ENABLE !== '0',
    fill: async (scope, ctx) => {
      // Its OWN bucket, not a prefix inside the shared one: demo-silo is created
      // with no key-prefix, so it owns the whole bucket root and Lakekeeper
      // rejects any nested location as "used by another warehouse".
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.S3_BADPORT_BUCKET || 'lakekeeper-badport');
      await fillIfPresent(scope, /^Region( \*)?$/i, env.S3_LOCAL_REGION || 'us-east-1');
      // Working endpoint at create time; the test moves it to badEndpoint
      // after data is written (see the step below).
      await fillIfPresent(scope, /^Endpoint( \*)?$/i, env.S3_LOCAL_ENDPOINT || 'http://silo:9000');
      await fillIfPresent(scope, /Access Key ID/i, env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
      await fillIfPresent(
        scope,
        /Secret Access Key/i,
        env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret',
      );
      await openLayoutOptions(scope);
      // One prefix per warehouse, same rule as every other backend.
      if (ctx?.warehouse) await fillIfPresent(scope, /^Location$/i, ctx.warehouse);

      const pathStyle = scope
        .getByLabel(/path[- ]style/i)
        .filter({ visible: true })
        .first();
      if (await pathStyle.isVisible().catch(() => false)) {
        await pathStyle.check().catch(() => pathStyle.click().catch(() => {}));
      }
      // The storage explorer reads the bucket FROM THE BROWSER, which needs
      // vended credentials — without them it stops at "No S3 access key in
      // vended credentials" and never reaches the blocked-port path this spec
      // is about. Silo vends via AssumeRole off the calling key, no role ARN.
      await chooseVendedCredentials(scope, env.S3_LOCAL_STS_ROLE_ARN);
    },
  };

  test('names the blocked port instead of blaming CORS', async ({
    bootstrappedPage: page,
    browser,
  }, testInfo) => {
    test.skip(!backend.enabled, 'local Silo backend disabled');
    test.setTimeout(240000);

    // Per-browser warehouse. This spec deliberately leaves the warehouse with a
    // browser-unreachable endpoint, and createWarehouse is idempotent — so the
    // second browser reused chromium's already-blocked warehouse and failed
    // writing its data ("LoQE create failed"), which looked like a Firefox CORS
    // limitation but was just run order.
    const wh = await createWarehouse(page, backend, browser.browserType().name());
    await openWarehouse(page, wh);
    const ns = 'badport_ns';
    await addNamespace(page, ns);

    // The table needs actual DATA, not just a schema: with no rows the preview
    // short-circuits to "No rows yet ... nothing has been written to it yet"
    // and never attempts a storage read, so it can never reach the
    // blocked-port verdict this spec is about.
    //
    // Which means the warehouse cannot start out blocked — writing uses the
    // same endpoint the browser is meant to be unable to reach. So: create it
    // pointing at the WORKING endpoint, write through LoQE, then move the
    // endpoint to the blocked port. `lockLocation` only freezes Bucket and
    // Location, so Endpoint stays editable after create.
    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, 'badport_tbl');

    await test.step('move the endpoint to the browser-blocked port', async () => {
      await openWarehouse(page, wh);
      await page.locator('button:has(.mdi-cog)').first().click();
      await page.getByText('Warehouse settings', { exact: true }).click();
      const dialog = page
        .locator('.v-overlay__content')
        .filter({ hasText: /Warehouse settings|STORAGE PROVIDER/i })
        .last();
      await expect(dialog).toBeVisible({ timeout: 15000 });
      // The settings rail lists only THIS warehouse's provider, and labels it by
      // storage type ("AWS S3" for any s3 profile) rather than by the
      // create-dialog entry ("S3 Compatible") — so matching backend.tab here
      // never resolves. Pick the one provider entry instead.
      // One click does not stick here either — Vuetify resets the tab while the
      // pane loads, which left SETTINGS selected and no Endpoint field on screen.
      await selectTab(page, backend.tab, dialog);
      const endpoint = dialog
        .getByLabel(/^Endpoint( \*)?$/i)
        .filter({ visible: true })
        .first();
      // 30s, not 15: webkit renders this dialog's provider pane noticeably
      // slower than chromium and needed all three attempts to get past here.
      await expect(endpoint).toBeVisible({ timeout: 30000 });
      await endpoint.fill(badEndpoint);
      // Credentials are write-only server-side, so the stored ones are not
      // replayed into the form — and "Update profile" re-runs storage
      // validation, which without them fails as Access Denied / no STS
      // identity. Resend them with the profile.
      await dialog
        .getByLabel(/Access Key ID/i)
        .filter({ visible: true })
        .first()
        .fill(env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
      await dialog
        .getByLabel(/Secret Access Key/i)
        .filter({ visible: true })
        .first()
        .fill(env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret');
      const updateProfile = dialog.getByRole('button', { name: /^update profile$/i });
      await expect(updateProfile).toBeEnabled({ timeout: 15000 });
      await updateProfile.click();
      await expect(dialog).toBeHidden({ timeout: 60000 });
    });

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
