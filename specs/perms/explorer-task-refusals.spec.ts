import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { pinProject } from '../_utils/project';
import { gotoReady } from '../_utils/app';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse, selectTab } from '../_utils/warehouse';
import { resetCedarPolicy } from '../_utils/cedar';
import { seedTagDefinitions } from '../_utils/seed';

// A missing right must never look like missing data. These journeys cover the
// task listings and the Grants explorer's pickers for a user (anna) who is
// refused them, and check the refusal is SAID in place — not "No tasks", not
// "check your connection", not "No tags." — and not repeated in a snackbar.
// The peter half checks the opposite: the admin sees the real surface, and the
// maintenance dashboard does not flash a denial at him while his rights load.
//
// What is NOT covered here, and why:
//   • TaskManager / ProjectTaskManager (OSS) "You do not have permission to view
//     tasks.": under OpenFGA the Tasks tab is gated on get_all_tasks, which is
//     the same relation (describe_effective) as list_everything — so a user who
//     sees the tab can always list. The refusal only happens under Cedar, which
//     is console-plus only, where the warehouse Tasks tab is MaintenanceActivity.
//   • TagPermissionsPanel and PermissionExplorer: hidden behind
//     PERMISSIONS_UI_ENABLED=false (console-components common/featureFlags.ts).
//   • The Grants explorer's "not allowed to read <object>" on a tree pick: it
//     needs an object anna can LIST but not READ. OpenFGA ties both to one
//     relation, and Cedar answers an unreadable object as not found.

// anna runs in a FRESH browser context, which does NOT inherit the config's
// baseURL — see perms/access-control.spec.ts.
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

const isConsolePlus =
  process.env.SERVED_UI === '1'
    ? (process.env.SERVED_APP || 'console-plus') === 'console-plus'
    : process.env.APP === 'console-plus';

const SUFFIX = process.env.E2E_RESOURCE_SUFFIX || '';

const TASKS_REFUSED = 'You are not allowed to see tasks in this warehouse.';
const TAGS_REFUSED = 'You are not allowed to list tag definitions in this project.';

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
 * Record every text that was EVER in the DOM matching one of `needles`, and
 * every snackbar text, from the first paint on. A flash or a snackbar lasts a
 * few seconds at most, so asserting at the end would miss both.
 */
async function watchDom(target: Page, needles: string[]) {
  await target.addInitScript((list: string[]) => {
    const w = window as any;
    w.__e2eSeen = [];
    w.__e2eSnacks = [];
    const check = () => {
      const text = document.body?.textContent ?? '';
      for (const n of list) if (text.includes(n) && !w.__e2eSeen.includes(n)) w.__e2eSeen.push(n);
      for (const el of Array.from(document.querySelectorAll('.v-snackbar__content'))) {
        const t = (el.textContent || '').trim();
        if (t && !w.__e2eSnacks.includes(t)) w.__e2eSnacks.push(t);
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, needles);
}

async function seen(target: Page): Promise<{ texts: string[]; snacks: string[] }> {
  return target.evaluate(() => ({
    texts: (window as any).__e2eSeen ?? [],
    snacks: (window as any).__e2eSnacks ?? [],
  }));
}

/**
 * A restricted user's first calls can 401 while her token hydrates (see
 * console-e2e/CLAUDE.md), which leaves the pane empty rather than refused.
 * Reload — and re-run `reopen`, which puts the pane back — until it shows.
 */
async function expectAfterReload(
  target: Page,
  locator: Locator,
  reopen: () => Promise<unknown> = async () => {},
  tries = 3,
) {
  for (let i = 0; i < tries; i++) {
    if (await locator.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) return;
    await target.reload().catch(() => {});
    await target.waitForLoadState('domcontentloaded').catch(() => {});
    await reopen();
  }
  await expect(locator).toBeVisible({ timeout: 15000 });
}

function warehouseIdFromUrl(target: Page): string {
  return target.url().match(/\/warehouse\/([^/?#]+)/)?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// Cedar: anna may describe the warehouse, which publishes get_all_tasks and so
// offers her the Tasks tab — but listing every task also needs
// ListEverythingInWarehouse, which the policy forbids. The listing is refused
// with a 403, the one case where the Tasks tab is offered and then refused.
// ---------------------------------------------------------------------------

const ANNA = 'oidc~d223d88c-85b6-4859-b5c5-27f3825e47f6';
const POLICY_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cedar/policies.cedar',
);

/** Base policy (via cedar.ts) plus anna's describe-but-not-list-all block. */
function grantAnnaDescribeWithoutListAll(wh: string) {
  resetCedarPolicy();
  const base = fs.readFileSync(POLICY_FILE, 'utf8');
  fs.writeFileSync(
    POLICY_FILE,
    `${base}
// GRANT (added live by explorer-task-refusals): anna may describe ${wh}…
permit (
    principal == Lakekeeper::User::"${ANNA}",
    action in [
        Lakekeeper::Action::"ProjectDescribeActions",
        Lakekeeper::Action::"WarehouseDescribeActions"
    ],
    resource
)
when {
    resource is Lakekeeper::Project
    || (resource is Lakekeeper::Warehouse && resource.name == "${wh}")
};

// …but not list everything in it, which listing all of its tasks requires.
forbid (
    principal == Lakekeeper::User::"${ANNA}",
    action == Lakekeeper::Action::"ListEverythingInWarehouse",
    resource
)
when { resource is Lakekeeper::Warehouse && resource.name == "${wh}" };
`,
  );
}

test.describe('task refusals (cedar) @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // Cedar is console-plus only, and the warehouse Tasks tab there is
  // MaintenanceActivity. Silo, never AWS: only a warehouse is needed.
  const backend =
    ENABLED_BACKENDS.find((b) => b.key.includes('silo')) ?? ENABLED_BACKENDS[0];

  test.beforeEach(() => resetCedarPolicy());
  test.afterEach(() => resetCedarPolicy()); // never leave anna granted

  test('anna is told the warehouse tasks are refused, in place and without a snackbar', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.skip(!backend, 'no storage backend configured');
    test.setTimeout(240000);

    const wh = await createWarehouse(page, backend!, `${SUFFIX}tasks`);
    await openWarehouse(page, wh);
    const whId = warehouseIdFromUrl(page);
    expect(whId, 'could not read the warehouse id from the route').not.toBe('');

    await test.step('peter sees the tasks surface, not a refusal', async () => {
      await selectTab(page, /^tasks$/i);
      await expect(page.getByText(TASKS_REFUSED)).toHaveCount(0);
      // Either the empty window or a table of tasks — both are the real answer.
      await expect(page.locator('.activity-table-region').first()).toBeVisible({ timeout: 20000 });
    });

    grantAnnaDescribeWithoutListAll(wh);
    await page.waitForTimeout(6000); // Cedar hot-reloads the policy file

    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      await watchDom(anna, [TASKS_REFUSED, 'check your connection']);
      const openTasks = async () => {
        await gotoReady(anna, `/ui/warehouse/${whId}`);
        await selectTab(anna, /^tasks$/i);
      };
      await openTasks();

      await test.step('the refusal is said where the tasks would be', async () => {
        await expectAfterReload(anna, anna.getByText(TASKS_REFUSED).first(), openTasks);
        // Not the empty state, and not a connection problem.
        await expect(anna.getByText('No tasks in the selected window.')).toHaveCount(0);
        const { texts } = await seen(anna);
        expect(texts, 'a refusal must not read as a connection error').not.toContain(
          'check your connection',
        );
      });

      await test.step('…and is not repeated in a snackbar', async () => {
        const { snacks } = await seen(anna);
        expect(
          snacks.filter((s) => /task/i.test(s)),
          `snackbars about tasks: ${snacks.join(' | ')}`,
        ).toEqual([]);
      });
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Grants explorer, Tags scope: in the test's own project anna holds nothing, so
// listing the tag vocabulary is refused (OpenFGA: can_list_tags = project
// get_metadata; Cedar base policy: nothing). The list must say so, not "No tags."
// ---------------------------------------------------------------------------

/** The Grants explorer's scope switch. Its labels fold to icons below ~520px,
 *  so the button is found by its icon. */
function scopeButton(target: Page, icon: string): Locator {
  return target.locator('.v-btn-toggle').first().locator(`button:has(.${icon})`).first();
}

async function openGrantsTagsScope(target: Page) {
  await gotoReady(target, '/ui/governance?tab=grants');
  await selectTab(target, /^grants$/i);
  const tags = scopeButton(target, 'mdi-tag-outline');
  await tags.waitFor({ state: 'visible', timeout: 20000 });
  await tags.click();
}

test.describe('grants explorer refusals @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('anna is told she may not list tag definitions; peter sees them', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(180000);
    const [tagName] = await seedTagDefinitions(page, 1, 'e2e.explorer', ['namespace']);

    await test.step('peter: the Tags scope lists the definition', async () => {
      await openGrantsTagsScope(page);
      await expect(page.getByText(tagName, { exact: true }).first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText(TAGS_REFUSED)).toHaveCount(0);
    });

    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      await test.step("anna: the Tags scope says it is refused, not 'No tags.'", async () => {
        await openGrantsTagsScope(anna);
        await expectAfterReload(anna, anna.getByText(TAGS_REFUSED), () => openGrantsTagsScope(anna));
        await expect(anna.getByText('No tags.', { exact: true })).toHaveCount(0);
        await expect(anna.getByText(tagName, { exact: true })).toHaveCount(0);
      });
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Maintenance dashboard (console-plus): the project-tasks gate waited for "not
// loading", which is also true BEFORE the first request starts — so everyone
// saw the "no access" alert for a tick. It must only show once the server has
// said no.
// ---------------------------------------------------------------------------

const NO_PROJECT_ACCESS = "You don't have project-level maintenance access.";
const NO_ACCESS_AT_ALL = "You don't have permission to view maintenance for any warehouse";

test.describe('maintenance dashboard gate @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!isConsolePlus, 'the maintenance dashboard is console-plus only');

  test('peter never sees the denial flash; anna is told she has no access', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    test.setTimeout(120000);

    await test.step('peter: no denial at any point while rights load', async () => {
      await watchDom(page, [NO_PROJECT_ACCESS, NO_ACCESS_AT_ALL]);
      await gotoReady(page, '/ui/maintenance');
      await expect(page.getByRole('tab', { name: /status/i }).first()).toBeVisible({ timeout: 20000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      const { texts } = await seen(page);
      expect(texts, 'the admin must never be shown a maintenance denial').toEqual([]);
    });

    const { ctx, page: anna } = await annaIn(browser, project);
    try {
      await test.step('anna, with no right in the project, is told so', async () => {
        await gotoReady(anna, '/ui/maintenance');
        await expectAfterReload(anna, anna.getByText(NO_ACCESS_AT_ALL));
      });
    } finally {
      await ctx.close();
    }
  });
});
