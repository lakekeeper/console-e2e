import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import {
  seedWarehouseWithNamespace,
  openWarehouse,
  openNamespace,
  ensureTable,
  openTable,
  selectTab,
} from '../_utils/warehouse';
import {
  createTagDefinition,
  applyEntityTag,
  removeEntityTag,
  setEntityTagValue,
  openTagAddMenu,
  pickerItem,
  closeTagMenu,
  openRemoveTagConfirm,
  waitForTagsSection,
  tagsSection,
  tagChip,
  tagGroup,
  tagValueText,
  applyColumnTag,
  removeColumnTag,
  columnRow,
} from '../_utils/tags';
import { seedTagDefinitions, namespaceIdOf, applyNamespaceTags, seededName } from '../_utils/seed';

// Inline tag editing on the Details tabs (EntityTagsChips + TagAddMenu +
// TagPickerList + TagChip) and on the table Schema tab (TableColumnProfiler).
// The "Manage tags" dialog these replaced is gone.
//
// Every test runs in its own project (the fixture default), so tag definitions
// and warehouses start empty; a retry reuses its project, which is why the
// helpers stay idempotent. Needs a warehouse, so — like governance-tags — not
// @noauth (no storage journeys there), and the per-tag rights are covered by
// perms/tag-rights.spec.ts, not here.
test.describe('inline tags @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS[0];
  const marker = 'e2e.inline-marker';
  const text = 'e2e.inline-text';

  test('apply, group, edit and remove tags inline on a namespace', async ({ bootstrappedPage: page }) => {
    test.setTimeout(240000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);

    await test.step('1 · define a marker and a free-text tag', async () => {
      await createTagDefinition(page, { name: marker, valueKind: 'marker' });
      await createTagDefinition(page, { name: text, valueKind: 'free-text' });
    });

    await test.step('2 · apply both from the Details heading "Add" menu', async () => {
      await openWarehouse(page, wh);
      await openNamespace(page, ns);
      await applyEntityTag(page, { tagName: marker });
      await applyEntityTag(page, { tagName: text, value: 'alpha' });
    });

    await test.step('3 · a marker is a Classification chip, a free-text tag is a Free text entry with its text under it', async () => {
      const section = tagsSection(page);
      const labels = tagGroup(section, 'Classifications');
      const values = tagGroup(section, 'Free text');
      await expect(tagChip(labels, marker)).toBeVisible({ timeout: 15000 });
      await expect(labels.locator('.etc-count')).toHaveText('1');
      await expect(tagChip(values, text)).toBeVisible();
      await expect(values.locator('.etc-count')).toHaveText('1');
      await expect(tagValueText(section, text)).toHaveText('alpha');
      // The heading counts every tag on the namespace.
      // Detail pages pass their own #heading (nsx-/tdx-head), so match the count
      // chip anywhere in the heading wrapper, not only the default .etc-head.
      await expect(section.locator('.etc-head-wrap .v-chip').first()).toHaveText('2');
    });

    await test.step('4 · the picker lists applied tags locked, so a search finds them', async () => {
      const menu = await openTagAddMenu(page);
      const markerItem = await pickerItem(page, menu, marker);
      await expect(markerItem).toBeVisible({ timeout: 10000 });
      await expect(markerItem).toHaveClass(/v-list-item--disabled/);
      await expect(markerItem).toContainText('Already applied');
      const textItem = await pickerItem(page, menu, text);
      await expect(textItem).toHaveClass(/v-list-item--disabled/);
      await expect(textItem).toContainText('Already applied — change it on its chip');
      await closeTagMenu(page, menu);
      await expect(menu).toBeHidden();
    });

    await test.step('5 · clicking a valued chip edits its value in place', async () => {
      await setEntityTagValue(page, text, 'beta');
      // Survives a reload: it was written, not just redrawn.
      await page.reload();
      await waitForTagsSection(page);
      await expect(tagValueText(tagsSection(page), text)).toHaveText('beta', { timeout: 15000 });
    });

    await test.step('6 · ✕ asks first; Cancel keeps the tag', async () => {
      const section = tagsSection(page);
      const confirm = await openRemoveTagConfirm(page, section, marker);
      await expect(confirm).toContainText(`Remove ${marker}`);
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirm).toBeHidden({ timeout: 5000 });
      await expect(tagChip(section, marker)).toBeVisible();
    });

    await test.step('7 · ✕ → Remove takes it off; an emptied group disappears', async () => {
      await removeEntityTag(page, marker);
      const section = tagsSection(page);
      await expect(tagGroup(section, 'Classifications')).toHaveCount(0);
      await removeEntityTag(page, text);
      await expect(tagGroup(section, 'Free text')).toHaveCount(0);
      await expect(section.getByText('No tags', { exact: true })).toBeVisible({ timeout: 10000 });
    });
  });

  test('a warehouse tag shows on the namespace as Inherited, read-only', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);
    const inherited = 'e2e.inline-inherited';
    await createTagDefinition(page, { name: inherited, valueKind: 'marker' });

    await openWarehouse(page, wh);
    await applyEntityTag(page, { tagName: inherited });

    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    const section = await waitForTagsSection(page);
    const group = tagGroup(section, 'Inherited');
    await expect(group).toBeVisible({ timeout: 15000 });
    await expect(group.locator('.etc-sublabel')).toHaveText('from warehouse');
    const chip = tagChip(group, inherited, 'inherited');
    await expect(chip).toBeVisible();
    await expect(chip.locator('.mdi-arrow-top-left')).toHaveCount(1);
    // Nothing can be done with it here: no ✕, and it is not a direct tag.
    await chip.hover();
    await expect(chip.locator(`[aria-label="Remove ${inherited}"]`)).toHaveCount(0);
    await expect(tagChip(section, inherited, 'direct')).toHaveCount(0);

    // Leave the warehouse clean (a retry reuses this project).
    await openWarehouse(page, wh);
    await removeEntityTag(page, inherited);
  });

  test('the tag filter folds behind an icon over more than 10 tags', async ({ bootstrappedPage: page }) => {
    // 11 definitions + 11 attachments over the API (seed.ts): the subject is the
    // filter, not the picker, and 11 dialogs would add a minute for nothing.
    test.setTimeout(180000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);
    await openWarehouse(page, wh);
    const warehouseId = page.url().match(/\/ui\/warehouse\/([^/?#]+)/)?.[1] || '';
    expect(warehouseId, 'could not read the warehouse id from the route').not.toBe('');

    const names = await seedTagDefinitions(page, 11, 'e2e.many');
    const nsId = await namespaceIdOf(page, warehouseId, ns);
    await applyNamespaceTags(page, warehouseId, nsId, names);

    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    const section = await waitForTagsSection(page);
    await expect(tagChip(section, names[10])).toBeVisible({ timeout: 15000 });

    const filterField = section.getByPlaceholder('Filter tags and values');
    const openToggle = section.getByRole('button', { name: 'Filter tags', exact: true });
    // Folded by default: the icon, no field.
    await expect(openToggle).toBeVisible();
    await expect(filterField).toHaveCount(0);

    await openToggle.click();
    await expect(filterField).toBeVisible();
    await filterField.fill(seededName('e2e.many', 7, '.'));
    await expect(tagChip(section, seededName('e2e.many', 7, '.'))).toBeVisible();
    await expect(tagChip(section, seededName('e2e.many', 1, '.'))).toBeHidden();

    await filterField.fill('no-such-tag');
    await expect(section.getByText('No tag matches “no-such-tag”.')).toBeVisible();

    // Clicking again hides the field AND clears it — a hidden filter must never
    // be what narrows the list.
    await section.getByRole('button', { name: 'Hide filter', exact: true }).click();
    await expect(filterField).toHaveCount(0);
    await expect(tagChip(section, seededName('e2e.many', 1, '.'))).toBeVisible();
    await openToggle.click();
    await expect(filterField).toHaveValue('');
    await section.getByRole('button', { name: 'Hide filter', exact: true }).click();

    // Back down to ten tags, the toggle goes away.
    await removeEntityTag(page, names[10]);
    await expect(openToggle).toHaveCount(0, { timeout: 10000 });
  });

  test('column tags are applied and removed on the Schema tab', async ({ bootstrappedPage: page }) => {
    // A table is created through the Create Table dialog (a server-side metadata
    // write) — no LoQE, so no browser-reachable storage needed.
    test.setTimeout(240000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);
    const columnTag = 'e2e.inline-column';
    const tbl = 'inline_tags_tbl';
    await createTagDefinition(page, { name: columnTag, valueKind: 'marker', scope: ['Column'] });

    await openWarehouse(page, wh);
    await openNamespace(page, ns);
    await ensureTable(page, tbl, 'a');
    await openTable(page, tbl);
    await selectTab(page, /^schema$/i);

    await test.step('per-row "+" applies a tag to the column', async () => {
      await applyColumnTag(page, 'a', columnTag);
      await page.reload();
      await selectTab(page, /^schema$/i);
      await expect(tagChip(columnRow(page, 'a'), columnTag)).toBeVisible({ timeout: 20000 });
    });

    await test.step('the "+" leads every taggable row and there is no bulk mode', async () => {
      // The add control is on screen without hovering, before the chips.
      const add = columnRow(page, 'a').getByRole('button', { name: /^Add tag to a$/ });
      await expect(add).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: /^tag columns$/i })).toHaveCount(0);
      await expect(page.getByText(/^Select all \(\d+\)$/)).toHaveCount(0);
    });

    await test.step('the chip ✕ removes it from the column', async () => {
      await removeColumnTag(page, 'a', columnTag);
      await expect(tagChip(columnRow(page, 'a'), columnTag)).toHaveCount(0);
    });

    await test.step('the table Details tab points column tags to Schema', async () => {
      await selectTab(page, /^details$/i);
      await expect(page.getByText('Tags on individual columns live in the')).toBeVisible({ timeout: 15000 });
    });
  });
});
