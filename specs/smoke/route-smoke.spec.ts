import { test, expect } from '../_fixtures/auth.fixture';
import { login, isAuthMode } from '../_utils/auth';

// Breadth check: every major route renders its app shell without crashing.
// Runs in ALL modes — gating differences are asserted in perms specs, not here.
test.describe('route smoke @smoke @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Core routes present in both console and console-plus. The app is served
  // under the /ui/ base path. `/ui/governance`, `/ui/identities`,
  // `/ui/styleguide` and `/ui/no-access` arrived with the 0.23 / 0.18 apps.
  const routes = [
    '/ui/',
    '/ui/warehouse',
    '/ui/roles',
    '/ui/identities',
    '/ui/governance',
    '/ui/styleguide',
    '/ui/user-profile',
    '/ui/dependencies',
  ];

  // Deep-linked tabs. Tab switching uses history.replaceState now (not
  // router.replace), so NOTHING navigates on a tab click — assert the DOM and
  // page.url(), never a navigation event. The tab values are the literal
  // `value="…"` strings on the v-tabs.
  const tabRoutes = [
    '/ui/governance?tab=tags',
    '/ui/governance?tab=policies',
    '/ui/identities?tab=roles',
  ];

  test('major routes render', async ({ bootstrappedPage: page }) => {
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');

      // A transient token-refresh race can bounce an authenticated navigation to
      // the login screen; this is a render check, not an auth-stress test, so
      // re-authenticate once and retry the route.
      if (isAuthMode && /\/ui\/login/.test(page.url())) {
        await login(page);
        await page.goto(route);
        await page.waitForLoadState('domcontentloaded');
      }

      // App shell mounted = no white-screen crash.
      await expect(page.locator('.v-application').first()).toBeVisible({ timeout: 15000 });
      // No unhandled router/runtime error surfaced as a fatal overlay.
      const fatal = page.locator('text=/Internal Server Error|Cannot read properties of/i');
      await expect(fatal).toHaveCount(0);
      console.log(`✓ ${route}`);
    }
  });

  test('deep-linked tabs render', async ({ bootstrappedPage: page }) => {
    for (const route of tabRoutes) {
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      if (isAuthMode && /\/ui\/login/.test(page.url())) {
        await login(page);
        await page.goto(route);
        await page.waitForLoadState('domcontentloaded');
      }
      await expect(page.locator('.v-application').first()).toBeVisible({ timeout: 15000 });
      // The ?tab= query must survive: the page re-applies a bookmarked tab once
      // its gating flags resolve, rewriting the URL through history.replaceState.
      await expect(page).toHaveURL(/\?tab=/, { timeout: 10000 });
      console.log(`✓ ${route}`);
    }
  });

  // An authenticated 403 on /info redirects here, and it is a real page in both
  // apps — reachable directly, and the one place an operator sees which server
  // they were refused by.
  test('the no-access page renders', async ({ bootstrappedPage: page }) => {
    await page.goto('/ui/no-access');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.v-application').first()).toBeVisible({ timeout: 15000 });
  });
});
