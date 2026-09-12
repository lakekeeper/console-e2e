import { test, expect } from '../_fixtures/auth.fixture';
import { login } from '../_utils/auth';

// Roles exist only with the OpenFGA authorizer (@authz). Cedar is pure
// policy-based and has NO role concept, so this is intentionally NOT @cedar.
test.describe('role CRUD @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const roleName = 'e2e-test-role';

  test('create, open, and inspect a role', async ({ bootstrappedPage: page }) => {
    test.setTimeout(90000);

    await test.step('1 · create the role', async () => {
      await page.goto('/ui/roles');
      await page.waitForLoadState('domcontentloaded');
      if (/\/ui\/login/.test(page.url())) {
        await login(page);
        await page.goto('/ui/roles');
      }
      await expect(page.locator('.v-application').first()).toBeVisible();

      // Idempotent: combos share backend state, so a prior run may have made it.
      if (await page.getByText(roleName, { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false)) {
        return;
      }

      await page.getByRole('button', { name: /add role/i }).first().click();
      await page.getByRole('textbox', { name: 'Role Name' }).fill(roleName);
      await page.getByRole('textbox', { name: 'Role description' }).fill('created by e2e');
      await page.getByRole('button', { name: /save role/i }).click();
      await expect(page.getByText(roleName, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    });

    await test.step('2 · the role name links to its detail page', async () => {
      // Roles became navigable: the name is a link to /roles/:id.
      await page.getByText(roleName, { exact: true }).first().click();
      await expect(page).toHaveURL(/\/roles\/[^/]+/, { timeout: 10000 });
    });

    await test.step('3 · detail page shows the vertical tab rail', async () => {
      // RoleDetail's rail: details · owners · members · grants · member-of.
      for (const name of ['Details', 'Owners', 'Members', 'Member of']) {
        await expect(page.getByRole('tab', { name: new RegExp(`^${name}`, 'i') }).first()).toBeVisible({
          timeout: 15000,
        });
      }
    });

    await test.step('4 · a provider chip states where the role comes from', async () => {
      // Roles owned by an external provider (LDAP/Entra/Okta/OIDC) are marked so
      // writes their API refuses are never offered. A role made here is internal.
      await expect(
        page.getByText(/^(Built-in|Internal|External)$/).first(),
      ).toBeVisible({ timeout: 15000 });
    });

    await test.step('5 · membership withholds the nested scope on OpenFGA', async () => {
      // Expanding a role's membership closure needs the CATALOG to own the
      // assignments. OpenFGA keeps that graph in its own store, so the
      // management API would 501 — the console withholds the "Incl. nested"
      // scope up front rather than offering a control that cannot answer
      // (ASSIGNMENT_MANAGING_AUTHZ_BACKENDS in console-components). This combo
      // IS OpenFGA, so the correct assertion is that the toggle is absent.
      await page.getByRole('tab', { name: /^Members/i }).first().click();
      await expect(page.getByRole('button', { name: /^Direct$/i })).toHaveCount(0, { timeout: 15000 });
      await expect(page.getByRole('button', { name: /Incl\. nested/i })).toHaveCount(0);
      // The members list itself still renders (it is the direct assignments).
      await expect(page.getByRole('button', { name: /add member/i }).first()).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step('6 · the edit dialog is labelled "Edit details"', async () => {
      await page.getByRole('tab', { name: /^Details/i }).first().click();
      await expect(page.getByRole('button', { name: 'Edit details' }).first()).toBeVisible({
        timeout: 15000,
      });
    });
  });
});
