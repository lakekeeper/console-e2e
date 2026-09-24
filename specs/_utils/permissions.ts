import { Page, Locator, expect } from '@playwright/test';
import { openWarehouse, openNamespace, selectTab } from './warehouse';

// Granting moved. `PERMISSIONS_UI_ENABLED` is false in console-components 0.23:
// the per-entity "Permissions" tabs and PermissionAssignDialog are hidden ahead
// of removal, and the authorizer-agnostic **Grants** tab replaces them. The shape
// is similar (a row per principal, a dialog to edit) but the wiring is different:
//   • the tab is "Grants", not "Permissions"
//   • the principal picker is PrincipalSearch (User/Role toggle + autocomplete)
//   • the vocabulary is server-published privileges, not fixed FGA relations
//   • the action is Save on GrantAssignDialog, which applies one atomic write
//
// Grants do NOT inherit. Where an FGA relation on a table used to cascade the
// ancestor describe/list, a grant is held exactly where it is made — so a caller
// that wants a readable table has to say so at every level it needs.

/** Click a v-tab until it actually sticks. Vuetify resets the model back to the
 *  first tab while the page's data is still loading, so a single click is lost
 *  more often than not on the heavier detail pages. */
/** The open GrantAssignDialog ("Grant privileges" / "Edit grants"). */
function grantDialog(page: Page) {
  return page
    .locator('.v-overlay__content')
    .filter({ hasText: /Grant privileges|Edit grants/ })
    .last();
}

/** Tick a privilege by its published name. The checkbox label is the server's
 *  `display-name` when it has one, so match the bare name first and fall back to
 *  a contains match rather than pinning to one authorizer's spelling. */
async function checkPrivilege(dialog: Locator, privilege: string) {
  const exact = dialog.getByRole('checkbox', { name: new RegExp(`^${privilege}$`, 'i') }).first();
  const loose = dialog.getByRole('checkbox', { name: new RegExp(privilege, 'i') }).first();
  const target = (await exact.count().catch(() => 0)) ? exact : loose;
  await target.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await target.isChecked().catch(() => false))) await target.check({ timeout: 8000 });
}

/**
 * Grant a principal one or more privileges on whatever resource's Grants panel is
 * currently on screen. Returns once the principal shows up in the grants table.
 *
 * The Vuetify autocomplete is the flaky spot (a search result that never settles),
 * so the whole dialog is retried — close and reopen — rather than waiting out the
 * test timeout on one stuck attempt.
 */
export async function grantOnCurrentPanel(
  page: Page,
  username: string,
  privileges: string[],
) {
  const principalRow = page.getByRole('row', { name: new RegExp(username, 'i') }).first();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.getByRole('button', { name: /^grant$/i }).first().click({ timeout: 10000 });
      const dialog = grantDialog(page);
      await expect(dialog).toBeVisible({ timeout: 10000 });

      // PrincipalSearch: User is the default side of the toggle; assert it anyway
      // so a role-first default in some host can't silently search the wrong set.
      await dialog.getByRole('button', { name: /^user$/i }).first().click({ timeout: 5000 }).catch(() => {});

      const combo = dialog.getByRole('combobox').last();
      await combo.fill(username, { timeout: 8000 });
      const option = page.getByRole('option', { name: new RegExp(username, 'i') }).first();
      await option.waitFor({ state: 'visible', timeout: 10000 });
      await option.click({ timeout: 8000 });

      for (const privilege of privileges) await checkPrivilege(dialog, privilege);

      const save = dialog.getByRole('button', { name: /^save$/i });
      // Save stays disabled when nothing changed (idempotent re-runs) — that is a
      // pass, not a failure: the grant is already in place.
      if (await save.isEnabled().catch(() => false)) await save.click({ timeout: 10000 });
      await expect(dialog).toBeHidden({ timeout: 15000 }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});

      await expect(principalRow).toBeVisible({ timeout: 10000 });
      return;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
      if (await principalRow.isVisible({ timeout: 2000 }).catch(() => false)) return; // already granted
    }
  }
  // Final assertion (surfaces a clear failure if all attempts fell through).
  await expect(principalRow).toBeVisible({ timeout: 8000 });
}

/**
 * Grant a user read access to one table, the way an admin does it in the UI.
 *
 * Grants are held per resource and do not inherit, so reading a table needs the
 * chain: the warehouse must be listable, the namespace describable, the table
 * selectable. The FGA-era shortcut (one table `select`, ancestors cascaded) is
 * gone with the permissions UI.
 */
export async function grantTableRead(
  page: Page,
  wh: string,
  ns: string,
  tbl: string,
  username: string,
) {
  // 1 · warehouse level — without it the warehouse is invisible in the nav/LoQE tree.
  await openWarehouse(page, wh);
  await selectTab(page, /^grants$/i);
  await grantOnCurrentPanel(page, username, ['describe']);

  // 2 · namespace level.
  await openWarehouse(page, wh);
  await openNamespace(page, ns);
  await selectTab(page, /^grants$/i);
  await grantOnCurrentPanel(page, username, ['describe']);

  // 3 · table level — the actual data read.
  await page.getByText(tbl, { exact: true }).first().click();
  await page.waitForURL(/\/table\//, { timeout: 10000 }).catch(() => {});
  await selectTab(page, /^grants$/i);
  await grantOnCurrentPanel(page, username, ['select']);
}
