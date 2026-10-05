import { test, expect } from '../_fixtures/auth.fixture';
import type { Page } from '@playwright/test';
import { login, TEST_USER_2 } from '../_utils/auth';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace, openWarehouse, openNamespace, selectTab } from '../_utils/warehouse';
import { grantOnCurrentPanel } from '../_utils/permissions';
import { authToken, applyProject } from '../_utils/project';
import { namespaceIdOf, seedTagDefinitions } from '../_utils/seed';
import { recoverFromOffline } from '../_utils/app';
import {
  applyEntityTag,
  closeTagMenu,
  openTagAddMenu,
  openTagDefinition,
  pickerOffers,
  tagChip,
  tagDefinitionIdFromUrl,
  tagsSection,
  waitForTagsSection,
} from '../_utils/tags';

// Per-tag rights on the inline tag editor (useTagRights / TagAddMenu) and the
// tag detail page's refusals (TagDetail). OpenFGA only: noauth/authn have no
// authorizer (useTagRights is "unrestricted" there), and Cedar decides tag
// access from its policy file, not from a grant made in the UI.
//
// Writing a tag takes two rights: manage_tags on the object AND `apply` on the
// tag definition itself (lakekeeper_catalog_tag.fga). The picker only offers
// what the caller may apply, so a reader holding the first but not the second
// must not be offered the tag at all.

// anna runs in a FRESH browser context, which does not inherit the config
// baseURL (same as access-control.spec.ts).
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;
const API = process.env.LK_API_URL || 'http://localhost:8181';

/** The project the app on this page has selected (its persisted store), so
 *  API calls land where the UI journey does. Not seed.ts's currentProject():
 *  with isolatedProject:false that still holds whatever project the worker's
 *  previous isolated test selected. */
async function selectedProject(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(() => {
    try {
      const p = JSON.parse(localStorage.getItem('visual') || '{}')?.projectSelected ?? {};
      return { id: p['project-id'] ?? '', name: p['project-name'] ?? '' };
    } catch {
      return { id: '', name: '' };
    }
  });
}

/** A management/catalog call as peter, in the project his app has selected. */
async function api(page: Page, method: string, path: string, data?: unknown) {
  const token = await authToken(page);
  const { id } = await selectedProject(page);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (id) headers['x-project-id'] = id;
  return page.request.fetch(`${API}${path}`, { method, headers, data });
}

async function userIdOf(page: Page, username: string): Promise<string> {
  const res = await api(page, 'GET', `/management/v1/user?search=${encodeURIComponent(username)}`);
  expect(res.ok(), `user search failed: ${res.status()}`).toBeTruthy();
  const users: any[] = (await res.json())?.users ?? [];
  const hit = users.find((u) => String(u.name || '').toLowerCase().includes(username.toLowerCase()) ||
    String(u.email || '').toLowerCase().startsWith(username.toLowerCase()));
  expect(hit?.id, `no user "${username}" — has she logged in once?`).toBeTruthy();
  return hit.id;
}

/** Apply or revoke grants over the API (`{writes}` / `{deletes}` on a resource's
 *  /grants). Setup and cleanup only — the grant under test goes through the UI. */
async function grants(page: Page, path: string, op: 'writes' | 'deletes', userId: string, privileges: string[]) {
  const res = await api(page, 'POST', path, {
    [op]: privileges.map((privilege) => ({ principal: { user: userId }, privilege })),
  });
  if (op === 'writes') expect(res.ok(), `grant ${privileges} on ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** anna's first calls 401 while her token hydrates, which bounces the route —
 *  reload until the namespace page is actually up. */
async function annaOpenNamespace(p: Page, wh: string, ns: string) {
  for (let i = 0; i < 3; i++) {
    try {
      await openWarehouse(p, wh);
      await openNamespace(p, ns);
      return;
    } catch {
      await p.reload().catch(() => {});
      await p.waitForLoadState('networkidle').catch(() => {});
    }
  }
  await openWarehouse(p, wh);
  await openNamespace(p, ns);
}

// Not project-isolated, for the same reason as access-control.spec.ts: in a
// brand-new project anna is denied get_metadata at the PROJECT level, so she
// cannot reach the namespace however much is granted on it. Isolation comes from
// a per-browser warehouse and a tag name unique to the attempt, and every grant
// made here is revoked in afterEach — a warehouse `describe` makes the whole
// project visible to her (visible_below), which would break access-control's
// "before any grant" assertion if it were left behind.
test.describe('tag rights — apply @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] }, isolatedProject: false });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS[0];
  let seeded: { warehouseId: string; nsId: string; tagId: string; tagName: string; annaId: string } | null = null;

  test.afterEach(async ({ bootstrappedPage: page }) => {
    if (!seeded) return;
    const { warehouseId, nsId, tagId, tagName, annaId } = seeded;
    seeded = null;
    try {
      await api(page, 'DELETE', `/management/v1/warehouse/${warehouseId}/namespace/${nsId}/tags/${encodeURIComponent(tagName)}`);
      await grants(page, `/management/v1/tag-definition/${tagId}/grants`, 'deletes', annaId, ['apply']);
      await grants(page, `/management/v1/warehouse/${warehouseId}/namespace/${nsId}/grants`, 'deletes', annaId, ['describe', 'manage_tags']);
      await grants(page, `/management/v1/warehouse/${warehouseId}/grants`, 'deletes', annaId, ['describe']);
      await api(page, 'DELETE', `/management/v1/tag-definition/${tagId}`);
    } catch {
      /* cleanup must never fail the test it cleans up after */
    }
  });

  test('anna is offered a tag only once she holds apply on it', async ({ bootstrappedPage: page, browser, browserName }) => {
    test.setTimeout(300000);

    // Lakekeeper only knows a user after her first login.
    const regCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    await login(await regCtx.newPage(), TEST_USER_2);
    await regCtx.close();

    const { wh, ns } = await seedWarehouseWithNamespace(page, backend, 'tag_rights_ns', `tagrights${browserName}`);
    await openWarehouse(page, wh);
    const warehouseId = page.url().match(/\/ui\/warehouse\/([^/?#]+)/)?.[1] || '';
    expect(warehouseId, 'could not read the warehouse id from the route').not.toBe('');
    const nsId = await namespaceIdOf(page, warehouseId, ns);
    const annaId = await userIdOf(page, TEST_USER_2.username);

    // A name unique to the attempt: a grant on it can never pre-exist.
    const tagName = `e2e.rights.${Date.now().toString(36)}`;
    const created = await api(page, 'POST', '/management/v1/tag-definition', {
      name: tagName,
      description: 'tag-rights spec',
      'value-kind': 'marker',
      scope: ['namespace'],
      'allowed-values': null,
    });
    expect(created.ok(), `create tag ${tagName}: ${created.status()} ${await created.text()}`).toBeTruthy();
    const tagId: string = (await created.json())?.id ?? '';
    expect(tagId, 'tag create returned no id').not.toBe('');
    seeded = { warehouseId, nsId, tagId, tagName, annaId };

    await test.step('peter grants anna describe + manage_tags (but not apply on the tag)', async () => {
      // Grants do not inherit: the warehouse must be describable for her to
      // reach the namespace at all, and manage_tags is what shows "Add".
      await grants(page, `/management/v1/warehouse/${warehouseId}/grants`, 'writes', annaId, ['describe']);
      await grants(page, `/management/v1/warehouse/${warehouseId}/namespace/${nsId}/grants`, 'writes', annaId, ['describe', 'manage_tags']);
    });

    // Put anna in the project peter's app is working in, rather than whichever
    // project her own app would pick first.
    const shared = await selectedProject(page);
    const annaCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    await applyProject(annaCtx, shared.id, shared.name);
    const anna = await annaCtx.newPage();
    try {
      await login(anna, TEST_USER_2);

      await test.step('anna sees "Add" but is not offered the tag', async () => {
        await annaOpenNamespace(anna, wh, ns);
        await waitForTagsSection(anna, { requireAdd: true });
        const menu = await openTagAddMenu(anna);
        // Either the list without it, or "None of the N tags … allowed to apply".
        expect(await pickerOffers(anna, menu, tagName), `${tagName} must not be offered before apply`).toBeFalsy();
        await closeTagMenu(anna, menu);
      });

      await test.step('peter grants apply on the tag from its Grants tab', async () => {
        await page.goto(`/ui/governance/tags/${tagId}`);
        await page.waitForLoadState('domcontentloaded');
        await recoverFromOffline(page);
        await expect(page.getByRole('tab', { name: 'Grants' })).toBeVisible({ timeout: 20000 });
        await grantOnCurrentPanel(page, TEST_USER_2.username, ['apply']);
      });

      await test.step('anna is now offered the tag, and applying it works', async () => {
        // A fresh load: per-tag answers are cached in memory for a minute.
        await annaOpenNamespace(anna, wh, ns);
        const menu = await openTagAddMenu(anna);
        expect(await pickerOffers(anna, menu, tagName), `${tagName} must be offered after apply`).toBeTruthy();
        await closeTagMenu(anna, menu);
        await applyEntityTag(anna, { tagName });
        await expect(tagChip(tagsSection(anna), tagName)).toBeVisible({ timeout: 15000 });
      });

      await test.step('apply lets her read the tag, not its grants or attachments', async () => {
        await anna.goto(`/ui/governance/tags/${tagId}`);
        await anna.waitForLoadState('domcontentloaded');
        await recoverFromOffline(anna);
        // can_read includes `apply`: the definition loads, no read refusal.
        await expect(anna.getByText('marker', { exact: true }).first()).toBeVisible({ timeout: 20000 });
        await expect(anna.getByText(/not allowed to read (this tag|its definition)/)).toHaveCount(0);
        await selectTab(anna, /^grants$/i);
        await expect(anna.getByText('You are not allowed to see the grants on this tag.')).toBeVisible({ timeout: 15000 });
        await selectTab(anna, /^attachments$/i);
        await expect(anna.getByText('You are not allowed to see where this tag is applied.')).toBeVisible({ timeout: 15000 });
      });
    } finally {
      await annaCtx.close();
    }
  });
});

// The read refusal needs a reader who cannot even LIST the vocabulary: in the
// shared project any warehouse grant makes anna a project reader
// (can_list_tags ⇒ can_read every definition). A per-test project where she
// holds nothing is exactly that, so this block keeps the default isolation and
// joins her context to it.
test.describe('tag rights — unreadable tag @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('anna without read on a tag sees the refusals on every tab', async ({ bootstrappedPage: page, browser, project }) => {
    test.setTimeout(180000);
    const [tagName] = await seedTagDefinitions(page, 1, 'e2e.unreadable', ['namespace']);
    await openTagDefinition(page, tagName);
    const tagId = tagDefinitionIdFromUrl(page);
    expect(tagId, 'could not read the tag id from the route').not.toBe('');

    const annaCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    await applyProject(annaCtx, project.id, project.name);
    const anna = await annaCtx.newPage();
    try {
      await login(anna, TEST_USER_2);
      await anna.goto(`/ui/governance/tags/${tagId}`);
      await anna.waitForLoadState('domcontentloaded');
      await recoverFromOffline(anna);

      // "You can see that this tag exists, but … its allowed values are hidden."
      // when she may list but not read; "You are not allowed to read this tag."
      // when she may not even list — which is the case in a project she has no
      // grant in. Either is the refusal; a blank page or a spinner is not.
      await expect(
        anna.getByText(/You are not allowed to read this tag\.|you are not allowed to read its definition/),
      ).toBeVisible({ timeout: 20000 });

      await selectTab(anna, /^grants$/i);
      await expect(anna.getByText('You are not allowed to see the grants on this tag.')).toBeVisible({ timeout: 15000 });
      // Always present now, even for a reader who cannot see into it.
      await selectTab(anna, /^attachments$/i);
      await expect(anna.getByText('You are not allowed to see where this tag is applied.')).toBeVisible({ timeout: 15000 });
    } finally {
      await annaCtx.close();
    }
  });
});
