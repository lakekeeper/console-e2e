import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { recoverFromOffline } from '../_utils/app';
import { openWarehouse, seedWarehouseWithNamespace, selectTab } from '../_utils/warehouse';
import { annaIn, apiHeaders, setUserGrants, userIdOf, warehouseIdOf } from '../_utils/grants';

// `write_data` — the privilege Lakekeeper added between `select` and `modify`:
// change a table's data without changing its structure, dropping or renaming it.
// Inserts, updates, deletes, merges, compaction, statistics and moving branches
// and tags; not the schema, not the properties, not a drop.
//
// It reaches the console through the authorizer's published vocabulary, not
// through anything hard-coded: the Grants UI asks the server which privileges
// exist. So the first test asserts the vocabulary itself, which is the contract
// every grant surface rests on — including that a VIEW does not get it, a view
// having no data of its own to write.
//
// OpenFGA only. Cedar publishes its own vocabulary and gates the same idea
// through policies, so this is `@authz` and not `@cedar`.
test.describe('write_data grants @authz', () => {
  const backend = ENABLED_BACKENDS.find((b) => b.key.includes('silo'));
  test.skip(!backend, 'local Silo backend disabled (S3_LOCAL_ENABLE=0)');

  const API = () => process.env.LK_API_URL || 'http://localhost:8181';

  test('the authorizer publishes write_data for everything that holds data', async ({
    bootstrappedPage: page,
    project,
  }) => {
    const res = await page.request.get(`${API()}/management/v1/grants/grantable-privileges`, {
      headers: await apiHeaders(page, project.id),
    });
    expect(res.ok(), `grantable-privileges: ${res.status()} ${await res.text()}`).toBeTruthy();

    const byType: Record<string, Array<{ name: string }>> = (await res.json()).privileges;
    const namesOf = (type: string) => (byType[type] ?? []).map((p) => p.name);

    // A server older than OpenFGA model v4.15 publishes no such privilege at
    // all. Say so plainly rather than failing every assertion below.
    test.skip(
      !namesOf('table').includes('write_data'),
      'server predates the write_data privilege (OpenFGA model v4.15)',
    );

    await test.step('offered where data lives', async () => {
      for (const type of ['project', 'warehouse', 'namespace', 'table']) {
        expect(namesOf(type), `write_data missing on ${type}`).toContain('write_data');
      }
    });

    await test.step('and not on a view, which has no data of its own', async () => {
      expect(namesOf('view')).not.toContain('write_data');
    });
  });

  test('write_data can be granted on a warehouse and shows in its Grants tab', async ({
    bootstrappedPage: page,
    browser,
    project,
  }) => {
    // Warehouse create plus two grant round-trips.
    test.setTimeout(180_000);

    const { wh } = await seedWarehouseWithNamespace(page, backend!);
    const warehouseId = await warehouseIdOf(page, project.id, wh);

    const probe = await page.request.get(
      `${API()}/management/v1/warehouse/${warehouseId}/grants/grantable-privileges`,
      { headers: await apiHeaders(page, project.id) },
    );
    const offered: string[] = ((await probe.json()).privileges ?? []).map(
      (p: { privilege: { name: string } }) => p.privilege.name,
    );
    test.skip(
      !offered.includes('write_data'),
      'server predates the write_data privilege (OpenFGA model v4.15)',
    );

    // Lakekeeper only knows a user once they have signed in, so bring anna up
    // before asking for her id. Her own view of the warehouse is not the subject
    // here, so the context closes again straight away.
    const anna = await annaIn(browser, project);
    await anna.ctx.close();

    const annaId = await userIdOf(page, 'anna');
    // Only the privilege under test. The vocabulary differs per resource type —
    // `get_metadata` is grantable on a table but not on a warehouse — and peter
    // is the one reading the Grants tab, so anna needs nothing else here.
    const granted = ['write_data'];
    await setUserGrants(page, project.id, { type: 'warehouse', warehouseId }, annaId, granted);

    try {
      await openWarehouse(page, wh);
      await selectTab(page, /^grants$/i);
      await recoverFromOffline(page);

      const row = page.getByRole('row', { name: /anna/i }).first();
      await expect(row).toBeVisible({ timeout: 30000 });

      // The collapsed row names the LEVEL ("Warehouse · selected"), not the
      // privileges — those are chips once expanded, and the authoritative
      // rendering is the edit dialog, which ticks the vocabulary the server
      // published. That round trip is the thing worth asserting.
      await row.getByRole('button', { name: /^edit$/i }).click();
      const dialog = page
        .locator('.v-overlay__content')
        .filter({ hasText: /Edit grants|Grant privileges/ })
        .last();
      await expect(dialog).toBeVisible({ timeout: 20000 });
      // Matched loosely: the label is the authorizer's `display-name` when it
      // has one ("Write data"), and the bare name otherwise.
      await expect(
        dialog.getByRole('checkbox', { name: /write.?data/i }).first(),
      ).toBeChecked({ timeout: 20000 });
      await page.keyboard.press('Escape');
    } finally {
      // Combos share one backend and OpenFGA keeps grants in memory, so this has
      // to come back out whatever the assertions did.
      await setUserGrants(
        page,
        project.id,
        { type: 'warehouse', warehouseId },
        annaId,
        granted,
        true,
      );
    }
  });
});
