import { Page, Route } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { recoverFromOffline } from '../_utils/app';
import { createWarehouse } from '../_utils/warehouse';
import {
  annaIn,
  gotoPolicies,
  isLk014Cedar,
  openRailTab,
  setUserGrants,
  userIdOf,
} from '../_utils/grants';

// Server answers a real stack cannot be made to give on purpose — an authorizer
// that fails, one that is unreachable, an admission gate deciding a check —
// faked at the network layer with page.route, so the console's reading of each
// is pinned down. Everything around the faked call stays real.
//
// What Lakekeeper 0.14 says about each:
// - `500 AuthorizationInternalError` is a server bug, never "not allowed".
// - `503 AuthorizationBackendError` means the authorizer is unreachable; any
//   other 503 (read-only maintenance) carries its own message.
// - a decision can be made by an `admission-gate`, which the Resolve tab labels.
// - `403 CedarInstanceAdminNeedsBreakGlass` asks for a reason on that change.
// - `break-glass-status` offers break-glass to callers who are not instance admins.

const API_ERROR = (code: number, type: string, message: string) => ({
  status: code,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code, type, message, stack: [] } }),
});

async function gotoGrantsExplorer(page: Page) {
  await page.goto('/ui/governance?tab=grants');
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
  await expect(page.getByRole('button', { name: 'Grantable privileges' })).toBeVisible({ timeout: 30000 });
}

async function pickPrincipal(page: Page, name: string) {
  await page.locator('button:has(.mdi-shield-account-outline)').first().click();
  const search = page.getByLabel('Search by name').first();
  await search.click();
  await search.fill(name.split(' ')[0]);
  await page.locator('.v-overlay--active .v-list-item', { hasText: name }).first().click();
}

/** Answer every "grants of one principal" listing with the given response. */
async function fakePrincipalListing(page: Page, response: Parameters<Route['fulfill']>[0]) {
  await page.route(/\/management\/v1\/grants\?/, (route) => route.fulfill(response));
}

test.describe('authorizer errors (Lakekeeper 0.14) @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ bootstrappedPage: page, project }) => {
    test.skip(!(await isLk014Cedar(page, project.id)), 'needs a Lakekeeper 0.14 Plus image');
  });

  test('a 500 AuthorizationInternalError reads as a server error, not a refusal', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(120000);
    await fakePrincipalListing(
      page,
      API_ERROR(500, 'AuthorizationInternalError', 'Authorization failed due to an internal error'),
    );
    await gotoGrantsExplorer(page);
    await pickPrincipal(page, 'Peter Cold');
    await expect(page.getByText(/server-side error, not a missing permission/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/not allowed to list/i)).toHaveCount(0);
    // The server's own wording names no cause worth showing.
    await expect(page.getByText('Authorization failed due to an internal error')).toHaveCount(0);
  });

  test('a 503 names the unreachable authorizer, and only that 503', async ({ bootstrappedPage: page }) => {
    test.setTimeout(150000);

    await test.step('AuthorizationBackendError: the authorizer is down, with a retry', async () => {
      await fakePrincipalListing(page, API_ERROR(503, 'AuthorizationBackendError', 'authorizer unreachable'));
      await gotoGrantsExplorer(page);
      await pickPrincipal(page, 'Peter Cold');
      await expect(page.getByText('Authorization service unavailable')).toBeVisible({ timeout: 20000 });
      await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    await test.step('another 503 carries its own message', async () => {
      await fakePrincipalListing(
        page,
        API_ERROR(503, 'ServiceUnavailable', 'The catalog is in read-only maintenance mode'),
      );
      await gotoGrantsExplorer(page);
      await pickPrincipal(page, 'Peter Cold');
      await expect(page.getByText('The catalog is in read-only maintenance mode')).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('Authorization service unavailable')).toHaveCount(0);
    });
  });

  test('an admission gate that decided a check is labelled', async ({ bootstrappedPage: page }) => {
    test.setTimeout(300000);
    test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured');
    const wh = await createWarehouse(page, ENABLED_BACKENDS[0]);

    await page.route(/\/management\/v1\/action\/batch-check/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 'resolve-check',
              allowed: false,
              'determined-by': [{ type: 'admission-gate', gate: 'e2e-gate', check: 'e2e-check' }],
            },
          ],
        }),
      }),
    );

    await gotoPolicies(page);
    await openRailTab(page, 'Resolve Entities');
    const row = page.locator('.v-treeview-item, .v-list-item', { hasText: new RegExp(`^\\s*${wh}\\s*$`) }).first();
    await row.hover();
    await row.locator('[class*="mdi-plus"]').first().click();

    const action = page.locator('.v-input', { hasText: 'Action' }).last();
    await action.click();
    await page.locator('.v-overlay--active .v-list-item').first().click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('e2e-gate · e2e-check')).toBeVisible({ timeout: 20000 });
  });

  test('CedarInstanceAdminNeedsBreakGlass asks for a reason on that change', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'manage_policies']);
      // The listing stays real; only the write is answered with the refusal.
      await anna.page.route(/\/permissions\/cedar\/project\/policies$/, (route) =>
        route.request().method() === 'POST'
          ? route.fulfill(
              API_ERROR(
                403,
                'CedarInstanceAdminNeedsBreakGlass',
                'Instance admins must provide a break-glass reason to change stored policies',
              ),
            )
          : route.fallback(),
      );

      await gotoPolicies(anna.page);
      await openRailTab(anna.page, 'Stored Policies');
      await anna.page.getByRole('button', { name: 'New policy', exact: true }).first().click();
      const editor = anna.page.locator('.v-overlay__content').filter({ hasText: 'New policy' }).last();
      await expect(editor).toBeVisible({ timeout: 20000 });
      await expect(editor.getByText('This is a break-glass change')).toHaveCount(0);

      await editor.getByLabel('Name *').fill('e2e-needs-reason');
      const source = editor.locator('.cm-content').first();
      await source.click();
      await anna.page.keyboard.press('ControlOrMeta+A');
      await anna.page.keyboard.press('Delete');
      await source.fill('permit (principal == Lakekeeper::User::"oidc~e2e-nobody", action, resource);');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();

      await expect(editor.getByText('This is a break-glass change')).toBeVisible({ timeout: 20000 });
      await expect(editor.getByLabel('Break-glass reason *')).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    } finally {
      await anna.ctx.close();
    }
  });

  test('break-glass-status offers break-glass to someone who is not an instance admin', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'read_policies']);
      const breakGlass = anna.page.getByRole('button', { name: 'Break-glass', exact: true });

      await test.step('not available: not offered', async () => {
        await gotoPolicies(anna.page);
        await openRailTab(anna.page, 'Stored Policies');
        await anna.page.waitForLoadState('networkidle').catch(() => {});
        await expect(breakGlass).toHaveCount(0);
      });

      await test.step('available: offered', async () => {
        await anna.page.route(/\/permissions\/cedar\/break-glass-status/, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ 'break-glass-available': true }),
          }),
        );
        await gotoPolicies(anna.page);
        await openRailTab(anna.page, 'Stored Policies');
        await expect(breakGlass).toBeVisible({ timeout: 20000 });
      });
    } finally {
      await anna.ctx.close();
    }
  });
});
