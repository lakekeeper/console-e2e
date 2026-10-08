import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { applyProject, authToken } from '../_utils/project';
import { resetCedarPolicy } from '../_utils/cedar';
import { ANNA_BASE_URL, isLk014Cedar, openRailTab, userIdOf } from '../_utils/grants';

// Recovery from a self-inflicted Cedar lockout (lakekeeper "UI: Recovery Mode for
// Cedar"). The operator's server policy lets anna do everything; anna then
// stores a project policy that forbids everything, and is locked out of her own
// project. A break-glass request is decided by the server set alone, so it is
// her way back: the console must get her to the project's policies, let her
// start break-glass with a reason, and let her delete the forbid.
//
// anna's context is joined to the project but NOT pinned to it (no pinProject):
// whether the console still reaches a project she can no longer list is part of
// what is tested.

const API = process.env.LK_API_URL || 'http://localhost:8181';
const dir = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = path.resolve(dir, '../../cedar/policies.cedar');
const LOCKOUT = 'e2e-lockout';
// Cedar's JSON form of `forbid (principal, action, resource);`
const FORBID_ALL = {
  effect: 'forbid',
  principal: { op: 'All' },
  action: { op: 'All' },
  resource: { op: 'All' },
  conditions: [],
};

/** The server set: the base file plus a permit-everything for anna. */
function grantAnnaEverythingOnServer(annaId: string) {
  resetCedarPolicy();
  fs.appendFileSync(
    POLICY_FILE,
    `
// Operator grant (added live by the break-glass recovery test): anna may do everything.
permit (
    principal == Lakekeeper::User::"${annaId}",
    action,
    resource
);
`,
  );
}

async function api(page: Page, method: string, url: string, projectId: string, body?: unknown, breakGlass?: string) {
  const token = await authToken(page);
  const headers: Record<string, string> = { 'x-project-id': projectId };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (breakGlass) headers['x-break-glass'] = breakGlass;
  return page.request.fetch(`${API}${url}`, { method, headers, data: body });
}

test.describe('break-glass recovery from a project lockout @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ bootstrappedPage: page, project }) => {
    test.skip(!(await isLk014Cedar(page, project.id)), 'needs a Lakekeeper 0.14 Plus image');
  });

  test.afterEach(async ({ bootstrappedPage: page, project }) => {
    // Whatever happened: no lockout left in the project, and the base server set back.
    await api(page, 'POST', '/management/v1/permissions/cedar/project/policies', project.id, { deletes: [LOCKOUT] }, 'e2e cleanup').catch(() => {});
    resetCedarPolicy();
  });

  test('a user who forbade everything in her project repairs it with break-glass', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(240000);

    // anna, signed in, in her own context, joined to the project (not pinned).
    const ctx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    await applyProject(ctx, project.id, project.name);
    const anna = await ctx.newPage();
    await login(anna, TEST_USER_2);
    try {
      const annaId = await userIdOf(page, 'anna');

      await test.step('setup: the server set lets anna do everything', async () => {
        grantAnnaEverythingOnServer(annaId);
        // The file is hot-reloaded; wait until it answers for anna.
        await expect
          .poll(async () => (await api(anna, 'GET', '/management/v1/permissions/cedar/project/policies', project.id)).status(), {
            timeout: 60000,
          })
          .toBe(200);
      });

      await test.step('anna stores a project policy that forbids everything', async () => {
        const res = await api(anna, 'POST', '/management/v1/permissions/cedar/project/policies', project.id, {
          writes: [{ name: LOCKOUT, policy: FORBID_ALL }],
        });
        expect(res.status(), await res.text()).toBe(200);
        // Locked out: her own listing is refused now…
        expect((await api(anna, 'GET', '/management/v1/permissions/cedar/project/policies', project.id)).status()).toBe(403);
        // A fresh login can only pick the project if it is still listed for her.
        const list = await api(anna, 'GET', '/management/v1/project-list', project.id);
        const listed = ((await list.json())?.projects ?? []).some((p: any) => p['project-id'] === project.id);
        const listBg = await api(anna, 'GET', '/management/v1/project-list', project.id, undefined, 'INC-e2e');
        const listedBg = ((await listBg.json())?.projects ?? []).some((p: any) => p['project-id'] === project.id);
        console.log(`DIAG listed-after-lockout=${listed} with-break-glass=${listedBg}`);
        // …and break-glass would get her back.
        const status = await api(anna, 'GET', `/management/v1/permissions/cedar/break-glass-status?project-id=${project.id}`, project.id);
        expect((await status.json())?.['break-glass-available']).toBe(true);
      });

      await test.step('the console still brings her to the project', async () => {
        await anna.goto('/ui/governance?tab=policies');
        await anna.waitForLoadState('networkidle').catch(() => {});
        await test.info().attach('anna-after-lockout', { body: await anna.screenshot(), contentType: 'image/png' });
        await expect(anna, 'redirected away from the policies').toHaveURL(/\/ui\/governance/, { timeout: 20000 });
        // The app moves away from a project it cannot find in the project list.
        await expect
          .poll(
            () =>
              anna.evaluate(() => {
                try {
                  return JSON.parse(localStorage.getItem('visual') || '{}')?.projectSelected?.['project-id'] ?? '';
                } catch {
                  return '';
                }
              }),
            { message: 'the locked project is no longer selected', timeout: 15000 },
          )
          .toBe(project.id);
      });

      await test.step('Stored Policies offers break-glass', async () => {
        await openRailTab(anna, 'Stored Policies');
        await test.info().attach('anna-stored-policies', { body: await anna.screenshot(), contentType: 'image/png' });
        await expect(anna.getByRole('button', { name: 'Break-glass', exact: true })).toBeVisible({ timeout: 20000 });
      });

      await test.step('with a reason she sees the lockout and deletes it', async () => {
        await anna.getByRole('button', { name: 'Break-glass', exact: true }).click();
        await anna.getByLabel('Break-glass reason *').fill('INC-e2e removing my lockout');
        await anna.getByRole('button', { name: 'Start break-glass' }).click();
        await expect(anna.getByText(LOCKOUT, { exact: true }).first()).toBeVisible({ timeout: 20000 });

        const write = anna.waitForResponse(
          (r) => r.url().endsWith('/permissions/cedar/project/policies') && r.request().method() === 'POST',
        );
        await anna.getByRole('button', { name: `Delete ${LOCKOUT}` }).click();
        const confirm = anna.locator('.v-overlay__content').filter({ hasText: /delete/i }).last();
        await confirm.getByRole('button', { name: /^delete$/i }).click();
        const res = await write;
        expect(res.request().headers()['x-break-glass']).toBe('INC-e2e removing my lockout');
        expect(res.status()).toBe(200);
      });

      await test.step('repaired: she reads her policies again without break-glass', async () => {
        expect((await api(anna, 'GET', '/management/v1/permissions/cedar/project/policies', project.id)).status()).toBe(200);
      });
    } finally {
      await ctx.close();
    }
  });
});
