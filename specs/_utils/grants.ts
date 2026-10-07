import { Browser, BrowserContext, Page, expect } from '@playwright/test';
import { login, TEST_USER_2 } from './auth';
import { authToken, pinProject } from './project';
import { recoverFromOffline } from './app';

/**
 * Catalog grants and the second user, for the Lakekeeper 0.14 rights specs.
 *
 * Under Cedar 0.14 grants are stored in the catalog and the predefined policies
 * turn them into permissions, so a spec can give anna exactly one privilege over
 * the API instead of rewriting the policy file (see `cedar.ts`, which predates
 * that). Grants live in the test's own project, so they need no cleanup.
 */

const API = () => process.env.LK_API_URL || 'http://localhost:8181';

// anna runs in a FRESH browser context, which does NOT inherit the config's
// baseURL — see perms/access-control.spec.ts.
export const ANNA_BASE_URL =
  process.env.SERVED_UI === '1' ? process.env.LK_UI_URL || 'http://localhost:8181' : 'http://localhost:3001';

/** peter's bearer token and the test's project, as the console sends them. */
export async function apiHeaders(page: Page, projectId?: string): Promise<Record<string, string>> {
  const token = await authToken(page);
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (projectId) h['x-project-id'] = projectId;
  return h;
}

/**
 * Whether the server speaks the Lakekeeper 0.14 policy contract: the stored
 * policy listing says whether the caller may write (`can-write`). Older Plus
 * images do not, and the specs that depend on it skip there.
 */
export async function isLk014Cedar(page: Page, projectId: string): Promise<boolean> {
  const res = await page.request.get(`${API()}/management/v1/permissions/cedar/project/policies`, {
    headers: await apiHeaders(page, projectId),
  });
  if (!res.ok()) return false;
  const body = await res.json().catch(() => ({}));
  return typeof body?.['can-write'] === 'boolean';
}

/** anna, logged in, in her own context, kept in the test's project. */
export async function annaIn(
  browser: Browser,
  project: { id: string; name: string },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: ANNA_BASE_URL });
  await pinProject(ctx, project.id, project.name);
  const page = await ctx.newPage();
  await login(page, TEST_USER_2);
  return { ctx, page };
}

/** Lakekeeper's id for a user who has signed in at least once. */
export async function userIdOf(page: Page, username: string): Promise<string> {
  const res = await page.request.get(`${API()}/management/v1/user`, {
    headers: await apiHeaders(page),
  });
  const users: any[] = res.ok() ? ((await res.json())?.users ?? []) : [];
  const needle = username.toLowerCase();
  const hit = users.find(
    (u) =>
      String(u.name || '').toLowerCase().includes(needle) ||
      String(u.email || '').toLowerCase().startsWith(needle),
  );
  if (!hit?.id) throw new Error(`no user matching "${username}" (has she signed in yet?)`);
  return hit.id;
}

/** A grants endpoint, by level. */
export type GrantTarget =
  | { type: 'server' }
  | { type: 'project' }
  | { type: 'warehouse'; warehouseId: string }
  | { type: 'tag-definition'; tagDefinitionId: string };

function grantsPath(t: GrantTarget): string {
  switch (t.type) {
    case 'server':
      return '/management/v1/server/grants';
    case 'project':
      return '/management/v1/project/grants';
    case 'warehouse':
      return `/management/v1/warehouse/${t.warehouseId}/grants`;
    case 'tag-definition':
      return `/management/v1/tag-definition/${t.tagDefinitionId}/grants`;
  }
}

/** Grant (or with `revoke`, take away) privileges from one user, as peter. */
export async function setUserGrants(
  page: Page,
  projectId: string,
  target: GrantTarget,
  userId: string,
  privileges: string[],
  revoke = false,
) {
  const entries = privileges.map((privilege) => ({ principal: { user: userId }, privilege }));
  const res = await page.request.post(`${API()}${grantsPath(target)}`, {
    headers: await apiHeaders(page, projectId),
    data: revoke ? { deletes: entries } : { writes: entries },
  });
  if (!res.ok()) {
    throw new Error(`${revoke ? 'revoke' : 'grant'} ${privileges} on ${target.type}: ${res.status()} ${await res.text()}`);
  }
}

/** The id of a warehouse in the test's project, by name. */
export async function warehouseIdOf(page: Page, projectId: string, name: string): Promise<string> {
  const res = await page.request.get(`${API()}/management/v1/warehouse`, {
    headers: await apiHeaders(page, projectId),
  });
  const list: any[] = res.ok() ? ((await res.json())?.warehouses ?? []) : [];
  const hit = list.find((w) => w.name === name);
  const id = hit?.id ?? hit?.['warehouse-id'];
  if (!id) throw new Error(`warehouse ${name} not found in project ${projectId}`);
  return id;
}

/** Create a marker tag definition for warehouses (or find it on a retry). */
export async function ensureWarehouseTag(page: Page, projectId: string, name: string): Promise<string> {
  const h = await apiHeaders(page, projectId);
  const res = await page.request.post(`${API()}/management/v1/tag-definition`, {
    headers: h,
    data: { name, scope: ['warehouse'], 'value-kind': 'marker' },
  });
  if (res.ok()) return (await res.json()).id;
  const list = await page.request.get(`${API()}/management/v1/tag-definition`, { headers: h });
  const defs: any[] = list.ok() ? ((await list.json())?.['tag-definitions'] ?? []) : [];
  const id = defs.find((d) => d.name === name)?.id;
  if (!id) throw new Error(`could not create tag ${name}: ${res.status()} ${await res.text()}`);
  return id;
}

/** Switch project-level predefined policies over the API, as peter. */
export async function setProjectPredefined(
  page: Page,
  projectId: string,
  changes: { id: string; enabled: boolean }[],
) {
  const res = await page.request.post(`${API()}/management/v1/permissions/cedar/project/predefined-policies`, {
    headers: await apiHeaders(page, projectId),
    data: { changes },
  });
  if (!res.ok()) throw new Error(`set predefined: ${res.status()} ${await res.text()}`);
}

/** Open Governance → Policies and wait for the rail. */
export async function gotoPolicies(page: Page) {
  await page.goto('/ui/governance?tab=policies');
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
  await expect(page.getByRole('tab', { name: 'Stored Policies' })).toBeVisible({ timeout: 30000 });
}

/** Click a rail tab until it is selected (Vuetify can reset it while loading). */
export async function openRailTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true }).first();
  for (let i = 0; i < 5; i++) {
    await tab.click({ timeout: 10000 }).catch(() => {});
    if ((await tab.getAttribute('aria-selected')) === 'true') return;
    await page.waitForTimeout(500);
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
