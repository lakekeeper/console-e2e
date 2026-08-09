import { Page, expect } from '@playwright/test';
import { recoverFromOffline } from './app';

export type TagScope = 'warehouse' | 'namespace' | 'table' | 'view' | 'generic-table' | 'column';

const VALUE_KIND_LABEL: Record<'marker' | 'free-text' | 'enumerated', RegExp> = {
  marker: /^Marker/i,
  'free-text': /^Free text/i,
  enumerated: /^Enumerated/i,
};

/** Navigate to the project-scoped tag vocabulary (Governance → Tags, the default tab). */
export async function gotoTagDefinitions(page: Page) {
  await page.goto('/ui/governance');
  await page.waitForLoadState('domcontentloaded');
  // Auth-hydration race (see _utils/app.ts): the router guard's getServerInfo()
  // call can fire before the token lands, bouncing to /ui/server-offline.
  await recoverFromOffline(page);
  await expect(page.getByRole('tab', { name: 'Tags' })).toBeVisible({ timeout: 10000 });
}

/** Open a closed Vuetify v-select. A plain click on the label-associated <input>
 *  is unreliable here: Playwright's hit-test finds a sibling `.v-field__input`
 *  div "intercepting" it, and forcing the click through fires on the wrong
 *  target and can dismiss the enclosing dialog instead of opening the menu.
 *  Focus + Enter (standard combobox a11y behavior) opens it reliably instead.
 *  `.last()` — the New Tag dialog's field is teleported to the end of <body>,
 *  so it's the last match when the same label also exists in a background
 *  filter rail (e.g. TagDefinitionManager's own "Scope"/"Kind" filters). */
async function openSelect(page: Page, label: string) {
  await page.getByLabel(label, { exact: true }).last().focus();
  await page.keyboard.press('Enter');
}

/** Select one or more options in an already-open Vuetify select/multi-select menu,
 *  then close the menu. Uses exact match so e.g. "Table" doesn't hit "Generic table". */
async function pickOptions(page: Page, labels: string[]) {
  for (const label of labels) {
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await page.keyboard.press('Escape');
}

/** Create a tag definition (idempotent: reuses it if it's already in the list).
 *  Returns the tag name. `scope` defaults to warehouse+namespace+table+view so the
 *  same definition can be exercised at every entity level. */
export async function createTagDefinition(
  page: Page,
  opts: {
    name: string;
    valueKind?: 'marker' | 'free-text' | 'enumerated';
    scope?: string[];
    allowedValues?: string[];
    description?: string;
  },
) {
  const { name, valueKind = 'marker', scope = ['Warehouse', 'Namespace', 'Table', 'View'] } = opts;
  await gotoTagDefinitions(page);

  if (await page.getByText(name, { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false)) {
    return name;
  }

  await page.getByRole('button', { name: 'New Tag', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (opts.description) {
    await page.getByLabel('Description', { exact: true }).fill(opts.description);
  }

  await openSelect(page, 'Value kind');
  await page.getByRole('option', { name: VALUE_KIND_LABEL[valueKind] }).click();

  await openSelect(page, 'Scope');
  await pickOptions(page, scope);

  if (valueKind === 'enumerated' && opts.allowedValues?.length) {
    const combo = page.getByLabel(/Allowed values/i);
    for (const v of opts.allowedValues) {
      await combo.fill(v);
      await page.keyboard.press('Enter');
    }
  }

  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 10000 });
  return name;
}

/** Open a tag definition's detail page (`/governance/tags/:id`) by clicking its row. */
export async function openTagDefinition(page: Page, name: string) {
  await gotoTagDefinitions(page);
  const row = page.getByRole('row', { name: new RegExp(name) }).first();
  await row.getByText(name, { exact: true }).click();
  await expect(page).toHaveURL(/\/governance\/tags\/[^/]+/, { timeout: 10000 });
}

/** Open the cog "Manage tags" action for the entity currently on screen (warehouse,
 *  namespace, or table detail page — table's dialog is tabbed but defaults to the
 *  "Table tags" tab, which is the same underlying panel). Assumes exactly one cog
 *  actions-menu button is visible. */
export async function openManageTagsMenu(page: Page) {
  // Just after navigating in, the actions-menu button exists but its v-menu
  // activator isn't wired up yet — a click here opens nothing. Let the page
  // settle first (same class of race as the tab-switch/permission checks).
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator('button:has(.mdi-cog)').first().click();
  await page.getByText('Manage tags', { exact: true }).click();

  // The resulting dialog's own fade-in transition briefly leaves its scrim
  // overlay intercepting clicks on elements inside it. The scrim only carries
  // a detectable "entering" class for the duration of the transition itself,
  // so waiting for that class to disappear is racy — a flat settle wait is
  // more reliable here (same pragmatic tradeoff as the cog-menu wait above).
  await page.waitForTimeout(1000);
}

/** Locate the open "Manage tags" dialog specifically. The cog's v-menu can
 *  linger open behind/beside it (a Vuetify nested-overlay quirk — clicking a
 *  menu item that itself opens a dialog doesn't reliably close the menu), so
 *  an unscoped page-wide search for row action buttons can hit the stray menu
 *  instead of the dialog. Scoping to this container sidesteps that entirely. */
function manageTagsDialog(page: Page) {
  return page.locator('.v-overlay__content').filter({ hasText: 'Manage tags' }).last();
}

/** Remove a direct (non-inherited) tag row from the open "Manage tags" dialog,
 *  via its delete icon + type-to-confirm flow, then close the dialog. Only the
 *  delete-icon lookup is scoped to the dialog + row (it has no text, so an
 *  unscoped page-wide match risks the stray menu above); the confirm sub-
 *  dialog's own fields are unambiguous by text, no scoping needed. */
export async function removeEntityTag(page: Page, tagName: string) {
  const dialog = manageTagsDialog(page);
  await dialog.getByRole('row', { name: new RegExp(tagName) }).locator('button:has(.mdi-delete-outline)').click();
  await page.getByLabel(/Type/, { exact: false }).fill(tagName);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.keyboard.press('Escape');
  // Let the dialog's closing (fade-out) transition finish — its scrim
  // overlay otherwise lingers and intercepts clicks on the next page.
  await page.locator('.v-overlay__scrim').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/** Open the "Manage tags" dialog and apply a tag with an optional value. */
export async function applyEntityTag(page: Page, opts: { tagName: string; value?: string }) {
  await openManageTagsMenu(page);

  await page.getByRole('button', { name: 'Apply tag', exact: true }).click();
  const tagField = page.getByLabel('Tag', { exact: true });
  await tagField.focus();
  await tagField.fill(opts.tagName);
  await page.getByRole('option', { name: opts.tagName, exact: true }).click();

  if (opts.value) {
    await page.getByLabel('Value', { exact: true }).fill(opts.value);
  }
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.getByText(opts.tagName, { exact: true }).first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
}
