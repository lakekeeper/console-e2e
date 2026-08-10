import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace, openWarehouse } from '../_utils/warehouse';
import {
  createTagDefinition,
  openTagDefinition,
  applyEntityTag,
  openManageTagsMenu,
  removeEntityTag,
} from '../_utils/tags';
import { login, TEST_USER_2 } from '../_utils/auth';

// anna runs in a FRESH browser context (separate session from peter), same as
// access-control.spec.ts — it does NOT inherit the Playwright config baseURL.
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : `http://localhost:${process.env.APP_PORT || '3001'}`;

// Governance Tags (project vocabulary + entity attachments). Needs a warehouse to
// attach to, so — like warehouse-lifecycle.spec.ts — this does NOT run @noauth
// (no storage backend is exercised there). Table/column-level tags and the LoQE
// data-write path are intentionally out of scope for this first pass: they'd tie
// tag coverage to storage-backend/CORS availability for no extra assurance, since
// the same attach/detach code path is already proven here at warehouse + namespace
// scope. Revisit if a table/column-specific regression shows up.
test.describe('governance tags @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured (set AWS_* or S3_LOCAL_ENABLE=1)');

  const backend = ENABLED_BACKENDS[0];
  const markerTag = 'e2e.reviewed';
  const textTag = 'e2e.classification';

  test('define, attach, view, and delete tags', async ({ bootstrappedPage: page }) => {
    // 3 min, not 2: this is a long multi-step journey, and the FIRST run against a
    // cold Vite dev server compiles the /governance/tags routes on-demand (~80s),
    // which alone nearly exhausts a 2-min budget before step 7. The bundled image
    // console has no on-demand compile, so it's comfortably faster there.
    test.setTimeout(180000);
    const { wh, ns } = await seedWarehouseWithNamespace(page, backend);

    await test.step('1 · create a marker and a free-text tag definition', async () => {
      await createTagDefinition(page, { name: markerTag, valueKind: 'marker' });
      await createTagDefinition(page, { name: textTag, valueKind: 'free-text' });
    });

    await test.step('2 · marker tag detail page shows its kind and scope', async () => {
      await openTagDefinition(page, markerTag);
      await expect(page.getByText('marker', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('warehouse', { exact: true }).first()).toBeVisible();
    });

    await test.step('3 · apply the marker tag to the warehouse', async () => {
      await openWarehouse(page, wh);
      await applyEntityTag(page, { tagName: markerTag });
    });

    await test.step('4 · the tag chip shows up on the warehouse Details tab', async () => {
      await expect(page.getByText(markerTag, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    });

    await test.step('5 · reverse lookup: the tag definition lists the warehouse as a target', async () => {
      await openTagDefinition(page, markerTag);
      await page.getByRole('tab', { name: 'Attachments' }).click();
      await expect(page.getByText(wh, { exact: false }).first()).toBeVisible({ timeout: 10000 });
    });

    await test.step('6 · apply the free-text tag (with a value) to the namespace', async () => {
      await openWarehouse(page, wh);
      // "demo_ns" appears twice (sidebar nav tree + the Namespaces table below it)
      // — the tree entry doesn't navigate on click, the table row does.
      await page.getByText(ns, { exact: true }).last().click();
      await page.waitForURL(/\/namespace\//, { timeout: 10000 });
      await applyEntityTag(page, { tagName: textTag, value: 'confidential' });
    });

    await test.step("7 · can't delete a tag definition that's still attached", async () => {
      await openTagDefinition(page, textTag);
      // The detail page's action buttons wire up slightly after paint (the same
      // Vuetify activator race the tag helpers guard against), and the npm dev build
      // is slower than the bundled image — a bare click can be swallowed so the guard
      // dialog never appears. Settle, then retry the click until the guard shows
      // (same "click until it takes" pattern used elsewhere for Vuetify races).
      await page.waitForLoadState('networkidle').catch(() => {});
      const deleteBtn = page.getByRole('button', { name: 'Delete tag' });
      const guard = page.getByText("Can't delete tag");
      await expect(deleteBtn).toBeEnabled({ timeout: 10000 });
      for (let i = 0; i < 4 && !(await guard.isVisible().catch(() => false)); i++) {
        await deleteBtn.click().catch(() => {});
        await guard.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      }
      await expect(guard).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: 'Close' }).click();
    });

    await test.step('8 · detach both tags, then delete both definitions', async () => {
      // Detach the marker tag from the warehouse (applied in step 3) — a
      // definition can't be deleted while still attached anywhere.
      await openWarehouse(page, wh);
      await openManageTagsMenu(page);
      await removeEntityTag(page, markerTag);

      // Detach the free-text tag from the namespace (applied in step 6).
      await openWarehouse(page, wh);
      // "demo_ns" appears twice (sidebar nav tree + the Namespaces table below it)
      // — the tree entry doesn't navigate on click, the table row does.
      await page.getByText(ns, { exact: true }).last().click();
      await page.waitForURL(/\/namespace\//, { timeout: 10000 });
      await openManageTagsMenu(page);
      await removeEntityTag(page, textTag);

      for (const name of [markerTag, textTag]) {
        await openTagDefinition(page, name);
        await page.getByRole('button', { name: 'Delete tag' }).click();
        await page.getByLabel('Tag definition name').fill(name);
        await page.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(page).toHaveURL(/\/governance\?tab=tags/, { timeout: 10000 });
        await expect(page.getByText(name, { exact: true })).toHaveCount(0);
      }
    });
  });
});

// Tag permissions (ownership / apply) are an OpenFGA-only concept — same reasoning
// as roles (see role.spec.ts): Cedar has no per-object grant UI, and noauth/authn
// have no authorizer at all.
test.describe('governance tag permissions @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('grant and revoke apply/ownership on a tag definition', async ({ bootstrappedPage: page, browser }) => {
    test.setTimeout(60000);
    const tagName = 'e2e.perm-test';

    // Lakekeeper only knows a user once they've authenticated at least once —
    // searchUser('anna') returns nothing before that. Register her with a
    // throwaway login in a separate context (same as access-control.spec.ts).
    const annaCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    const annaPage = await annaCtx.newPage();
    await login(annaPage, TEST_USER_2);
    await annaCtx.close();

    await createTagDefinition(page, { name: tagName, valueKind: 'marker', scope: ['Warehouse'] });
    await openTagDefinition(page, tagName);

    // Same flakiness permissions.ts documents for the table Permissions tab: it
    // can reset to "details" while data loads — click until it sticks.
    const permTab = page.getByRole('tab', { name: 'Permissions' });
    for (let i = 0; i < 5; i++) {
      await permTab.click().catch(() => {});
      await page.waitForTimeout(1000);
      if ((await permTab.getAttribute('aria-selected')) === 'true') break;
    }

    const annaRow = page.getByRole('row', { name: new RegExp(TEST_USER_2.username, 'i') });

    await test.step('grant "apply" to anna', async () => {
      // Same Vuetify-dialog flakiness grantTableRelation guards against (the
      // search result occasionally never settles) — retry the whole flow.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.getByRole('button', { name: /^grant$/i }).first().click({ timeout: 10000 });
          await page.getByRole('tab', { name: /user/i }).first().click({ timeout: 5000 }).catch(() => {});
          const combo = page.getByRole('combobox').last();
          await combo.fill(TEST_USER_2.username, { timeout: 8000 });
          const option = page.getByRole('option', { name: new RegExp(TEST_USER_2.username, 'i') }).first();
          await option.waitFor({ state: 'visible', timeout: 10000 });
          await option.click({ timeout: 8000 });
          await page.getByRole('checkbox', { name: 'apply' }).check({ timeout: 8000 });
          await page.getByRole('button', { name: /^save$/i }).click({ timeout: 8000 });
          await expect(annaRow).toBeVisible({ timeout: 8000 });
          break;
        } catch {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1000);
          if (await annaRow.isVisible({ timeout: 2000 }).catch(() => false)) break;
        }
      }
      await expect(annaRow).toBeVisible({ timeout: 8000 });
      await expect(annaRow.getByText('Can apply')).toBeVisible();
    });

    await test.step('edit the assignment to add "ownership"', async () => {
      await annaRow.getByRole('button', { name: /^edit$/i }).click();
      await page.getByRole('checkbox', { name: 'ownership' }).check();
      await page.getByRole('button', { name: /^save$/i }).click();
      await expect(annaRow.getByText('Owner')).toBeVisible({ timeout: 10000 });
    });

    await test.step('revoke all access', async () => {
      await annaRow.getByRole('button', { name: /revoke all/i }).click();
      // Two "Revoke all" buttons exist once the confirm dialog is open (the row's
      // outlined trigger + the dialog's flat confirm) — the dialog's is teleported
      // to the end of <body>, so it's the last match.
      await page.getByRole('button', { name: 'Revoke all', exact: true }).last().click();
      await expect(annaRow).toHaveCount(0, { timeout: 10000 });
    });
  });
});
