import { expect, Page } from '@playwright/test';

/**
 * Per-test Lakekeeper PROJECT isolation.
 *
 * One backend is shared by every combo and every browser pass, and nothing is
 * reset between them — so a warehouse, a namespace or an OpenFGA grant left by
 * one test is still there for the next. That produced failures that looked like
 * browser differences (firefox "failing" tests chromium passed) but were really
 * run order: anna was already granted, and a warehouse had already had its
 * endpoint deliberately blocked.
 *
 * Warehouses, namespaces and grants all live INSIDE a project, and the console
 * scopes every request by `x-project-id`. So giving each test its own project
 * buys the same isolation as a fresh stack, for about a second instead of ~50.
 */

/** The bearer token the app stashed after login (empty in noauth mode). */
export async function authToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const store of [sessionStorage, localStorage])
      for (const k of Object.keys(store)) {
        try {
          const v = JSON.parse(store.getItem(k) || '');
          const t = v?.access_token ?? v?.user?.access_token;
          if (typeof t === 'string' && t.length > 20) return t;
        } catch {
          /* not a JSON entry */
        }
      }
    return '';
  });
}

/** A project name unique to this test AND this browser pass. */
export function projectNameFor(title: string, browser: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `e2e-${browser}-${slug}`.slice(0, 60);
}

/**
 * Create the project (idempotent — a retry of the same test reuses it, which is
 * what you want, while a DIFFERENT test never can) and select it in the UI.
 */
export async function useIsolatedProject(page: Page, name: string): Promise<void> {
  const api = process.env.LK_API_URL || 'http://localhost:8181';
  const token = await authToken(page);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await page.request.post(`${api}/management/v1/project`, {
    headers,
    data: { 'project-name': name },
  });
  // 409 = a retry of this same test reusing its own project, which is fine; a
  // DIFFERENT test can never collide because the name carries its title.
  let projectId = '';
  if (res.ok()) {
    projectId = (await res.json().catch(() => ({})))['project-id'] || '';
  } else if (res.status() !== 409) {
    throw new Error(`could not create project ${name}: ${res.status()} ${await res.text()}`);
  }

  if (!projectId) {
    const list = await page.request.get(`${api}/management/v1/project-list`, { headers });
    const projects = list.ok() ? ((await list.json())?.projects ?? []) : [];
    projectId = projects.find((p: any) => p['project-name'] === name)?.['project-id'] || '';
  }
  if (!projectId) throw new Error(`project ${name} exists but has no id`);

  await selectProject(page, projectId, name);
}

/**
 * Select the project by writing it into the app's persisted store.
 *
 * The app bar's picker is the same write, but reaching it costs a navigation,
 * a menu open and a list that only renders once projects have loaded — too slow
 * and too flaky to pay on EVERY test. `x-project-id` is taken straight from
 * this store value, so seeding it scopes every request the test makes.
 */
export async function selectProject(page: Page, projectId: string, name: string): Promise<void> {
  await page.addInitScript(
    ([id, projectName]) => {
      try {
        const raw = localStorage.getItem('visual');
        const state = raw ? JSON.parse(raw) : {};
        state.projectSelected = { 'project-id': id, 'project-name': projectName };
        localStorage.setItem('visual', JSON.stringify(state));
      } catch {
        /* storage unavailable — the test will fail on its own assertions */
      }
    },
    [projectId, name] as const,
  );
  await page.goto('/ui/');
  await page.waitForLoadState('domcontentloaded');
}
