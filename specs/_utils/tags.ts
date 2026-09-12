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

/** Tick the tag definition's scopes. Scope stopped being a v-select in 0.23 — the
 *  six options are all on screen as checkboxes, so there is no menu to open. */
async function pickScopes(page: Page, dialog: ReturnType<Page['locator']>, scopes: string[]) {
  for (const scope of scopes) {
    const cb = dialog.getByRole('checkbox', { name: scope, exact: true });
    await cb.check().catch(() => cb.click().catch(() => {}));
  }
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
  const dialog = page.locator('.v-overlay__content').filter({ hasText: 'New Tag Definition' }).last();
  await expect(dialog).toBeVisible({ timeout: 10000 });

  await dialog.getByLabel('Name', { exact: true }).fill(name);
  if (opts.description) {
    await dialog.getByLabel('Description', { exact: true }).fill(opts.description);
  }

  await openSelect(page, 'Value kind');
  await page.getByRole('option', { name: VALUE_KIND_LABEL[valueKind] }).click();

  await pickScopes(page, dialog, scope);

  if (valueKind === 'enumerated' && opts.allowedValues?.length) {
    const combo = dialog.getByLabel(/Allowed values/i);
    for (const v of opts.allowedValues) {
      await combo.fill(v);
      await page.keyboard.press('Enter');
    }
  }

  await dialog.getByRole('button', { name: /^save$/i }).click();
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

/** Locate the open "Manage tags" dialog. It is fullscreen since 0.23 (toolbar,
 *  a two-column panel, Close), but the cog's v-menu can still linger open beside
 *  it — a Vuetify nested-overlay quirk — so every lookup stays scoped here rather
 *  than searching the page and hitting the stray menu. */
function manageTagsDialog(page: Page) {
  return page.locator('.v-overlay__content').filter({ hasText: 'Manage tags' }).last();
}

/** A tag row in the dialog's right column ("ASSIGNED"). The component marks each
 *  card `tag-row--direct` or `tag-row--inherited`; matching on `.v-card` instead
 *  also catches the dialog's own card (and with it the toolbar's close button). */
function assignedTagRow(page: Page, tagName: string) {
  return manageTagsDialog(page).locator('.tag-row--direct').filter({ hasText: tagName }).first();
}

/** The definitions offered in the dialog's left column ("AVAILABLE TAGS").
 *  Scoping by the column heading is brittle — the heading's own <div> carries
 *  the text but none of the rows. The two columns are different element kinds
 *  instead: available tags are v-list items, assigned tags are v-cards. */
function availableTagRows(page: Page) {
  return manageTagsDialog(page).getByRole('listitem');
}

/** Close the fullscreen "Manage tags" dialog and wait for its scrim to clear —
 *  a lingering overlay intercepts clicks on the page underneath. */
async function closeManageTags(page: Page) {
  const dialog = manageTagsDialog(page);
  const close = dialog.getByRole('button', { name: /^close$/i }).last();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.locator('.v-overlay__scrim').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/** Remove a direct (non-inherited) tag from the open "Manage tags" dialog, then
 *  close it. There is no type-to-confirm step any more: the ASSIGNED column's
 *  row carries a red close button that unassigns immediately ("Changes apply
 *  immediately", per the dialog's own footer). */
export async function removeEntityTag(page: Page, tagName: string) {
  // The assigned row is a v-card, not a table row — match the card holding the
  // tag name and click its (only) destructive icon button.
  const row = assignedTagRow(page, tagName);
  await expect(row).toBeVisible({ timeout: 15000 });
  // The row's own (red) close button unassigns. The dialog toolbar has an
  // mdi-close too, which is why this is scoped to the row and not the dialog.
  await row.locator('button:has(.mdi-close)').last().click();
  // The panel reloads its lists after the write; the name must be gone from the
  // ASSIGNED column before the dialog is closed, or a later re-open races it.
  await expect(row).toBeHidden({ timeout: 15000 });
  await closeManageTags(page);
}

/** Open the "Manage tags" dialog and apply a tag, optionally with a value.
 *
 *  The panel is two columns now: clicking a definition in AVAILABLE TAGS applies
 *  a MARKER straight away; a free-text / enumerated tag expands an inline value
 *  editor under the row instead (text field + Assign, or a chip per allowed
 *  value). There is no "Apply tag" button and no Save — writes land on click. */
export async function applyEntityTag(page: Page, opts: { tagName: string; value?: string }) {
  await openManageTagsMenu(page);

  const dialog = manageTagsDialog(page);
  const assignedCard = assignedTagRow(page, opts.tagName);

  // The available column defaults to "Not assigned", so a tag already applied to
  // this entity is filtered out of it. Combos share backend state and these
  // helpers are idempotent, so widen to "All" before looking for the definition.
  await dialog.getByRole('button', { name: 'All', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(500);

  const definitionRow = availableTagRows(page).filter({ hasText: opts.tagName }).first();
  await expect(definitionRow).toBeVisible({ timeout: 15000 });

  // Clicking a MARKER that is already assigned UNASSIGNS it (the row is a toggle),
  // so an idempotent apply has to check first. A valued tag re-opens its editor
  // instead, which is safe to redo.
  const alreadyAssigned = await assignedCard.isVisible({ timeout: 2000 }).catch(() => false);
  if (alreadyAssigned && !opts.value) {
    await closeManageTags(page);
    return;
  }

  await definitionRow.click();

  if (opts.value) {
    // Free text: the inline editor's field has no label, only a "Value"
    // placeholder. Enumerated: the allowed values render as clickable chips.
    const valueField = dialog.getByPlaceholder('Value').filter({ visible: true }).first();
    if (await valueField.isVisible({ timeout: 5000 }).catch(() => false)) {
      await valueField.fill(opts.value);
      await dialog.getByRole('button', { name: /^(assign|update)$/i }).first().click();
    } else {
      await dialog.getByRole('button', { name: opts.value, exact: true }).first().click();
    }
  }

  // The write is confirmed by the tag turning up in the ASSIGNED column.
  await expect(assignedCard).toBeVisible({ timeout: 15000 });
  await closeManageTags(page);
}
