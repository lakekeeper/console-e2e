import { test, expect } from '../_fixtures/auth.fixture';

// Fresh DB per matrix run → the server always needs bootstrapping first.
test.describe('bootstrap @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('completes bootstrap and reaches home', async ({ bootstrappedPage: page }) => {
    // bootstrappedPage fixture has already driven the stepper if needed.
    await expect(page).toHaveURL(/\/$|\/ui\/$/);
    await expect(page.locator('.v-application').first()).toBeVisible();
  });
});
