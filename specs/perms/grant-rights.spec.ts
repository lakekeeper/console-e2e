import { Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { recoverFromOffline } from '../_utils/app';
import { createWarehouse, openWarehouse } from '../_utils/warehouse';
import { openTagAddMenu, pickerItem, closeTagMenu } from '../_utils/tags';
import {
  annaIn,
  ensureWarehouseTag,
  gotoPolicies,
  isLk014Cedar,
  openRailTab,
  setUserGrants,
  userIdOf,
  warehouseIdOf,
} from '../_utils/grants';

// Lakekeeper 0.14 grant changes, as the console shows them:
// - listing everything another user or role holds in a project needs the
//   project's `read_subtree_grants` (your own needs `get_metadata`),
// - server grants go to users only, except under OpenFGA,
// - checking someone else's access needs `manage_grants`,
// - creating roles is part of `manage_grants`, and `manage_tags` is its own
//   privilege that also needs `apply` on the tag,
// - allow-all has no grants to manage at all.

const NOT_LISTED = "You are not allowed to list this principal's grants.";

async function gotoGrantsExplorer(page: Page) {
  await page.goto('/ui/governance?tab=grants');
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
  await expect(page.getByRole('button', { name: 'Grantable privileges' })).toBeVisible({ timeout: 30000 });
}

/** Explorer, principal scope, one user picked by name. */
async function pickPrincipal(page: Page, name: string) {
  await page.locator('button:has(.mdi-shield-account-outline)').first().click();
  const search = page.getByLabel('Search by name').first();
  await search.click();
  await search.fill(name.split(' ')[0]);
  await page.locator('.v-overlay--active .v-list-item', { hasText: name }).first().click();
}

async function openServerGrantDialog(page: Page) {
  await page.goto('/ui/server-settings?tab=grants');
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
  await page.getByRole('button', { name: 'Grant', exact: true }).first().click();
  const dialog = page.locator('.v-overlay__content').filter({ hasText: 'Grant privileges' }).last();
  await expect(dialog).toBeVisible({ timeout: 20000 });
  return dialog;
}

test.describe('grant rights (Lakekeeper 0.14) @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ bootstrappedPage: page, project }) => {
    test.skip(!(await isLk014Cedar(page, project.id)), 'needs a Lakekeeper 0.14 Plus image');
  });

  test("another principal's grants need read_subtree_grants", async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      const peterId = await userIdOf(page, 'peter');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe']);
      const asked: string[] = [];
      anna.page.on('request', (r) => {
        const m = r.url().match(/\/management\/v1\/grants\?.*principalUser=([^&]+)/);
        if (m) asked.push(decodeURIComponent(m[1]));
      });

      await test.step('without it: refused in place, nothing asked', async () => {
        await gotoGrantsExplorer(anna.page);
        await pickPrincipal(anna.page, 'Peter Cold');
        await expect(anna.page.getByText(NOT_LISTED)).toBeVisible({ timeout: 20000 });
        expect(asked).not.toContain(peterId);
      });

      await test.step('her own grants need nothing more', async () => {
        await pickPrincipal(anna.page, 'Anna Cold');
        await expect(anna.page.getByText(NOT_LISTED)).toHaveCount(0);
        await expect.poll(() => asked.includes(annaId), { timeout: 15000 }).toBe(true);
      });

      await test.step('with read_grants on the project: listed', async () => {
        await setUserGrants(page, project.id, { type: 'project' }, annaId, ['read_grants']);
        await gotoGrantsExplorer(anna.page);
        await pickPrincipal(anna.page, 'Peter Cold');
        await expect.poll(() => asked.includes(peterId), { timeout: 15000 }).toBe(true);
        await expect(anna.page.getByText(NOT_LISTED)).toHaveCount(0);
      });
    } finally {
      await anna.ctx.close();
    }
  });

  test('a level you cannot read says so', async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'read_grants']);
      await gotoGrantsExplorer(anna.page);
      // The server level: read_grants on the project does not reach above it.
      await anna.page.locator('button:has(.mdi-server)').first().click();
      await expect(anna.page.getByText('The grants on this level are hidden by your permissions.')).toBeVisible({
        timeout: 20000,
      });
    } finally {
      await anna.ctx.close();
    }
  });

  test('creating roles is part of manage_grants', async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      const addRole = anna.page.getByRole('button', { name: 'Add role' }).first();

      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'manage']);
      await anna.page.goto('/ui/identities?tab=roles');
      await recoverFromOffline(anna.page);
      await expect(anna.page.getByRole('tab', { name: /roles/i })).toBeVisible({ timeout: 20000 });
      await anna.page.waitForLoadState('networkidle').catch(() => {});
      await expect(addRole).toHaveCount(0);

      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['manage_grants']);
      await anna.page.reload();
      await expect(addRole).toBeVisible({ timeout: 20000 });
    } finally {
      await anna.ctx.close();
    }
  });

  test('server grants go to users only', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    const dialog = await openServerGrantDialog(page);
    await expect(dialog.getByText('Server privileges go to users only.', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Search for a user to grant privileges to.')).toBeVisible();
  });

  test('grantable privileges are worded per level', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    await gotoGrantsExplorer(page);
    await page.getByRole('button', { name: 'Grantable privileges' }).click();
    const ref = page.locator('.v-overlay__content').filter({ hasText: 'Grantable privileges' }).last();
    await expect(ref.getByText('read_policies', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(ref.getByText('manage_tags', { exact: true })).toBeVisible();

    await test.step('the tooltip breaks the wording down by level', async () => {
      await ref.getByText('Read grants', { exact: true }).hover();
      const tip = page.locator('.v-tooltip .v-overlay__content').filter({ visible: true }).last();
      await expect(tip).toContainText('Server:', { timeout: 10000 });
      await expect(tip).toContainText('Table');
    });

    await test.step('with a level selected, only its wording is searched', async () => {
      const filter = ref.getByPlaceholder(/filter privileges/i).or(ref.getByLabel(/filter privileges/i)).first();
      // Only the server-level wording of read_grants says this.
      await filter.fill('beneath the server');
      await expect(ref.getByText('read_grants', { exact: true })).toHaveCount(1);
      await ref.locator('th', { hasText: /^\s*table\s*$/i }).first().click();
      await expect(ref.getByText('Table only')).toBeVisible();
      await expect(ref.getByText('read_grants', { exact: true })).toHaveCount(0);
    });
  });

  test('checking another user needs manage_grants', async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(300000);
    test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured');
    const wh = await createWarehouse(page, ENABLED_BACKENDS[0]);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe']);

      await gotoPolicies(anna.page);
      await openRailTab(anna.page, 'Resolve Entities');
      await anna.page.getByLabel('Query for another principal').check();
      await anna.page.locator('.v-input', { hasText: 'User' }).filter({ hasNot: anna.page.getByText('Query for another') }).first().click();
      await anna.page.keyboard.type('Peter');
      await anna.page.locator('.v-overlay--active .v-list-item', { hasText: 'Peter' }).first().click();

      const row = anna.page.locator('.v-treeview-item, .v-list-item', { hasText: new RegExp(`^\\s*${wh}\\s*$`) }).first();
      await row.hover();
      await row.locator('[class*="mdi-plus"]').first().click();
      const refusal = anna.page.getByText(
        "Checking another user's or role's access needs manage_grants on this warehouse.",
      );
      await expect(refusal.first()).toBeVisible({ timeout: 20000 });

      // The Check button asks batch-check, which refuses before anything about
      // peter is looked up.
      await anna.page.locator('.v-input', { hasText: 'Action' }).last().click();
      await anna.page.locator('.v-overlay--active .v-list-item').first().click();
      const check = anna.page.waitForResponse((r) => r.url().includes('/action/batch-check'));
      await anna.page.getByRole('button', { name: 'Check', exact: true }).click();
      const res = await check;
      expect(res.status()).toBe(403);
      expect((await res.json())?.error?.type).toBe('CannotInspectPermissions');
      await expect(refusal.last()).toBeVisible();
    } finally {
      await anna.ctx.close();
    }
  });

  test('manage_tags tags only with apply on the tag', async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(300000);
    test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured');
    const wh = await createWarehouse(page, ENABLED_BACKENDS[0]);
    const whId = await warehouseIdOf(page, project.id, wh);
    const tagName = 'e2e-manage-tags';
    const tagId = await ensureWarehouseTag(page, project.id, tagName);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe']);
      await setUserGrants(page, project.id, { type: 'warehouse', warehouseId: whId }, annaId, ['manage_tags']);

      await test.step('without apply: listed but locked', async () => {
        await openWarehouse(anna.page, wh);
        const menu = await openTagAddMenu(anna.page);
        const item = await pickerItem(anna.page, menu, tagName);
        await expect(item).toBeVisible({ timeout: 15000 });
        await expect(item).toContainText('You are not allowed to apply this tag', { timeout: 15000 });
        await closeTagMenu(anna.page, menu);
      });

      await test.step('with apply: offered', async () => {
        await setUserGrants(page, project.id, { type: 'tag-definition', tagDefinitionId: tagId }, annaId, ['apply']);
        await anna.page.reload();
        const menu = await openTagAddMenu(anna.page);
        const item = await pickerItem(anna.page, menu, tagName);
        await expect(item).toBeVisible({ timeout: 15000 });
        await expect(item).not.toContainText('You are not allowed to apply this tag', { timeout: 15000 });
        await expect(item).not.toHaveClass(/v-list-item--disabled/);
      });
    } finally {
      await anna.ctx.close();
    }
  });
});

// OpenFGA keeps its own grant store: roles may hold server grants, and the
// project-wide "everything one principal holds" listing does not exist.
test.describe('grant rights under OpenFGA @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('server grants may name roles', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    const dialog = await openServerGrantDialog(page);
    await expect(dialog.getByRole('button', { name: 'Role', exact: true })).toBeVisible();
    await expect(dialog.getByText('Server privileges go to users only.', { exact: false })).toHaveCount(0);
  });

  test('user rows offer no principal-wide grants listing', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    await page.goto('/ui/identities?tab=users');
    await recoverFromOffline(page);
    await expect(page.getByRole('row').filter({ hasText: 'Peter' }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Grants', exact: true })).toHaveCount(0);
  });
});

// allow-all: everyone may do everything, so there is nothing to grant.
test.describe('grant rights under allow-all @authn', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('no grants surface anywhere', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    await page.goto('/ui/server-settings');
    await recoverFromOffline(page);
    await expect(page.getByRole('tab', { name: /overview/i })).toBeVisible({ timeout: 20000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByRole('tab', { name: /^grants$/i })).toHaveCount(0);

    await page.goto('/ui/governance');
    await recoverFromOffline(page);
    await expect(page.getByRole('tab', { name: /tags/i })).toBeVisible({ timeout: 20000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByRole('tab', { name: /^grants$/i })).toHaveCount(0);
  });
});
