import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { createWarehouse, openWarehouse, warehouseName } from '../_utils/warehouse';
import { recoverFromOffline } from '../_utils/app';

// Cedar policy management — the largest surface the 0.18 Plus app added, and
// console-plus-only: the OSS console renders the Policies tab as a teaser with a
// PLUS chip and no working pane (asserted in the OSS-teaser test below). The Plus
// app renders it only when the authorizer is Cedar, which is exactly the @cedar
// combo.
//
// Break-glass: peter is an instance admin (`is-instance-admin` on /whoami), so
// EVERY write here — save, dry-run and delete alike — needs a free-text reason,
// sent as the `x-break-glass` header. Save stays disabled until it is filled.
test.describe('cedar policies @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const policyName = 'e2e-policy';
  const BREAK_GLASS = 'e2e run';
  // Deliberately narrow and self-contained: this asserts the editor round-trip,
  // not Cedar semantics. It must still be a policy Cedar accepts — there is no
  // inactive state for a stored policy, and `when { false }` is refused outright
  // as "policy is impossible", so the harmlessness comes from naming a principal
  // that does not exist rather than from a condition that never holds. Delete is
  // the only off switch, and there is no history.
  const POLICY_SOURCE =
    'permit (principal == Lakekeeper::User::"oidc~e2e-nobody", action, resource);';

  async function gotoPolicies(page: import('@playwright/test').Page) {
    await page.goto('/ui/governance?tab=policies');
    await page.waitForLoadState('domcontentloaded');
    await recoverFromOffline(page);
    // Tab switching uses history.replaceState now, so nothing navigates — wait on
    // the rail itself rather than on a URL change.
    await expect(page.getByRole('tab', { name: 'Stored Policies' })).toBeVisible({ timeout: 30000 });
  }

  test('the policy rail offers all seven panes', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    await gotoPolicies(page);

    // Grouped Configure / Inspect / Investigate. The two writable panes lead.
    for (const pane of [
      'Predefined Policies',
      'Stored Policies',
      'Active Policies',
      'Policy Sources',
      'Entity Sources',
      'Cedar Schema',
      'Resolve Entities',
    ]) {
      await expect(page.getByRole('tab', { name: pane })).toBeVisible({ timeout: 15000 });
    }
  });

  test('predefined policies are togglable per scope', async ({ bootstrappedPage: page }) => {
    test.setTimeout(120000);
    await gotoPolicies(page);
    await page.getByRole('tab', { name: 'Predefined Policies' }).click();

    // The shipped pack is decided per project OR per warehouse; the scope switch
    // is what says which. A wrong scope here is the one mistake the pane must not
    // invite, so its presence is worth asserting on its own.
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByRole('button', { name: 'Warehouse', exact: true })).toBeVisible();
    // The pack itself: ~47 shipped policies, one toggle each. Vuetify's v-switch
    // exposes role="checkbox", not role="switch".
    await expect(page.getByText(/Predefined policies\s+\d+\s*\/\s*\d+ in force/)).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByRole('checkbox').first()).toBeVisible({ timeout: 20000 });
  });

  test('stored policy: create with break-glass, then delete', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180000);
    await gotoPolicies(page);
    await page.getByRole('tab', { name: 'Stored Policies' }).click();

    const editor = page.locator('.v-overlay__content').filter({ hasText: 'New policy' }).last();

    await test.step('1 · open the fullscreen editor', async () => {
      await page.getByRole('button', { name: 'New policy', exact: true }).first().click();
      await expect(editor).toBeVisible({ timeout: 20000 });
      // Two ways of writing the same policy. Text is the source of truth; the
      // Builder generates into it and is labelled Beta.
      await expect(editor.getByRole('tab', { name: 'Text' })).toBeVisible();
      await expect(editor.getByRole('tab', { name: /Builder/ })).toBeVisible();
    });

    await test.step('2 · write the policy', async () => {
      await editor.getByLabel('Name *').fill(policyName);
      await editor.getByLabel('Description').fill('created by e2e');
      const source = editor.locator('.cm-content').first();
      await source.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
      await source.fill(POLICY_SOURCE);
    });

    await test.step('3 · Save is gated on a break-glass reason', async () => {
      const save = editor.getByRole('button', { name: 'Save', exact: true });
      // peter is an instance admin, so the reason is demanded up front and Save
      // stays disabled until it is given.
      await expect(save).toBeDisabled();
      await editor.getByLabel(/Break-glass reason/i).fill(BREAK_GLASS);
      await expect(save).toBeEnabled({ timeout: 10000 });
    });

    await test.step('4 · Test dry-runs the apply', async () => {
      // The result is a SNACKBAR with a ~5s TTL and nothing else (errors also
      // persist inline in the footer) — read it promptly or it is gone.
      await editor.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(page.locator('.v-snackbar').first()).toBeVisible({ timeout: 30000 });
    });

    await test.step('5 · save it', async () => {
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).toBeHidden({ timeout: 30000 });
      await expect(page.getByText(policyName, { exact: true }).first()).toBeVisible({
        timeout: 20000,
      });
    });

    await test.step('6 · delete it (break-glass again)', async () => {
      const row = page.getByRole('row', { name: new RegExp(policyName) }).first();
      await row.locator('button:has(.mdi-delete-outline), button:has(.mdi-delete)').first().click();
      const confirm = page.locator('.v-overlay__content').filter({ hasText: /delete/i }).last();
      await confirm.getByLabel(/Break-glass reason/i).fill(BREAK_GLASS);
      // Cancel comes BEFORE the destructive action now (normalised across the
      // component library), so this selects by name rather than by position.
      await confirm.getByRole('button', { name: /^delete$/i }).click();
      await expect(page.getByText(policyName, { exact: true })).toHaveCount(0, { timeout: 20000 });
    });
  });

  test('a warehouse has its own Policies tab, fixed to that warehouse', async ({
    bootstrappedPage: page,
  }) => {
    test.setTimeout(180000);
    test.skip(!ENABLED_BACKENDS.length, 'no storage backend configured');
    const backend = ENABLED_BACKENDS[0];
    await createWarehouse(page, backend);
    await openWarehouse(page, warehouseName(backend));

    const policiesTab = page.getByRole('tab', { name: 'Policies' });
    await expect(policiesTab).toBeVisible({ timeout: 20000 });
    for (let i = 0; i < 5; i++) {
      await policiesTab.click().catch(() => {});
      await page.waitForTimeout(800);
      if ((await policiesTab.getAttribute('aria-selected')) === 'true') break;
    }

    // The same two Configure panes, fixed to this warehouse — and named shorter
    // here ("Predefined" / "Stored") than in the project rail, because the scope
    // is already in the page. No scope switch and no warehouse picker: the
    // subject is decided.
    await expect(page.getByRole('tab', { name: 'Predefined', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByRole('tab', { name: 'Stored', exact: true })).toBeVisible();
    // The caption states the two scopes are read together — a warehouse narrows,
    // it does not replace the project's decision.
    await expect(page.getByText(/a warehouse narrows, it does not replace/i)).toBeVisible({
      timeout: 15000,
    });
    // Scope switching belongs to the project rail only.
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0);
  });
});

// The OSS console always renders a Policies tab, in the same slot, carrying a
// PLUS chip — upgrading must not move the feature the user was just sold. It is
// an advert, not a pane, so this asserts the teaser rather than the rail. Runs in
// every OSS mode; the Plus app overrides the tab with the real thing, so the
// describe is skipped there.
test.describe('policies teaser (OSS) @noauth @authn @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(process.env.APP === 'console-plus', 'console-plus renders the real Cedar pane');

  test('the Policies tab markets Lakekeeper+', async ({ bootstrappedPage: page }) => {
    test.setTimeout(90000);
    await page.goto('/ui/governance?tab=policies');
    await page.waitForLoadState('domcontentloaded');
    await recoverFromOffline(page);

    const tab = page.getByRole('tab', { name: /Policies/ });
    await expect(tab).toBeVisible({ timeout: 30000 });
    await expect(tab).toContainText('PLUS');
    await tab.click();
    await expect(page.getByText('Permissions as code').first()).toBeVisible({ timeout: 20000 });
  });
});
