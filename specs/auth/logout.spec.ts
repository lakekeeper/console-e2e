import { test, expect } from '../_fixtures/auth.fixture';

test.describe('logout @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('logs out back to the login screen', async ({ bootstrappedPage: page }) => {
    await page.goto('/ui/logout');
    await expect(page).toHaveURL(/\/ui\/login/, { timeout: 10000 });
  });
});
