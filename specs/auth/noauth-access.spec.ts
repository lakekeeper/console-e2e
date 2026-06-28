import { test, expect } from '../_fixtures/auth.fixture';

// noauth mode: the app must be reachable with no login step at all.
test.describe('anonymous access @noauth', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('app is usable without logging in', async ({ bootstrappedPage: page }) => {
    await page.goto('/');
    await expect(page.locator('.v-application').first()).toBeVisible({ timeout: 15000 });
    // No login button should be present when authentication is disabled.
    const loginBtn = page.locator('[data-testid="login-button"], button:has-text("Sign In")');
    await expect(loginBtn).toHaveCount(0);
  });
});
