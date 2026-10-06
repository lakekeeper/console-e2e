import { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { authToken, pinProject } from '../_utils/project';
import { gotoReady } from '../_utils/app';
import { gotoTagDefinitions } from '../_utils/tags';

// A missing right must never look like missing data. These journeys open the
// identity surfaces as anna, who holds nothing in the test's project, and check
// that each one SAYS it was refused instead of reading "No members" / "No
// owners" / a blank tab — and that controls she cannot use are not offered.
// The peter half checks the opposite failure: a denial must not flash at the
// admin while his rights are still being read.

// anna runs in a FRESH browser context, which does NOT inherit the config's
// baseURL — see perms/access-control.spec.ts.
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : 'http://localhost:3001';

const API = process.env.LK_API_URL || 'http://localhost:8181';

const ROLES_DENIED = "You don't have permission to list roles.";
const TAGS_DENIED = "You don't have permission to list tag definitions";

/** Create (or find) a role in the given project as peter, via the API. */
async function ensureRole(page: Page, projectId: string, name: string): Promise<string> {
  const token = await authToken(page);
  const headers: Record<string, string> = { 'x-project-id': projectId };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await page.request.post(`${API}/management/v1/role`, {
    headers,
    data: { name, description: 'created by e2e (identity refusals)' },
  });
  if (res.ok()) return (await res.json())['id'];
  // A retry of this same test: the role is already there.
  const search = await page.request.post(`${API}/management/v1/search/role`, {
    headers,
    data: { search: name },
  });
  const roles = search.ok() ? ((await search.json())?.roles ?? []) : [];
  const id = roles.find((r: any) => r.name === name)?.id;
  if (!id) throw new Error(`could not create role ${name}: ${res.status()} ${await res.text()}`);
  return id;
}

/** anna, logged in, in her own context, joined to the test's project. */
async function annaIn(
  browser: Browser,
  project: { id: string; name: string },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: ANNA_BASE_URL });
  await pinProject(ctx, project.id, project.name);
  const page = await ctx.newPage();
  await login(page, TEST_USER_2);
  return { ctx, page };
}

/**
 * A restricted user's first calls can 401 while her token hydrates (see
 * console-e2e/CLAUDE.md), which leaves the pane empty rather than refused.
 * Reload until the expected text shows.
 */
async function expectAfterReload(page: Page, locator: Locator, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (await locator.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) return;
    await page.reload().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await expect(locator).toBeVisible({ timeout: 15000 });
}

/** Click a vertical-rail tab until it is selected (Vuetify can reset it while loading). */
async function openTab(page: Page, name: RegExp) {
  const tab = page.getByRole('tab', { name }).first();
  for (let i = 0; i < 5; i++) {
    await tab.click({ timeout: 10000 });
    if ((await tab.getAttribute('aria-selected')) === 'true') return;
    await page.waitForTimeout(500);
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Record whether any of `needles` was EVER in the DOM, from the first paint on.
 * A flash lasts a tick, so asserting absence at the end would miss it.
 */
async function watchForText(page: Page, needles: string[]) {
  await page.addInitScript((list: string[]) => {
    (window as any).__e2eSeen = [];
    const check = () => {
      const text = document.body?.textContent ?? '';
      for (const n of list) {
        if (text.includes(n) && !(window as any).__e2eSeen.includes(n)) {
          (window as any).__e2eSeen.push(n);
        }
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, needles);
}

async function seenTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__e2eSeen ?? []);
}

// Roles, their members and owners are OpenFGA-managed here (@authz). Cedar has
// no role lifecycle in the console, so it is not tagged.
test.describe('identity refusals @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('anna sees refusals, not empty lists, on a role she cannot read', async ({
    bootstrappedPage: page,
    project,
    browser,
  }) => {
    test.setTimeout(180000);
    const roleId = await ensureRole(page, project.id, 'e2e-refusal-role');

    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      // The Identities page mounts the role pane without a read gate of its
      // own, so every tab has to answer for itself.
      await gotoReady(anna, `/ui/identities?tab=roles&role=${roleId}`);

      await test.step('Details says the role cannot be read, and offers no edit', async () => {
        await expectAfterReload(anna, anna.getByText('You are not allowed to read this role.'));
        await expect(anna.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
      });

      await test.step("Owners says it is refused, not 'No owners'", async () => {
        await openTab(anna, /^Owners/i);
        await expect(anna.getByText("You are not allowed to see this role's owners.")).toBeVisible({
          timeout: 15000,
        });
        await expect(anna.getByText('No owners', { exact: true })).toHaveCount(0);
        await expect(anna.getByRole('button', { name: /add owner/i })).toHaveCount(0);
      });

      await test.step("Members says it is refused, not 'No members'", async () => {
        await openTab(anna, /^Members/i);
        await expect(anna.getByText("You are not allowed to see this role's members.")).toBeVisible({
          timeout: 15000,
        });
        await expect(anna.getByText('No members', { exact: true })).toHaveCount(0);
        await expect(anna.getByRole('button', { name: /add member/i })).toHaveCount(0);
      });

      await test.step("Member of says it is refused, not 'not a member of any role'", async () => {
        await openTab(anna, /^Member of/i);
        await expect(
          anna.getByText('You are not allowed to see which roles this role belongs to.'),
        ).toBeVisible({ timeout: 15000 });
        await expect(anna.getByText('This role is not a member of any other role.')).toHaveCount(0);
      });
    } finally {
      await ctx.close();
    }
  });

  test('anna is told she may not list roles or users', async ({
    bootstrappedPage: page,
    project,
    browser,
  }) => {
    test.setTimeout(120000);
    void page; // the fixture creates the project anna joins
    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      await test.step('the roles page states the refusal and offers no Add Role', async () => {
        await gotoReady(anna, '/ui/roles');
        await expectAfterReload(anna, anna.getByText(ROLES_DENIED));
        await expect(anna.getByRole('button', { name: /add role/i })).toHaveCount(0);
      });

      await test.step("Identities never shows anna an empty 'No users found' list", async () => {
        await gotoReady(anna, '/ui/identities');
        // The Users tab is withheld without list_users; the Roles tab answers.
        await expectAfterReload(anna, anna.getByText(ROLES_DENIED));
        await expect(anna.getByRole('tab', { name: /^Users$/i })).toHaveCount(0);
        await expect(anna.getByText('No users found')).toHaveCount(0);
      });
    } finally {
      await ctx.close();
    }
  });

  test('anna is not offered rename or delete on a project she cannot administer', async ({
    bootstrappedPage: page,
    project,
    browser,
  }) => {
    test.setTimeout(120000);
    void page;
    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      await gotoReady(anna, `/ui/projects/${project.id}`);
      // The identity row names the project once the pane has mounted.
      await expectAfterReload(anna, anna.getByText(project.id).first());
      // Rights are read per project; give the answer time to land before
      // asserting the controls never appeared.
      await anna.waitForLoadState('networkidle').catch(() => {});
      await expect(anna.getByRole('button', { name: /^Rename$/ })).toHaveCount(0);
      await expect(anna.getByRole('button', { name: /^Delete$/ })).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('peter never sees a permission denial flash on the roles page', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(90000);
    await watchForText(page, [ROLES_DENIED]);
    await gotoReady(page, '/ui/roles');
    // RoleManager's list controls render only once list_roles has answered yes.
    await expect(page.getByRole('textbox', { name: 'Search roles' })).toBeVisible({ timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await seenTexts(page), 'the roles denial must never render for the admin').toEqual([]);
  });
});

// Tag definitions exist under every authenticated mode.
test.describe('identity refusals: tag definitions @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('peter never sees a permission denial flash on the tag definitions page', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(90000);
    await watchForText(page, [TAGS_DENIED]);
    await gotoTagDefinitions(page);
    // The filter rail renders only once list_tags has answered yes.
    await expect(page.getByRole('textbox', { name: 'Filter text' })).toBeVisible({ timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await seenTexts(page), 'the tags denial must never render for the admin').toEqual([]);
  });
});
