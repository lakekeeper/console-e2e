import { APIResponse, Page } from '@playwright/test';
import { authToken, currentProject } from './project';

/**
 * BULK seeding over the API, for the specs whose subject is what the UI does at
 * scale (see flows/large-lists.spec.ts).
 *
 * Everything here has a UI helper equivalent in `warehouse.ts` / `tags.ts`, and
 * those stay the right tool for a journey — they are what proves the dialogs
 * work. But driving 200 dialogs takes tens of minutes and re-tests one code
 * path 200 times; the list pages only care that the rows EXIST. So these go
 * straight at the server with the page's own bearer token and project.
 *
 * Every call is idempotent (409 = a retry of the same test reusing its seed),
 * and they run in small concurrent batches — serial 200s are needlessly slow,
 * unbounded ones swamp a single-node dev stack.
 */

const API = () => process.env.LK_API_URL || 'http://localhost:8181';
const BATCH = 20;

/** Run `fn` over `items`, `BATCH` at a time. Returns the results in order. */
async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  }
  return out;
}

/** Auth + project headers, matching what the console itself sends. */
async function headers(page: Page, scoped = true): Promise<Record<string, string>> {
  const token = await authToken(page);
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  // The management API is project-scoped by this header; the catalog API is
  // scoped by the warehouse id in its path and does not take it.
  if (scoped && currentProject().id) h['x-project-id'] = currentProject().id;
  return h;
}

function fail(what: string, res: APIResponse, body: string): never {
  throw new Error(`seed: ${what} failed ${res.status()} ${body.slice(0, 300)}`);
}

/** Zero-padded so the table's default name sort matches the seed order. */
export const seededName = (prefix: string, i: number, sep = '-') => `${prefix}${sep}${String(i).padStart(3, '0')}`;

export type SeededNamespace = { name: string; id: string };

/**
 * Create `count` namespaces in a warehouse and return them with their ids.
 *
 * The create response carries `properties.namespace_id`, but only on a fresh
 * create — a 409 (this test retried) has to look the id up, and grants need it.
 */
export async function seedNamespaces(
  page: Page,
  warehouseId: string,
  count: number,
  prefix = 'ns',
): Promise<SeededNamespace[]> {
  const base = `${API()}/catalog/v1/${warehouseId}/namespaces`;
  const h = await headers(page, false);

  return inBatches(
    Array.from({ length: count }, (_, i) => seededName(prefix, i + 1)),
    async (name) => {
      const res = await page.request.post(base, { headers: h, data: { namespace: [name] } });
      let id = '';
      if (res.ok()) {
        id = (await res.json().catch(() => ({})))?.properties?.namespace_id || '';
      } else if (res.status() !== 409) {
        fail(`create namespace ${name}`, res, await res.text());
      }
      if (!id) {
        const got = await page.request.get(`${base}/${encodeURIComponent(name)}`, { headers: h });
        if (!got.ok()) fail(`read namespace ${name}`, got, await got.text());
        id = (await got.json())?.properties?.namespace_id || '';
        if (!id) throw new Error(`seed: namespace ${name} exists but has no namespace_id`);
      }
      return { name, id };
    },
  );
}

/**
 * Lakekeeper only knows a user once they have authenticated at least once, so
 * the caller has to have logged them in (a throwaway context is enough) before
 * this can find them — the search returns nothing for a name it has never seen.
 */
export async function findUserId(page: Page, username: string): Promise<string> {
  const res = await page.request.get(`${API()}/management/v1/user?search=${encodeURIComponent(username)}`, {
    headers: await headers(page),
  });
  if (!res.ok()) fail(`search user ${username}`, res, await res.text());
  const users: any[] = (await res.json())?.users ?? [];
  const needle = username.toLowerCase();
  const hit = users.find(
    (u) => String(u.name || '').toLowerCase().includes(needle) || String(u.email || '').toLowerCase().startsWith(needle),
  );
  if (!hit?.id) throw new Error(`seed: no user matching "${username}" (has she logged in yet?)`);
  return hit.id;
}

/** Grant one user the same privileges on every given namespace. */
export async function grantNamespaces(
  page: Page,
  warehouseId: string,
  namespaces: SeededNamespace[],
  userId: string,
  privileges: string[] = ['select'],
) {
  const h = await headers(page);
  await inBatches(namespaces, async (ns) => {
    const res = await page.request.post(
      `${API()}/management/v1/warehouse/${warehouseId}/namespace/${ns.id}/grants`,
      {
        headers: h,
        data: { writes: privileges.map((privilege) => ({ principal: { user: userId }, privilege })) },
      },
    );
    if (!res.ok()) fail(`grant on ${ns.name}`, res, await res.text());
  });
}

/** Create `count` marker tag definitions in the test's project. Returns the names. */
export async function seedTagDefinitions(
  page: Page,
  count: number,
  prefix = 'e2e.scale',
  scope = ['warehouse', 'namespace', 'table', 'view', 'generic-table', 'column'],
): Promise<string[]> {
  const h = await headers(page);
  return inBatches(
    Array.from({ length: count }, (_, i) => seededName(prefix, i + 1, '.')),
    async (name) => {
      const res = await page.request.post(`${API()}/management/v1/tag-definition`, {
        headers: h,
        data: {
          name,
          description: `seeded by the large-lists spec (${name})`,
          'value-kind': 'marker',
          scope,
          'allowed-values': null,
        },
      });
      // 409: this test retried and its project already holds the vocabulary.
      if (!res.ok() && res.status() !== 409) fail(`create tag ${name}`, res, await res.text());
      return name;
    },
  );
}
