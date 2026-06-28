import { test, expect } from '@playwright/test';
import { login } from '../_utils/auth';

// Auth modes only — noauth has no login screen (see noauth-access.spec.ts).
test.describe('login @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('logs in and lands on home or bootstrap', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/$|\/ui\/$|\/ui\/bootstrap/);
  });
});
