import { test, expect } from '../_fixtures/auth.fixture';
import { login, TEST_USER_2 } from '../_utils/auth';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace } from '../_utils/warehouse';
import { openLoqeAndAttach, createTableViaLoqe, loqeReadTable } from '../_utils/loqe';
import { grantTableRelation } from '../_utils/permissions';
import { grantAnnaTableReadCedar, resetCedarPolicy } from '../_utils/cedar';

// anna runs in a FRESH browser context (separate session from peter), which does
// NOT inherit the Playwright config baseURL — so it must be set explicitly. In the
// docker matrix (served-UI) the app is the image's embedded console at :8181; the
// npm matrix serves it at :3001.
const ANNA_BASE_URL =
  process.env.SERVED_UI === '1'
    ? process.env.LK_UI_URL || 'http://localhost:8181'
    : 'http://localhost:3001';

// Permission ENFORCEMENT via a real data read — the whole point of authz. A
// non-admin (anna) must be DENIED reading a table until the admin (peter) grants
// her access, then ALLOWED. The read is a LoQE (DuckDB-WASM) SELECT against the
// table peter creates. FGA only here — Cedar grants work differently (a policy
// edit), covered separately (@cedar). No authz ⇒ no gate, so not tagged @authn.
//
// FGA model (confirmed empirically): a TABLE-level `select` grant is enough — FGA
// cascades the ancestor describe/list so anna can see + attach the warehouse.
test.describe('access control @authz', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const deep = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);

  test('anna can read a table only after peter grants table-select', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.skip(!deep, 'no browser-reachable storage backend with write CORS configured');
    test.setTimeout(300000);
    const tbl = 'demo_tbl';

    // 1 · peter seeds a warehouse + namespace + table (LoQE create round-trip).
    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);
    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, tbl);

    // 2 · anna (no grants) is DENIED — she can't even see the warehouse to attach
    //     it, so the SELECT fails ("Catalog does not exist").
    const denyCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    const annaDenied = await denyCtx.newPage();
    await login(annaDenied, TEST_USER_2);
    const before = await loqeReadTable(annaDenied, wh, ns, tbl, 2);
    expect(before.warehouseVisible, 'anna should NOT see the warehouse before any grant').toBeFalsy();
    expect(before.errored, 'anna SELECT should fail before any grant').toBeTruthy();
    await denyCtx.close();

    // 3 · peter grants anna `select` on the TABLE via the Permissions-tab UI.
    await grantTableRelation(page, wh, ns, tbl, 'anna', 'select');

    // 4 · anna is now ALLOWED — she sees + attaches the warehouse and the SELECT
    //     returns the value 1.
    const okCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    const annaAllowed = await okCtx.newPage();
    await login(annaAllowed, TEST_USER_2);
    const after = await loqeReadTable(annaAllowed, wh, ns, tbl, 4);
    expect(after.warehouseVisible, 'anna should see the warehouse after the grant').toBeTruthy();
    expect(after.errored, `anna SELECT should succeed after the grant (got: ${after.errorText})`).toBeFalsy();
    expect(after.value).toContain('1');
    await okCtx.close();
  });
});

// Cedar enforces the same outcome but the "grant" is a POLICY-FILE edit (Cedar has
// no per-user grant UI / roles). A table grant is NOT enough — the policy must
// permit every level explicitly. The test writes anna's permit block into the
// (self-contained) policy file, Cedar hot-reloads, anna can read; then restores it.
// Cedar is console-plus-only, so this is @cedar (runs only in the cedar combo).
test.describe('access control (cedar) @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const deep = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);

  test.beforeEach(() => resetCedarPolicy()); // start denied
  test.afterEach(() => resetCedarPolicy()); // never leave anna granted

  test('anna can read a table only after the Cedar policy grants her', async ({
    bootstrappedPage: page,
    browser,
  }) => {
    test.skip(!deep, 'no browser-reachable storage backend with write CORS configured');
    test.setTimeout(300000);
    const tbl = 'demo_tbl';

    // 1 · peter (admin via base policy) seeds warehouse + namespace + table.
    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);
    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, tbl);

    // 2 · anna is DENIED (base policy grants her nothing).
    const denyCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    const annaDenied = await denyCtx.newPage();
    await login(annaDenied, TEST_USER_2);
    const before = await loqeReadTable(annaDenied, wh, ns, tbl, 2);
    expect(before.warehouseVisible, 'anna should NOT see the warehouse before the policy grant').toBeFalsy();
    expect(before.errored, 'anna SELECT should fail before the policy grant').toBeTruthy();
    await denyCtx.close();

    // 3 · GRANT via Cedar: write anna's permit block into the policy file; Lakekeeper
    //     hot-reloads it. Give the reload a moment to take effect.
    grantAnnaTableReadCedar(wh);
    await page.waitForTimeout(6000);

    // 4 · anna is now ALLOWED — SELECT returns 1.
    const okCtx = await browser.newContext({ baseURL: ANNA_BASE_URL });
    const annaAllowed = await okCtx.newPage();
    await login(annaAllowed, TEST_USER_2);
    const after = await loqeReadTable(annaAllowed, wh, ns, tbl, 5);
    expect(after.warehouseVisible, 'anna should see the warehouse after the policy grant').toBeTruthy();
    expect(after.errored, `anna SELECT should succeed after the policy grant (got: ${after.errorText})`).toBeFalsy();
    expect(after.value).toContain('1');
    await okCtx.close();
  });
});
