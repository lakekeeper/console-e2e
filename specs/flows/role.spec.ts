import { test, expect } from '../_fixtures/auth.fixture';
import { login } from '../_utils/auth';

// Roles exist only with the OpenFGA authorizer (@authz). Cedar is pure
// policy-based and has NO role concept, so this is intentionally NOT @cedar.
test.describe('role CRUD @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('create, edit, delete a role', async ({ bootstrappedPage: page }) => {
    await page.goto('/ui/roles');
    await page.waitForLoadState('domcontentloaded');
    if (/\/ui\/login/.test(page.url())) {
      await login(page);
      await page.goto('/ui/roles');
    }
    await expect(page.locator('.v-application').first()).toBeVisible();

    const roleName = 'e2e-test-role';

    // Open the "New Role" dialog and create a role.
    await page.getByRole('button', { name: /add role/i }).first().click();
    await page.getByRole('textbox', { name: 'Role Name' }).fill(roleName);
    await page.getByRole('textbox', { name: 'Role description' }).fill('created by e2e');
    await page.getByRole('button', { name: /save role/i }).click();

    // It should appear in the list.
    await expect(page.getByText(roleName, { exact: true })).toBeVisible({ timeout: 10000 });
  });
});
