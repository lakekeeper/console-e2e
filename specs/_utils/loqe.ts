import { Page, expect } from '@playwright/test';
import { recoverFromOffline } from './app';

// Helpers for driving the in-browser DuckDB-WASM SQL engine (LoQE). Shared by the
// loqe create+query test and the access-control (table-read) test.

/** Wait for the LoQE engine to report "Ready", then expand a warehouse in the tree
 *  so DuckDB ATTACHes its catalog. Asserts the namespace shows up (tree loaded). */
export async function openLoqeAndAttach(page: Page, wh: string, ns: string) {
  await page.goto('/ui/loqe');
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });
  await page.getByText(wh, { exact: true }).first().click();
  await expect(page.getByText(ns, { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(8000); // let the async ATTACH + credential vend settle
}

export interface LoqeResult {
  errored: boolean;
  errorText: string;
}

/** Run ONE SQL statement in the editor and wait for it to settle (the "Running
 *  query…" spinner disappears). Returns whether a Query Error alert is showing and
 *  its text. One statement at a time — multi-statement makes one result tab per
 *  statement and an error can hide under a non-active tab. */
export async function loqeExec(page: Page, sql: string): Promise<LoqeResult> {
  const editor = page.locator('.cm-content').first();
  const spinner = page.getByText('Running query…');
  const errorAlert = page.locator('.v-alert', { hasText: 'Query Error' });

  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await editor.fill(sql);
  await page.getByRole('button', { name: /^run( selection)?$/i }).first().click();
  await expect(spinner).toBeHidden({ timeout: 90000 });
  await page.waitForTimeout(500);

  const errored = await errorAlert.isVisible().catch(() => false);
  const errorText = errored ? (await errorAlert.innerText().catch(() => '')).trim() : '';
  return { errored, errorText };
}

export interface LoqeReadResult {
  warehouseVisible: boolean;
  errored: boolean;
  errorText: string;
  value: string;
}

/** Attempt to read a table via LoQE as the current user. Reloads up to `maxReloads`
 *  times until the warehouse appears in the tree — a restricted user's first calls
 *  401 during token hydration, then retry, so the tree populates a beat late. If the
 *  warehouse never appears (no grant) the SELECT is still run and will error
 *  ("Catalog does not exist"). Returns what happened (no assertions) so callers can
 *  assert denied vs allowed. */
export async function loqeReadTable(
  page: Page,
  wh: string,
  ns: string,
  tbl: string,
  maxReloads = 4,
): Promise<LoqeReadResult> {
  await page.goto('/ui/loqe');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });

  let warehouseVisible = false;
  for (let i = 0; i < maxReloads; i++) {
    warehouseVisible = await page.getByText(wh, { exact: true }).first().isVisible({ timeout: 12000 }).catch(() => false);
    if (warehouseVisible || i === maxReloads - 1) break;
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });
  }

  if (warehouseVisible) {
    await page.getByText(wh, { exact: true }).first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(8000); // attach + credential vend
  }

  const r = await loqeExec(page, `select a from "${wh}"."${ns}"."${tbl}";`);
  const value = r.errored
    ? ''
    : (await page.locator('.loqe-result-table').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  return { warehouseVisible, errored: r.errored, errorText: r.errorText, value };
}

/** Create a table via LoQE and assert it round-trips (read-back returns 1). Throws
 *  with the DuckDB error text on failure. Assumes the warehouse is already attached. */
export async function createTableViaLoqe(page: Page, wh: string, ns: string, tbl: string) {
  await loqeExec(page, `drop table if exists "${wh}"."${ns}"."${tbl}";`);
  const created = await loqeExec(page, `create table "${wh}"."${ns}"."${tbl}" as select 1 as a;`);
  if (created.errored) throw new Error(`LoQE create failed:\n${created.errorText}`);
  const read = await loqeExec(page, `select a from "${wh}"."${ns}"."${tbl}";`);
  if (read.errored) throw new Error(`LoQE read-back failed:\n${read.errorText}`);
  await expect(page.locator('.loqe-result-table').first()).toContainText('1', { timeout: 15000 });
}
