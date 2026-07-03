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
// Combo key: chromium uses app-mode; firefox/webkit append the browser so their
// results land in their own columns/report.
const combo = isCross ? `${app}-${mode}-${browser}` : `${app}-${mode}`;

// Resolve which app to serve.
const appDir =
  app === 'console-plus'
    ? process.env.CONSOLE_PLUS_DIR || path.resolve(dir, '../console-plus')
    : process.env.CONSOLE_DIR || path.resolve(dir, '../console');

// Pull the VITE_* vars for this mode and forward them to the dev server, where
// they override the app's own .env via Vite's process.env precedence.
const modeEnv = dotenv.parse(fs.readFileSync(path.resolve(dir, `modes/${mode}.env`)));
const viteEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(modeEnv)) {
  if (k.startsWith('VITE_')) viteEnv[k] = v;
}

export default defineConfig({
  testDir: './specs',
  fullyParallel: false, // one backend on a fixed port → keep app state deterministic
  forbidOnly: !!process.env.CI,
  retries: process.env.E2E_RETRIES ? Number(process.env.E2E_RETRIES) : 2, // absorb OIDC/token races
  workers: 1,
  expect: { timeout: 10_000 },
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
  grep: process.env.E2E_ALL
    ? undefined
    : browser === 'webkit'
      ? new RegExp(`@smoke\\b`)
      : new RegExp(`@${mode}\\b`),
  // Served-UI has no second (:3002) app instance, so the storage-CORS negative
  // test can't run — and SeaweedFS' wildcard CORS makes it moot anyway. Exclude it.
  grepInvert: servedUI ? /storage CORS/ : undefined,

  use: {
    baseURL,
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
      reuseExistingServer: false,
      timeout: 120_000,
      env: viteEnv,
    },
    // A SECOND app instance on :3002, only in authn mode — used by the storage CORS
    // test to prove a real LoQE `SELECT *` works from :3001 (bucket CORS allows it)
    // but is BLOCKED from :3002 (different origin → the in-app Query Error / CORS box).
    ...(mode === 'authn' && browser !== 'webkit'
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
