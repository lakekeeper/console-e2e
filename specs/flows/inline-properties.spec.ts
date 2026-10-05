import { test, expect } from '../_fixtures/auth.fixture';
import type { Locator, Page } from '@playwright/test';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  seedWarehouseWithNamespace,
  openWarehouse,
  openNamespace,
  ensureTable,
  openTable,
  selectTab,
} from '../_utils/warehouse';

// Properties are edited in place now: PropertiesEditToggle ("Edit" → "Done" /
// "Cancel") swaps the read-only list for EntityPropertiesPanel inside the
// Details tab, and the Settings dialog lost its Properties pane. Namespace and
// table only — a view needs LoQE (browser-reachable storage) to exist at all,
// and its panel is the same component.
//
// Runs @noauth too: noauth brings up silo like every mode, and properties need
// no authorizer. A key unique to the attempt keeps a retry (which reuses its
// per-test project) from colliding with the row the first attempt saved.

const uniqueKey = (prefix: string) => `${prefix}_${Date.now().toString(36)}`;

/** The namespace Details "Properties" card. */
function namespacePropsCard(page: Page): Locator {
  return page
    .locator('.v-card')
    .filter({ visible: true })
    .filter({ has: page.locator('.v-card-title', { hasText: /^\s*Properties/ }) })
    .first();
}

/** The table Details "Properties" section. */
function tablePropsSection(page: Page): Locator {
  return page.locator('.tdx-attached__props').filter({ visible: true }).first();
}

/** Click "Edit" until the editor is up (activator race just after a tab switch). */
async function startEditing(page: Page, scope: Locator) {
  const add = scope.getByRole('button', { name: /^add property$/i });
  for (let i = 0; i < 4 && !(await add.isVisible().catch(() => false)); i++) {
    await scope.getByRole('button', { name: /^edit$/i }).first().click({ timeout: 5000 }).catch(() => {});
    await add.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }
  await expect(add, 'the properties editor never opened').toBeVisible({ timeout: 10000 });
  // The panel loads fresh from the server before it shows rows.
  await expect(scope.getByText('Loading properties…')).toBeHidden({ timeout: 15000 });
}

/** Add one key/value row in an open EntityPropertiesPanel. */
async function addPropertyRow(scope: Locator, key: string, value: string) {
  await scope.getByRole('button', { name: /^add property$/i }).click();
  await scope.getByLabel('Key', { exact: true }).last().fill(key);
  await scope.getByLabel('Value', { exact: true }).last().fill(value);
}

/** Open the entity's Settings dialog from the header "Settings" menu. */
async function openSettingsDialog(page: Page, entry: RegExp, subtitle: string): Promise<Locator> {
  const dialog = page
    .locator('.v-overlay__content')
    .filter({ visible: true })
    .filter({ has: page.getByRole('tab', { name: /^settings$/i }) })
    .last();
  for (let i = 0; i < 4 && !(await dialog.isVisible().catch(() => false)); i++) {
    await page.getByRole('button', { name: /^settings$/i }).first().click({ timeout: 5000 }).catch(() => {});
    const item = page.locator('.v-list-item').filter({ visible: true }).filter({ hasText: entry }).first();
    if (await item.isVisible({ timeout: 4000 }).catch(() => false)) {
      // The menu entry's subtitle no longer mentions properties.
      await expect(item).toContainText(subtitle);
      await expect(item).not.toContainText(/propert/i);
      await item.click().catch(() => {});
    }
    await dialog.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  }
  await expect(dialog, 'the Settings dialog never opened').toBeVisible({ timeout: 5000 });
  return dialog;
}

async function closeSettingsDialog(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: /^close$/i }).last().click().catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

test.describe('inline properties @noauth @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS[0];

  test('namespace properties are edited in place on the Details tab', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    await selectTab(page, /^details$/i);
    const card = namespacePropsCard(page);
    await expect(card).toBeVisible({ timeout: 15000 });

    const key = uniqueKey('e2e_owner');
    await test.step('Edit → Add property → Save properties → shown read-only', async () => {
      await startEditing(page, card);
      // Nothing changed yet: the toggle offers "Done", not "Cancel".
      await expect(card.getByRole('button', { name: /^done$/i })).toBeVisible();
      await addPropertyRow(card, key, 'team-data');
      const save = card.getByRole('button', { name: /^save properties$/i });
      await expect(save).toBeEnabled({ timeout: 5000 });
      await save.click();
      // Saving leaves edit mode; the read-only table carries the new pair.
      await expect(card.getByRole('button', { name: /^edit$/i })).toBeVisible({ timeout: 15000 });
      const row = card.getByRole('row').filter({ hasText: key });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row).toContainText('team-data');
    });

    await test.step('it was committed, not just redrawn', async () => {
      await page.reload();
      await selectTab(page, /^details$/i);
      await expect(namespacePropsCard(page).getByRole('row').filter({ hasText: key })).toBeVisible({ timeout: 15000 });
    });

    await test.step('Cancel with an unsaved edit asks before discarding', async () => {
      const c = namespacePropsCard(page);
      const draft = uniqueKey('e2e_draft');
      await startEditing(page, c);
      await addPropertyRow(c, draft, 'x');
      const cancel = c.getByRole('button', { name: /^cancel$/i });
      await expect(cancel).toBeVisible({ timeout: 5000 });

      const confirm = page
        .locator('.v-overlay__content')
        .filter({ visible: true })
        .filter({ hasText: 'Discard your unsaved property changes?' })
        .last();
      await cancel.click();
      await expect(confirm).toBeVisible({ timeout: 5000 });
      // Keep editing: the draft row is still there.
      await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(confirm).toBeHidden({ timeout: 5000 });
      await expect(c.getByRole('button', { name: /^save properties$/i })).toBeEnabled();

      await cancel.click();
      await expect(confirm).toBeVisible({ timeout: 5000 });
      await confirm.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(c.getByRole('button', { name: /^edit$/i })).toBeVisible({ timeout: 10000 });
      await expect(c.getByText(draft)).toHaveCount(0);
    });

    await test.step('the Settings dialog has no Properties pane any more', async () => {
      const dialog = await openSettingsDialog(page, /namespace settings/i, 'Protection');
      await expect(dialog.getByRole('tab', { name: /^settings$/i })).toBeVisible();
      await expect(dialog.getByRole('tab', { name: /propert/i })).toHaveCount(0);
      await closeSettingsDialog(page, dialog);
    });
  });

  test('table properties are edited in place on the Details tab', async ({ bootstrappedPage: page }) => {
    // The table is made with the Create Table dialog (a server-side metadata
    // write), so any enabled backend will do — no LoQE, no browser CORS.
    test.setTimeout(240000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);
    const tbl = 'inline_props_tbl';
    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    await ensureTable(page, tbl, 'a');
    await openTable(page, tbl);
    await selectTab(page, /^details$/i);

    const section = tablePropsSection(page);
    await expect(section).toBeVisible({ timeout: 20000 });
    const key = uniqueKey('e2e_tbl_owner');

    await test.step('Edit → Add property → Save properties (one Iceberg commit)', async () => {
      await startEditing(page, section);
      await addPropertyRow(section, key, 'team-tables');
      await section.getByRole('button', { name: /^save properties$/i }).click();
      await expect(section.getByRole('button', { name: /^edit$/i })).toBeVisible({ timeout: 20000 });
      // The host reloads the table after the commit; the virtual table shows it.
      await expect(section.getByText(key, { exact: true })).toBeVisible({ timeout: 20000 });
      await expect(section.getByText('team-tables', { exact: true })).toBeVisible();
    });

    await test.step('the Settings dialog has no Properties pane any more', async () => {
      const dialog = await openSettingsDialog(page, /table settings/i, 'Rename · protection · metadata');
      await expect(dialog.getByRole('tab', { name: /propert/i })).toHaveCount(0);
      await closeSettingsDialog(page, dialog);
    });
  });
});
