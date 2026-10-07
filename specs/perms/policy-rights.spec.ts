import { Page, Request } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse } from '../_utils/warehouse';
import {
  annaIn,
  gotoPolicies,
  isLk014Cedar,
  openRailTab,
  setProjectPredefined,
  setUserGrants,
  userIdOf,
} from '../_utils/grants';

// Lakekeeper 0.14: the policy listings say what the caller may change —
// `can-write` on stored policies, `can-toggle` on each predefined policy — and
// the console follows them instead of offering a write the server refuses.
// Break-glass is a mode started once per page with a reason, which instance
// admins (peter) always need to change stored policies.
//
// anna gets exactly one privilege per test, granted over the API in the test's
// own project, so nothing needs undoing afterwards.

const READ_ONLY_HINT = "You can read these policies but can't switch any of them here.";
// Shipped with every 0.14 pack, and harmless to switch: it only decides tagging.
const MANAGE_TAGS = 'predefined-grants-warehouse-manage-tags';

/** The switch of one predefined policy row. */
function policySwitch(page: Page, id: string) {
  return page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) }).getByRole('checkbox');
}

async function openPredefined(page: Page) {
  await gotoPolicies(page);
  await openRailTab(page, 'Predefined Policies');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByText(/\d+\s*\/\s*\d+\s+enforced/)).toBeVisible({ timeout: 30000 });
}

test.describe('policy rights (Lakekeeper 0.14) @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ bootstrappedPage: page, project }) => {
    test.skip(!(await isLk014Cedar(page, project.id)), 'needs a Lakekeeper 0.14 Plus image');
  });

  test('read_policies alone: everything readable, nothing switchable', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'read_policies']);
      // Curated, so there is something to reset.
      await setProjectPredefined(page, project.id, [{ id: MANAGE_TAGS, enabled: true }]);

      await test.step('predefined: listed, every switch disabled, with the read-only hint', async () => {
        await openPredefined(anna.page);
        await expect(anna.page.getByText(READ_ONLY_HINT)).toBeVisible({ timeout: 20000 });
        const switches = anna.page.getByRole('checkbox');
        await expect(switches.first()).toBeVisible();
        const n = await switches.count();
        for (let i = 0; i < n; i++) await expect(switches.nth(i)).toBeDisabled();
      });

      // Reset carries no flag: it is offered, and the server's refusal is shown.
      await test.step('reset: offered, refused in place', async () => {
        await anna.page.locator('button:has(.mdi-dots-vertical)').first().click();
        await anna.page.locator('.v-overlay--active .v-list-item', { hasText: 'Reset to inherited' }).click();
        const confirm = anna.page.locator('.v-overlay__content').filter({ hasText: /Drop this scope/ }).last();
        const reset = anna.page.waitForResponse(
          (r) => r.url().endsWith('/project/predefined-policies') && r.request().method() === 'DELETE',
        );
        await confirm.getByRole('button', { name: 'Reset', exact: true }).click();
        expect((await reset).status()).toBe(403);
        await expect(confirm.locator('.v-alert')).toContainText(/reset_predefined_policies|not allowed/i, {
          timeout: 10000,
        });
        await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      });

      await test.step('stored: listed without a New policy button', async () => {
        await openRailTab(anna.page, 'Stored Policies');
        await expect(anna.page.getByText(/don't have permission/i)).toHaveCount(0);
        await expect(anna.page.getByRole('button', { name: 'New policy', exact: true })).toHaveCount(0);
      });
    } finally {
      await anna.ctx.close();
    }
  });

  test('manage_policies: New policy offered and a switch saves', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe', 'manage_policies']);

      await openPredefined(anna.page);
      await expect(anna.page.getByText(READ_ONLY_HINT)).toHaveCount(0);
      const sw = policySwitch(anna.page, MANAGE_TAGS);
      await expect(sw).toBeEnabled({ timeout: 20000 });
      await expect(sw).toBeChecked();
      const saved = anna.page.waitForResponse(
        (r) => r.url().endsWith('/project/predefined-policies') && r.request().method() === 'POST',
      );
      await sw.click({ force: true });
      expect((await saved).status()).toBe(200);
      await expect(sw).not.toBeChecked();

      await openRailTab(anna.page, 'Stored Policies');
      await expect(anna.page.getByRole('button', { name: 'New policy', exact: true })).toBeVisible({ timeout: 20000 });
    } finally {
      await anna.ctx.close();
    }
  });

  // Regression: the source tabs answer 403 to anyone without server rights and
  // are hidden, and the persisted tab started out loading — which left Refresh
  // spinning and disabled for good.
  test('no policy rights: every pane refuses, and Refresh still works', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const anna = await annaIn(browser, project);
    try {
      const annaId = await userIdOf(page, 'anna');
      await setUserGrants(page, project.id, { type: 'project' }, annaId, ['describe']);

      await gotoPolicies(anna.page);
      await openRailTab(anna.page, 'Predefined Policies');
      await expect(
        anna.page.getByText("You don't have permission to read the predefined policies of this project."),
      ).toBeVisible({ timeout: 20000 });
      await openRailTab(anna.page, 'Stored Policies');
      await expect(anna.page.getByText("You don't have permission to read this project's stored policies.")).toBeVisible({
        timeout: 20000,
      });
      await expect(anna.page.getByRole('button', { name: 'Refresh' }).first()).toBeEnabled({ timeout: 20000 });
      await expect(anna.page.locator('.v-progress-circular--indeterminate').filter({ visible: true })).toHaveCount(0);
    } finally {
      await anna.ctx.close();
    }
  });

  test('break-glass: refused reasons, then one reason opens stored policies', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180000);
    const listings: string[] = [];
    page.on('request', (r: Request) => {
      if (r.method() === 'GET' && r.url().endsWith('/permissions/cedar/project/policies')) {
        listings.push(r.headers()['x-break-glass'] ?? '');
      }
    });

    await gotoPolicies(page);
    await openRailTab(page, 'Stored Policies');
    // peter is an instance admin: stored policies stay read-only without a reason.
    await expect(page.getByRole('button', { name: 'Break-glass', exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'New policy', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Break-glass', exact: true }).click();
    const reason = page.getByLabel('Break-glass reason *');
    const start = page.getByRole('button', { name: 'Start break-glass' });
    // `true` is the bare value the server does not count as a reason; the
    // console accepts one line of printable ASCII.
    for (const bad of ['true', '', 'prüfung']) {
      await reason.fill(bad);
      await expect(start, `reason ${JSON.stringify(bad)}`).toBeDisabled();
    }
    await reason.fill('e2e break-glass');
    await start.click();

    await expect(page.getByText('Break-glass active')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'New policy', exact: true })).toBeVisible({ timeout: 20000 });
    // The listing is asked again with the reason, so its flags answer for it.
    await expect.poll(() => listings.includes('e2e break-glass'), { timeout: 15000 }).toBe(true);

    await page.locator('.v-chip', { hasText: 'Break-glass active' }).locator('.v-chip__close').click();
    await expect(page.getByRole('button', { name: 'New policy', exact: true })).toHaveCount(0, { timeout: 20000 });
  });

  test('break-glass rides on a predefined switch', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180000);
    await gotoPolicies(page);
    await openRailTab(page, 'Stored Policies');
    await page.getByRole('button', { name: 'Break-glass', exact: true }).click();
    await page.getByLabel('Break-glass reason *').fill('e2e predefined');
    await page.getByRole('button', { name: 'Start break-glass' }).click();
    await expect(page.getByText('Break-glass active')).toBeVisible({ timeout: 10000 });

    await openRailTab(page, 'Predefined Policies');
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    const sw = policySwitch(page, MANAGE_TAGS);
    await expect(sw).toBeEnabled({ timeout: 20000 });
    const write = page.waitForRequest(
      (r) => r.url().endsWith('/project/predefined-policies') && r.method() === 'POST',
    );
    await sw.click({ force: true });
    expect((await write).headers()['x-break-glass']).toBe('e2e predefined');
  });

  test('a warehouse policy the project holds off is locked, and bulk skips it', async ({
    bootstrappedPage: page,
    project,
  }) => {
    test.setTimeout(300000);
    test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured');
    const wh = await createWarehouse(page, ENABLED_BACKENDS[0]);
    await setProjectPredefined(page, project.id, [{ id: MANAGE_TAGS, enabled: false }]);

    await gotoPolicies(page);
    await openRailTab(page, 'Predefined Policies');
    await page.getByRole('button', { name: 'Warehouse', exact: true }).click();
    await page.locator('.v-input', { hasText: 'Warehouse' }).last().click();
    await page.locator('.v-overlay--active .v-list-item', { hasText: wh }).first().click();

    const held = policySwitch(page, MANAGE_TAGS);
    await expect(held).toBeDisabled({ timeout: 30000 });
    await expect(page.getByRole('row').filter({ hasText: MANAGE_TAGS }).getByText('disabled in project')).toBeVisible();

    for (const action of ['Disable all', 'Enable all']) {
      await test.step(action, async () => {
        await page.locator('button:has(.mdi-dots-vertical)').first().click();
        await page.locator('.v-overlay--active .v-list-item', { hasText: action }).click();
        const dialog = page.locator('.v-overlay--active').last();
        const write = page.waitForRequest(
          (r) => /\/warehouse\/[^/]+\/predefined-policies$/.test(r.url()) && r.method() === 'POST',
        );
        await dialog.getByRole('button', { name: new RegExp(`^${action}$`, 'i') }).click();
        const body = (await write).postDataJSON();
        const ids = (body?.changes ?? []).map((c: any) => c.id);
        expect(ids.length).toBeGreaterThan(0);
        // Only entries you can switch are sent; one refused entry would refuse all.
        expect(ids).not.toContain(MANAGE_TAGS);
        await expect(held).toBeDisabled();
      });
    }
  });
});
