import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Shared, non-secret config (images, paths, ports, test users).
dotenv.config({ path: path.resolve(dir, '.env') });
// Optional secrets (cedar license etc.).
dotenv.config({ path: path.resolve(dir, '.env.secret') });

const mode = process.env.TEST_MODE || 'authn';
const app = process.env.APP || 'console';
const port = process.env.APP_PORT || '5001';
// SERVED_UI: test the console EMBEDDED in the lakekeeper (plus) docker image —
// served at :8181/ui by the image itself — instead of a local npm dev server.
// Same origin for UI + API (no CORS between them); the pre-built image is
// configured via LAKEKEEPER__UI__* (no VITE_* needed). Set by `just test-matrix-docker`.
const servedUI = process.env.SERVED_UI === '1';
const baseURL = servedUI ? process.env.LK_UI_URL || 'http://localhost:8181' : `http://localhost:${port}`;
// Second app origin for the storage CORS test (a real LoQE SELECT * from a
// non-allowed origin). The AWS bucket CORS allows :3001 but not :3002.
const port2 = '3002';

// Browser dimension (3D matrix). chromium runs EVERYTHING for the mode; firefox /
// webkit run only the @smoke subset (cross-browser sanity) — the deep flows (LoQE
// DuckDB-WASM) are chromium-only. Default chromium.
const browser = process.env.BROWSER || 'chromium';
const browserDevice: Record<string, string> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};
const isCross = browser !== 'chromium';

// Theme dimension. The recurring "pane blended into its background" bug is
// invisible in dark theme and shows only on a light surface, so which theme the
// suite runs in must be deliberate — Playwright's default happened to be light,
// which is the only reason those specs were even in a position to catch it.
const theme: 'light' | 'dark' = process.env.THEME === 'dark' ? 'dark' : 'light';
// Combo key: chromium uses app-mode; firefox/webkit append the browser so their
// results land in their own columns/report.
const themeSuffix = theme === 'dark' ? '-dark' : '';
const combo = (isCross ? `${app}-${mode}-${browser}` : `${app}-${mode}`) + themeSuffix;

// Resolve which app to serve.
const appDir =
  app === 'console-plus'
    ? process.env.CONSOLE_PLUS_DIR || path.resolve(dir, '../console-plus')
    : process.env.CONSOLE_DIR || path.resolve(dir, '../console');

// Pull the VITE_* vars for this mode and forward them to the dev server, where
// they override the app's own .env via Vite's process.env precedence.
// run.mjs writes a generated copy with the chosen keycloak host port
// substituted and names it in MODE_ENV_FILE; the frontend's VITE_IDP_AUTHORITY
// has to agree with the port compose published, or login silently targets a
// keycloak that is not there.
const modeEnvFile = process.env.MODE_ENV_FILE || `${mode}.env`;
const modeEnv = dotenv.parse(fs.readFileSync(path.resolve(dir, 'modes', modeEnvFile)));
const viteEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(modeEnv)) {
  if (k.startsWith('VITE_')) viteEnv[k] = v;
}

export default defineConfig({
  testDir: './specs',
  // Parallel ACROSS files, serial WITHIN one: several specs tell an ordered
  // story inside a file (access-control grants then reads, then revokes in
  // afterEach), and per-test projects isolate files from each other but not a
  // file from itself.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.E2E_RETRIES ? Number(process.env.E2E_RETRIES) : 2, // absorb OIDC/token races
  // Opt-in: E2E_WORKERS=3. Not per-CPU — the limit is memory, since each LoQE
  // spec loads DuckDB-WASM into its own browser on a 9GB VM. Default stays 1 so
  // the serial baseline is what runs unless asked otherwise.
  workers: Number(process.env.E2E_WORKERS || 1),
  expect: { timeout: 10_000 },
  // Fixture setup counts against the test timeout, and a spec's own
  // test.setTimeout() runs too late to cover it — the per-test project the
  // bootstrappedPage fixture creates timed out at the 30s default.
  timeout: 120_000,
  reporter: [
    ['list'],
    // Per-combo HTML (kept for drill-down).
    ['html', { outputFolder: `reports/${combo}`, open: 'never' }],
    // Blob → merged into ONE central report across all combos by run.mjs.
    ['blob', { outputDir: path.resolve(dir, 'blob-report'), fileName: `${combo}.zip` }],
    // JSON → consumed by dashboard.mjs to build the matrix dashboard.
    ['json', { outputFile: path.resolve(dir, 'results', `${combo}.json`) }],
    // Writes the currently-running test to results/current.json so the dashboard
    // banner can show the live test name (polled client-side). Bulletproof.
    ['./reporters/current.mjs', { combo }],
    // V8 code coverage (E2E_COVERAGE=1, chromium only — see the _coverage fixture).
    // Maps browser coverage back to console-components/console source via sourcemaps
    // (console-components must be built with --sourcemap; see `just test-coverage`).
    ...(process.env.E2E_COVERAGE === '1' && browser === 'chromium'
      ? ([
          [
            'monocart-reporter',
            {
              name: `LoQE E2E coverage — ${combo}`,
              outputFile: path.resolve(dir, 'coverage', combo, 'index.html'),
              coverage: {
                // raw V8 dumps too, so run.mjs can MERGE all chromium combos into
                // one matrix-wide coverage report.
                reports: [['v8'], ['raw', { outputDir: path.resolve(dir, 'coverage', '.raw', combo) }]],
                entryFilter: (entry: { url: string }) =>
                  !entry.url.includes('duckdb') &&
                  (entry.url.includes('console-components') || entry.url.includes('localhost:3001')),
                sourceFilter: (sourcePath: string) =>
                  /(console-components|console-plus|console)\/src\//.test(sourcePath),
              },
            },
          ],
        ] as ReporterDescription[])
      : []),
  ],
  // chromium: run all specs tagged for the active mode (e.g. @authz). firefox/webkit:
  // run only the cross-browser @smoke subset. E2E_ALL=1 (just ui) browses everything.
  // chromium + firefox run the FULL mode suite (firefox is tested like chrome).
  // webkit runs only the @smoke subset (Safari/WebKit DuckDB-WASM support is limited).
  // All three browsers run the FULL mode suite. webkit was @smoke-only because
  // DuckDB-WASM support in Safari/WebKit is limited; WEBKIT_SMOKE_ONLY=1 puts
  // that back if its LoQE specs turn out to be unusable rather than merely slow.
  grep: process.env.E2E_ALL
    ? undefined
    : browser === 'webkit' && process.env.WEBKIT_SMOKE_ONLY === '1'
      ? new RegExp(`@smoke\\b`)
      : new RegExp(`@${mode}\\b`),
  // Served-UI has no second (:3002) app instance, so the storage-CORS negative
  // test can't run — and Silo's wildcard CORS makes it moot anyway. Exclude it.
  grepInvert: servedUI ? /storage CORS/ : undefined,

  use: {
    baseURL,
    colorScheme: theme,
    // Cap every action (click/fill/check). Without this a stuck click waits out the
    // whole test timeout (we saw a firefox grant-UI click hang the full 5 min before
    // retrying). 20s is generous for a real click but fails a hung one fast so the
    // retry kicks in within seconds, not minutes.
    actionTimeout: 20_000,
    // Trace = full step-by-step DOM/console/network timeline (the richest debug
    // view); kept to retries to stay light. Flip to 'on' for a full demo capture.
    trace: 'on-first-retry',
    // Screenshot + video for EVERY test (pass or fail), so the central report is
    // a visual record of each flow. For CI you can switch these back to
    // 'only-on-failure' / 'retain-on-failure' to save disk + time.
    screenshot: 'on',
    video: process.env.E2E_LIGHT ? 'retain-on-failure' : 'on',
  },

  projects: [
    {
      name: combo,
      use: { ...devices[browserDevice[browser]] },
    },
  ],

  // Served-UI: no dev server — the lakekeeper docker image already serves the
  // console at baseURL. Everything else (specs, fixtures) is unchanged.
  webServer: servedUI ? [] : [
    {
      // dev:test hardcodes :5001 — pass the port explicitly so APP_PORT wins
      // (e.g. :3001, which the AWS bucket's CORS allows for browser→S3 in LoQE).
      // --strictPort: FAIL if the port is taken instead of silently bumping to
      // 3002+ (which would change the browser origin and break the bucket CORS).
      command: `npm run dev -- --port ${port} --strictPort`,
      cwd: appDir,
      url: baseURL,
      // Never reuse: each (app × mode) combo needs its own server with mode-specific
      // VITE_* env. Reusing would bleed the previous combo's app/config across runs.
      // REUSE_SERVER=1 keeps an already-running dev server, for iterating on a
      // single spec against a stack that is already up (`node run.mjs --up`).
      reuseExistingServer: process.env.REUSE_SERVER === '1',
      timeout: 120_000,
      env: viteEnv,
    },
    // A SECOND app instance on :3002, only in authn mode — used by the storage CORS
    // test to prove a real LoQE `SELECT *` works from :3001 (bucket CORS allows it)
    // but is BLOCKED from :3002 (different origin → the in-app Query Error / CORS box).
    // Every browser, not just chromium/firefox: webkit used to run @smoke only,
    // so storage/cors.spec.ts never executed there and the second origin was
    // pointless. Now that webkit runs the full suite the spec DOES run, and
    // without this server its ":3002 is blocked" half cannot be tested — the
    // query fails for the trivial reason that nothing is listening.
    ...(mode === 'authn'
      ? [
          {
            command: `npm run dev -- --port ${port2} --strictPort`,
            cwd: appDir,
            url: `http://localhost:${port2}`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: viteEnv,
          },
        ]
      : []),
  ],
});
