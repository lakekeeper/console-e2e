import { Page, expect } from '@playwright/test';
import { openWarehouse } from './warehouse';

// Grant a user a relation on a table via the console UI (PermissionAssignDialog),
// the same path an admin uses: navigate to the table → Permissions tab → grant →
// pick the user → check the relation → save. Used by the access-control test (FGA).
export async function grantTableRelation(
  page: Page,
  wh: string,
  ns: string,
  tbl: string,
  username: string,
  relation: string, // e.g. 'select'
) {
  await openWarehouse(page, wh); // /ui/warehouse/<id>
  await page.getByText(ns, { exact: true }).first().click();
  await page.waitForURL(/\/namespace\//, { timeout: 10000 }).catch(() => {});
  await page.getByText(tbl, { exact: true }).first().click();
  await page.waitForURL(/\/table\//, { timeout: 10000 }).catch(() => {});

  // The Permissions tab can reset to "details" while table data loads — click until
  // it sticks.
  const permTab = page.getByRole('tab', { name: /permissions/i });
  await page.waitForLoadState('networkidle').catch(() => {});
  for (let i = 0; i < 5; i++) {
    await permTab.click().catch(() => {});
    await page.waitForTimeout(1000);
    if ((await permTab.getAttribute('aria-selected')) === 'true') break;
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  // Grant dialog → user tab → search → pick → check relation → save. The Vuetify
  // dialog + autocomplete is the firefox-flaky spot (the search result or the
  // relation checkbox occasionally never settles). Retry the whole dialog a few
  // times — close + reopen — so a stuck attempt recovers in seconds rather than
  // hanging out the test timeout (clicks are also capped by config actionTimeout).
  const userRow = page.getByRole('row', { name: new RegExp(username, 'i') }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.getByRole('button', { name: /^grant$/i }).first().click({ timeout: 10000 });
      await page.getByRole('tab', { name: /user/i }).first().click({ timeout: 5000 }).catch(() => {});
      const combo = page.getByRole('combobox').last();
      await combo.fill(username, { timeout: 8000 });
      const option = page.getByRole('option', { name: new RegExp(username, 'i') }).first();
      await option.click({ timeout: 8000 }); // waits for the search result to appear
      const cb = page.getByRole('checkbox', { name: relation });
      await cb.check({ timeout: 8000 });
      const save = page.getByRole('button', { name: /^save$/i });
      // save is disabled if the grant already exists (idempotent re-runs) — fine.
      if (await save.isEnabled().catch(() => false)) await save.click({ timeout: 8000 });
      await page.keyboard.press('Escape').catch(() => {});
      // Confirm the user now appears in the assignment table.
      await expect(userRow).toBeVisible({ timeout: 8000 });
      return;
    } catch {
      // Close any open dialog and retry the whole flow.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
      if (await userRow.isVisible({ timeout: 2000 }).catch(() => false)) return; // already granted
    }
  }
  // Final assertion (surfaces a clear failure if all attempts fell through).
  await expect(userRow).toBeVisible({ timeout: 8000 });
}
