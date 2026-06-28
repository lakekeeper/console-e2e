import { test, expect } from '../_fixtures/auth.fixture';
import { login, isAuthMode } from '../_utils/auth';

// Breadth check: every major route renders its app shell without crashing.
// Runs in ALL modes — gating differences are asserted in perms specs, not here.
test.describe('route smoke @smoke @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Core routes present in both console and console-plus. The app is served
  // under the /ui/ base path.
  const routes = ['/ui/', '/ui/warehouse', '/ui/roles', '/ui/user-profile', '/ui/dependencies'];

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
});
