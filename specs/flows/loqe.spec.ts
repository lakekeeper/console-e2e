import { test, expect } from '../_fixtures/auth.fixture';
import { ENABLED_BACKENDS } from '../_data/storage-backends';
import { seedWarehouseWithNamespace } from '../_utils/warehouse';
import { openLoqeAndAttach, createTableViaLoqe, loqeExec, setColumnDoc } from '../_utils/loqe';
import { apiHeaders, warehouseIdOf } from '../_utils/grants';
import { currentProject } from '../_utils/project';

// LoQE = in-browser DuckDB-WASM SQL engine. Needs SharedArrayBuffer (cross-origin
// isolation). Probe: does the engine initialize headless? ("Ready" chip).
test.describe('loqe @authn @authz @cedar', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('DuckDB-WASM engine initializes', async ({ bootstrappedPage: page }) => {
    await page.goto('/ui/loqe');
    await page.waitForLoadState('domcontentloaded');
    // Init can take a while (WASM download + worker). "Ready" chip = initialized.
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });
  });

  // The full Iceberg round-trip: attach a warehouse catalog, CREATE a table (writes
  // parquet + commits metadata to S3 from the browser), then read it back. Needs a
  // browser-reachable bucket whose CORS allows WRITES for the app origin, and (for
  // AWS) an STS-enabled warehouse — see _data/storage-backends.ts. Skipped if no
  // deep-flow backend is configured.
  const deep = ENABLED_BACKENDS.find((b) => b.deepFlows !== false);
  test('create + query an Iceberg table via LoQE', async ({ bootstrappedPage: page }) => {
    test.skip(!deep, 'no browser-reachable storage backend with write CORS configured');
    test.setTimeout(180000);

    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);

    // PROVE the browser origin (the video has no address bar). The AWS bucket CORS
    // is pinned to http://localhost:3001 — if vite bumped the port, the write fails.
    // In served-UI (docker) the app is the image's embedded console at :8181 and the
    // silo bucket has wildcard CORS, so the allowed origin is the UI URL instead.
    const origin = new URL(page.url()).origin;
    console.log(`### LoQE page origin: ${origin}`);
    const expectedOrigin =
      process.env.SERVED_UI === '1'
        ? new URL(process.env.LK_UI_URL || 'http://localhost:8181').origin
        : 'http://localhost:3001';
    expect(origin, 'app must run on the CORS-allowed origin').toBe(expectedOrigin);

    await openLoqeAndAttach(page, wh, ns);
    await createTableViaLoqe(page, wh, ns, 'demo_tbl');
  });

  // A quote inside a name is written twice in SQL: table `q"tbl` is `"q""tbl"`.
  // LoQE must build and parse it that way end to end — CREATE, SELECT, and the
  // "Field docs" lookup, which reads table names back out of the statement and
  // used to stop at the first quote (no docs, or another table's).
  test('table name with a quote: query and field docs', async ({ bootstrappedPage: page }) => {
    test.skip(!deep, 'no browser-reachable storage backend with write CORS configured');
    test.setTimeout(180000);

    const { wh, ns } = await seedWarehouseWithNamespace(page, deep!);
    const table = 'q"tbl';
    const quoted = `"${wh}"."${ns}"."q""tbl"`;
    const doc = 'Doc of the quoted table';

    await openLoqeAndAttach(page, wh, ns);
    await loqeExec(page, `drop table if exists ${quoted};`);
    const created = await loqeExec(page, `create table ${quoted} as select 1 as a;`);
    expect(created.errored, created.errorText).toBe(false);

    const project = currentProject().id;
    await setColumnDoc(page, await apiHeaders(page, project), await warehouseIdOf(page, project, wh), ns, table, 'a', doc);

    const read = await loqeExec(page, `select a from ${quoted};`);
    expect(read.errored, read.errorText).toBe(false);
    await expect(page.locator('.loqe-result-table').first()).toContainText('1', { timeout: 15000 });

    await page.getByRole('button', { name: /field docs/i }).click();
    await expect(page.locator('.loqe-result-table .column-doc').first()).toHaveText(doc, { timeout: 30000 });
  });

  // The editor behaves like other SQL editors (VAK-663), and each query tab keeps
  // its runs in a rail beside the editor. Plain SELECTs: no catalog needed.
  test('editor keys and the per-tab history rail', async ({ bootstrappedPage: page }) => {
    test.setTimeout(180_000);
    await page.goto('/ui/loqe');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });

    const editor = page.locator('.cm-content').first();
    const text = () => editor.innerText();
    const rail = page.locator('.history-rail');
    const runs = rail.locator('.history-rail__item');
    const spinner = page.getByText('Running query…');
    const clear = async () => {
      await editor.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
    };

    await test.step('1 · Tab takes the suggestion instead of indenting', async () => {
      await clear();
      await page.keyboard.type('SEL');
      await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(150); // CodeMirror ignores an accept in its first 75 ms
      await page.keyboard.press('Tab');
      await expect.poll(text).toMatch(/^SELECT/);
      await page.keyboard.type(' 42 AS answer');
    });

    await test.step('2 · Cmd/Ctrl+Enter runs it, and the run lands in the rail', async () => {
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(spinner).toBeHidden({ timeout: 60000 });
      await expect(page.locator('.loqe-result-table').first()).toContainText('42', { timeout: 15000 });
      await expect(runs).toHaveCount(1, { timeout: 10000 });
    });

    await test.step('3 · widened, the rail shows the outcome; a run can be named', async () => {
      await rail.getByRole('button', { name: 'Tab history' }).click();
      await expect(runs.first()).toContainText('1 row');
      await runs.first().click();
      const name = page.getByRole('textbox', { name: 'Run name' });
      await name.fill('the answer');
      await name.press('Enter');
      await page.keyboard.press('Escape');
      await expect(rail.locator('.history-rail__name')).toHaveText('the answer', { timeout: 5000 });
    });

    await test.step('4 · Replace puts the SQL back without running it', async () => {
      await clear();
      await page.keyboard.type('SELECT 1');
      await runs.first().click();
      await page.getByRole('button', { name: 'Replace editor text' }).click();
      await expect.poll(text).toBe('SELECT 42 AS answer');
      await expect(runs, 'a replace is not a run').toHaveCount(1);
    });

    await test.step('5 · Shift+Alt+F formats', async () => {
      await editor.click();
      await page.keyboard.press('Shift+Alt+KeyF');
      await expect.poll(text).toMatch(/^SELECT\n\s+42 AS answer$/);
    });

    await test.step('6 · Open in new tab names the tab after the run and carries its SQL', async () => {
      await runs.first().click();
      await page.getByRole('button', { name: 'Open in new tab' }).click();
      await expect(page.getByRole('tab', { name: /the answer/ })).toHaveAttribute('aria-selected', 'true', {
        timeout: 10000,
      });
      await expect.poll(text).toBe('SELECT 42 AS answer');
      await expect(runs, 'the new tab has no runs of its own yet').toHaveCount(0);
    });

    await test.step('7 · a run can be removed from the history', async () => {
      // Open in new tab leaves focus on the tab bar; the run key is the editor's.
      await editor.click();
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(spinner).toBeHidden({ timeout: 60000 });
      await expect(runs).toHaveCount(1, { timeout: 10000 });
      await runs.first().click();
      await page.getByRole('button', { name: 'Remove from history' }).click();
      await page.getByRole('button', { name: 'Confirm remove' }).click();
      await expect(runs).toHaveCount(0);
    });
  });

  // The engine sends statements, so cancelSent() interrupts one mid-run (VAK-903).
  test('Esc cancels a running query even with focus outside the editor', async ({
    bootstrappedPage: page,
  }) => {
    await page.goto('/ui/loqe');
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 90000 });
    const editor = page.locator('.cm-content').first();
    const spinner = page.getByText('Running query…');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('SELECT count(*) FROM range(100000000000)');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(spinner).toBeVisible({ timeout: 10000 });
    await page.getByText('Local Query Engine', { exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(spinner).toBeHidden({ timeout: 20000 });
  });
});
