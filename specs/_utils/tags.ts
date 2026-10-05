import { Page, Locator, expect } from '@playwright/test';
import { recoverFromOffline } from './app';
import { selectTab } from './warehouse';

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


/** The tag definition id of the detail page on screen (`/governance/tags/:id`). */
export function tagDefinitionIdFromUrl(page: Page): string {
  return page.url().match(/\/governance\/tags\/([^/?#]+)/)?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// Inline tag editing (console-components ≥ inline-tags-and-properties).
//
// The "Manage tags" dialog and its Settings-menu entry are gone. Every Details
// tab now renders EntityTagsChips: a "TAGS <n>" heading with an "Add" text
// button (TagAddMenu → TagPickerList in a v-menu), and the applied tags grouped
// into Labels / Values / Inherited. A direct chip carries a ✕ (aria-label
// "Remove <name>", shown on hover) that asks "Remove <name>?" in place; a
// valued chip opens its value editor on click. Writes land immediately.
//
// Selectors lean on the component's own class names (.etc, .tag-chip,
// .etc-group) where there is no role to hang them on: a chip is not a button,
// and the groups are plain divs.
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`);

/** Select the Details tab of a warehouse / namespace / table / view page. The
 *  warehouse page opens on "namespaces" and the namespace page on its child
 *  list, and the tag chips only render on Details. Click-until-selected (the
 *  Vuetify tab model resets while the page loads). No-op if there is no such
 *  tab (e.g. already inside a details-only view). */
export async function selectDetailsTab(page: Page) {
  await selectTab(page, /^details$/i);
}

/** The EntityTagsChips block on screen. `.filter({visible})` because every tab
 *  pane stays mounted (v-show), and a hidden pane's block would match first. */
export function tagsSection(page: Page): Locator {
  return page.locator('.etc').filter({ visible: true }).first();
}

/** An applied tag chip with exactly this name, inside `scope`. */
export function tagChip(scope: Locator, name: string, kind: 'direct' | 'inherited' | 'any' = 'direct'): Locator {
  const cls =
    kind === 'direct'
      ? '.tag-chip:not(.tag-chip--inherited)'
      : kind === 'inherited'
        ? '.tag-chip.tag-chip--inherited'
        : '.tag-chip';
  return scope
    .locator(cls)
    .filter({ has: scope.page().locator('.tag-chip__name', { hasText: exact(name) }) })
    .first();
}

/** A tag group ("Labels", "Values", "Inherited") inside the tags section. */
export function tagGroup(section: Locator, label: 'Labels' | 'Values' | 'Inherited'): Locator {
  return section.locator('.etc-group').filter({
    has: section.page().locator('.etc-label', { hasText: new RegExp(`^\\s*${label}`) }),
  });
}

/** The full value text shown beside a valued chip in the "Values" group. */
export function tagValueText(section: Locator, name: string): Locator {
  return section
    .locator('.etc-pair__name')
    .filter({ has: section.page().locator('.tag-chip__name', { hasText: exact(name) }) })
    .locator('xpath=following-sibling::div[1]');
}

/** Wait until the tags section has answered: its Add control is up (the
 *  manage_tags check has returned) or, for a reader without it, the spinner is
 *  gone. `requireAdd` fails the wait if the Add control never shows. */
export async function waitForTagsSection(page: Page, opts: { requireAdd?: boolean } = {}) {
  await selectDetailsTab(page);
  const section = tagsSection(page);
  await expect(section, 'the Details tab has no tags section').toBeVisible({ timeout: 20000 });
  const add = section.getByRole('button', { name: /^add$/i }).first();
  if (opts.requireAdd ?? true) await expect(add, 'the tags "Add" control never appeared').toBeVisible({ timeout: 20000 });
  // Loading shows a lone spinner with no chips; let it go before reading chips.
  await section.locator('.v-progress-circular').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  return section;
}

/** The open tag picker menu (TagAddMenu or a chip's value editor). Identified by
 *  what only it says: the picker's footer, or one of the add menu's states that
 *  replace the list (none allowed / refused / still checking). */
export function tagPickerMenu(page: Page): Locator {
  return page
    .locator('.v-overlay__content')
    .filter({ visible: true })
    .filter({
      hasText:
        /Changes apply immediately\.|None of the \d+ tags that fit here|not allowed to list the tags|Checking which tags you may apply/,
    })
    .last();
}

/** Click a menu activator until its menu is actually on screen. Just after a
 *  navigation the button paints before its v-menu activator is wired, and that
 *  first click opens nothing (same race the old cog-menu helper slept around). */
async function openMenuVia(page: Page, trigger: Locator, menu: Locator, what: string) {
  await page.waitForLoadState('networkidle').catch(() => {});
  for (let i = 0; i < 5; i++) {
    if (await menu.isVisible().catch(() => false)) break;
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await menu.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }
  await expect(menu, `${what} never opened`).toBeVisible({ timeout: 5000 });
}

/** Wait out "Checking which tags you may apply…" — until every candidate's
 *  per-tag rights have answered, the list shows only what is known allowed. */
export async function waitForTagRights(menu: Locator) {
  await expect(menu.getByText('Checking which tags you may apply…')).toBeHidden({ timeout: 20000 });
}

/** Open the "Add" tag menu of the tags section on screen (Details tab). */
export async function openTagAddMenu(page: Page): Promise<Locator> {
  const section = await waitForTagsSection(page);
  const menu = tagPickerMenu(page);
  await openMenuVia(page, section.getByRole('button', { name: /^add$/i }).first(), menu, 'the tag Add menu');
  await waitForTagRights(menu);
  return menu;
}

/** A definition row in an open picker (whether enabled or locked). Narrows the
 *  list with the picker's search when it has one (it only shows over >1 row). */
export async function pickerItem(page: Page, menu: Locator, tagName: string): Promise<Locator> {
  const search = menu.getByPlaceholder('Filter tags', { exact: true });
  if (await search.isVisible().catch(() => false)) await search.fill(tagName);
  return menu
    .locator('.v-list-item')
    .filter({ has: page.locator('.v-list-item-title', { hasText: exact(tagName) }) })
    .first();
}

/** Whether the open picker offers this tag as applicable (listed AND not locked). */
export async function pickerOffers(page: Page, menu: Locator, tagName: string): Promise<boolean> {
  const item = await pickerItem(page, menu, tagName);
  if (!(await item.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  return !(await item.evaluate((el) => el.classList.contains('v-list-item--disabled')).catch(() => true));
}

/** Pick a tag in an open picker: a marker applies on click; a free-text tag
 *  expands a "Value" field + Assign; an enumerated one shows a chip per value. */
export async function pickTag(page: Page, menu: Locator, tagName: string, value?: string) {
  const item = await pickerItem(page, menu, tagName);
  await expect(item, `the picker does not list ${tagName}`).toBeVisible({ timeout: 15000 });
  await item.click();
  if (!value) return;
  const field = menu.getByPlaceholder('Value', { exact: true }).filter({ visible: true }).first();
  if (await field.isVisible({ timeout: 5000 }).catch(() => false)) {
    await field.fill(value);
    await menu.getByRole('button', { name: /^(assign|update)$/i }).first().click();
  } else {
    await menu.locator('.v-chip').filter({ hasText: exact(value) }).first().click();
  }
}

/** Close an open picker with its "Done" button (the add menu deliberately
 *  survives a click, so several tags can go on in one visit). */
export async function closeTagMenu(page: Page, menu: Locator) {
  if (!(await menu.isVisible().catch(() => false))) return;
  const done = menu.getByRole('button', { name: /^done$/i }).first();
  if (await done.isVisible().catch(() => false)) await done.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await menu.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Apply a tag to the entity whose page is on screen, inline on its Details tab
 * (warehouse, namespace, table, view or generic table — the tab is selected
 * here). Idempotent: combos share backend state, so a marker that is already
 * applied is left alone, and an already-applied valued tag has its value set
 * through the chip instead (the add picker locks applied tags).
 */
export async function applyEntityTag(page: Page, opts: { tagName: string; value?: string }) {
  const section = await waitForTagsSection(page);
  const chip = tagChip(section, opts.tagName);
  if (await chip.isVisible({ timeout: 3000 }).catch(() => false)) {
    if (opts.value) await setEntityTagValue(page, opts.tagName, opts.value);
    return;
  }
  const menu = await openTagAddMenu(page);
  await pickTag(page, menu, opts.tagName, opts.value);
  // The write lands on click; the chip appearing is the confirmation.
  await expect(tagChip(section, opts.tagName)).toBeVisible({ timeout: 15000 });
  await closeTagMenu(page, menu);
}

/** Change the value of an applied free-text / enumerated tag by clicking its chip. */
export async function setEntityTagValue(page: Page, tagName: string, value: string) {
  const section = await waitForTagsSection(page);
  const chip = tagChip(section, tagName);
  await expect(chip).toBeVisible({ timeout: 15000 });
  // The editor is a one-row TagPickerList (no search), but it has the footer.
  const editor = tagPickerMenu(page);
  await openMenuVia(page, chip.locator('.tag-chip__name'), editor, `the value editor of ${tagName}`);
  const field = editor.getByPlaceholder('Value', { exact: true }).first();
  if (await field.isVisible({ timeout: 5000 }).catch(() => false)) {
    await field.fill(value);
    await editor.getByRole('button', { name: /^(update|assign)$/i }).first().click();
  } else {
    await editor.locator('.v-chip').filter({ hasText: exact(value) }).first().click();
  }
  // The editor closes itself on apply; the new value shows beside the chip.
  await editor.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await expect(tagValueText(section, tagName)).toHaveText(exact(value), { timeout: 15000 });
}

/** Open the in-place "Remove <name>?" confirm of a direct chip inside `scope`
 *  (the ✕ is invisible until the chip is hovered). Returns the confirm. */
export async function openRemoveTagConfirm(page: Page, scope: Locator, tagName: string): Promise<Locator> {
  const chip = tagChip(scope, tagName);
  await expect(chip).toBeVisible({ timeout: 15000 });
  const confirm = page
    .locator('.v-overlay__content')
    .filter({ visible: true })
    .filter({ has: page.getByRole('button', { name: 'Remove', exact: true }) })
    .filter({ hasText: tagName })
    .last();
  for (let i = 0; i < 5 && !(await confirm.isVisible().catch(() => false)); i++) {
    await chip.hover().catch(() => {});
    await chip.locator(`[aria-label="Remove ${tagName}"]`).click({ timeout: 5000 }).catch(() => {});
    await confirm.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }
  await expect(confirm, `the remove confirm for ${tagName} never opened`).toBeVisible({ timeout: 5000 });
  return confirm;
}

/** Remove a direct chip inside `scope` (✕ → confirm → Remove). No-op when absent. */
export async function removeTagChip(page: Page, scope: Locator, tagName: string) {
  const chip = tagChip(scope, tagName);
  if (!(await chip.isVisible({ timeout: 3000 }).catch(() => false))) return;
  const confirm = await openRemoveTagConfirm(page, scope, tagName);
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(chip).toBeHidden({ timeout: 15000 });
}

/** Remove a direct tag from the entity on screen, inline on its Details tab.
 *  Idempotent: a tag that is not applied is a no-op. */
export async function removeEntityTag(page: Page, tagName: string) {
  const section = await waitForTagsSection(page);
  await removeTagChip(page, section, tagName);
}

// ---- column tags (table Schema tab, TableColumnProfiler) -------------------

/** The Schema-tab row of a column (dotted path for struct fields). Keyed on the
 *  row's compact "+" (aria-label "Add tag to <path>"), which every taggable row
 *  has whether or not it carries tags. */
export function columnRow(page: Page, path: string): Locator {
  return page
    .locator('tr')
    .filter({ visible: true })
    .filter({ has: page.locator(`[aria-label="Add tag to ${path}"]`) })
    .first();
}

/** Apply a tag to one column on the Schema tab (which must be on screen). */
export async function applyColumnTag(page: Page, path: string, tagName: string, value?: string) {
  const row = columnRow(page, path);
  await expect(row, `no taggable schema row for ${path}`).toBeVisible({ timeout: 20000 });
  if (await tagChip(row, tagName).isVisible({ timeout: 2000 }).catch(() => false)) return;
  // The "+" only fades in on row hover (it is laid out and clickable either way).
  await row.hover().catch(() => {});
  const menu = tagPickerMenu(page);
  await openMenuVia(page, row.locator(`[aria-label="Add tag to ${path}"]`), menu, `the column tag menu of ${path}`);
  await waitForTagRights(menu);
  await pickTag(page, menu, tagName, value);
  await expect(tagChip(columnRow(page, path), tagName)).toBeVisible({ timeout: 15000 });
  await closeTagMenu(page, menu);
}

/** Remove a tag from one column on the Schema tab. No-op when absent. */
export async function removeColumnTag(page: Page, path: string, tagName: string) {
  await removeTagChip(page, columnRow(page, path), tagName);
}
