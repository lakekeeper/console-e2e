#!/usr/bin/env node
/**
 * E2E matrix orchestrator.
 *
 * For each (app × mode) combo, serially:
 *   1. tear down + bring up the backend stack for that mode
 *   2. run lakekeeper migrate, then serve; wait for readiness
 *   3. run Playwright (which launches the app's dev server with mode env)
 *   4. tear down
 *
 * Usage:
 *   node run.mjs                          # all apps × all modes
 *   node run.mjs --app console --mode authn
 *   node run.mjs --mode noauth,authn      # subset of modes, both apps
 *   node run.mjs --app console-plus --mode cedar
 *   node run.mjs --keep                   # leave the last stack running
 *   node run.mjs --grep @smoke            # extra Playwright grep filter
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = {
  ...dotenv.parse(fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env')) : ''),
  ...dotenv.parse(fs.existsSync(path.join(dir, '.env.secret')) ? fs.readFileSync(path.join(dir, '.env.secret')) : ''),
  ...process.env,
};

// Local SeaweedFS S3 must be reachable from BOTH the browser (host) and the
// lakekeeper container — the host LAN IP satisfies both (localhost fails in the
// container; the compose hostname fails in the browser). Auto-detect it.
function hostLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}
// Published on a non-default host port (8334, not 8333) so the e2e SeaweedFS
// coexists with a locally-running dev stack that already owns :8333 — otherwise
// the container can't bind the port and the seaweedfs journey fails. The
// container still listens on 8333 internally; only the host mapping moves.
const s3Port = env.S3_LOCAL_HOST_PORT || '8334';
env.S3_LOCAL_HOST_PORT = s3Port;
if (!env.S3_LOCAL_ENDPOINT) {
  const ip = hostLanIp();
  if (ip) env.S3_LOCAL_ENDPOINT = `http://${ip}:${s3Port}`;
}

const ALL_APPS = ['console', 'console-plus'];
const ALL_MODES = ['noauth', 'authn', 'authz', 'cedar'];
// Per-app supported modes. Cedar is a PREMIUM authorizer → console-plus only;
// the OSS `console` never runs cedar.
const APP_MODES = {
  console: ['noauth', 'authn', 'authz'],
  'console-plus': ['noauth', 'authn', 'authz', 'cedar'],
};
// Which backend services each mode needs (migrate + lakekeeper always added).
const SERVICES = {
  noauth: ['postgres', 'seaweedfs', 'bucket-init'],
  authn: ['postgres', 'keycloak', 'seaweedfs', 'bucket-init'],
  authz: ['postgres', 'openfga', 'keycloak', 'seaweedfs', 'bucket-init'],
  cedar: ['postgres', 'keycloak', 'seaweedfs', 'bucket-init'],
};

// --- arg parsing ---
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
// SERVED_UI: test the console EMBEDDED in the pushed lakekeeper-plus docker image
// (served at :8181/ui by the image) instead of a local npm dev server. One
// pseudo-app "docker": the image ships the plus console + supports every mode, so
// we don't split by app or filter by APP_MODES. Playwright reads SERVED_UI too
// (skips its webServer, points baseURL at :8181).
const servedUI = env.SERVED_UI === '1';
// Docker matrix drives the full local LoQE read/write flow against seaweed (STS +
// wildcard CORS make it browser-usable, no AWS). Turn seaweed deep flows on here so
// storage-backends.ts flips deepFlows for the seaweedfs backend — the npm matrix,
// which never sets this, keeps its historical create+verify behavior.
if (servedUI && !env.S3_LOCAL_DEEP) env.S3_LOCAL_DEEP = '1';
// Pinned pushed image under test; override with LK_IMAGE_DOCKER in .env.
const LK_IMAGE_DOCKER =
  env.LK_IMAGE_DOCKER || 'quay.io/vakamo/lakekeeper-plus:d731e0e6-distroless-arm64';
const apps = servedUI ? ['docker'] : (opt('--app') || ALL_APPS.join(',')).split(',').filter(Boolean);
const modes = (opt('--mode') || ALL_MODES.join(',')).split(',').filter(Boolean);
const extraGrep = opt('--grep');
const keep = has('--keep');
const upOnly = has('--up'); // bring the stack up and leave it running (for test-ui)

const HEALTH = 'http://localhost:8181/health';
const KC_DISCOVERY = 'http://localhost:30080/realms/iceberg/.well-known/openid-configuration';

// Rebuild DASHBOARD.html. Pass {RUN_IN_PROGRESS:'1', RUN_CURRENT} while a run is
// active so the page shows an "in progress" banner and refreshes fast; omit at
// the end to clear it. Columns fill live as each combo finishes.
const buildDashboard = (extra = {}) =>
  spawnSync('node', ['dashboard.mjs'], { cwd: dir, stdio: 'ignore', env: { ...env, ...extra } });

// Container engine. `docker` here is a shell alias to podman (invisible to
// spawn), and the standalone docker-compose binary targets the wrong socket, so
// we drive compose via `podman compose` which wires up podman's own socket.
// Override with COMPOSE_BIN (+ COMPOSE_SUBCMD) for a real docker install.
const COMPOSE_BIN = process.env.COMPOSE_BIN || 'podman';
const COMPOSE_PREFIX = process.env.COMPOSE_SUBCMD === '' ? [] : [process.env.COMPOSE_SUBCMD || 'compose'];
// `--env-file /dev/null` stops compose from auto-reading the project .env for
// ${VAR} interpolation — all the vars compose needs (LK_IMAGE, TEST_MODE, paths,
// license) are already in the spawn env below. This makes compose immune to typos
// or quoting issues in the user's .env / secret entries.
const compose = (composeArgs, extraEnv = {}) =>
  spawnSync(
    COMPOSE_BIN,
    [...COMPOSE_PREFIX, '--env-file', '/dev/null', '-f', path.join(dir, 'docker-compose.yml'), ...composeArgs],
    {
      cwd: dir,
      stdio: 'inherit',
      env: { ...env, ...extraEnv },
    },
  );

async function waitFor(label, url, { timeoutMs = 120_000, expectOk = true } = {}) {
  const start = Date.now();
  process.stdout.write(`⏳ waiting for ${label} `);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (!expectOk || res.ok) {
        console.log(`✓ (${Math.round((Date.now() - start) / 1000)}s)`);
        return true;
      }
    } catch {
      /* not up yet */
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(' ✗ timeout');
  throw new Error(`${label} not ready after ${timeoutMs}ms`);
}

function freeAppPort() {
  const port = env.APP_PORT || '5001';
  // Kill any lingering vite from a previous combo AND WAIT until the ports are
  // actually released. With reuseExistingServer:false + --strictPort, a port that
  // is still in TIME_WAIT / held by a slow-dying child makes the next combo's
  // webServer fail hard ("http://localhost:3001 is already used") and the whole
  // combo errors with CONNECTION_REFUSED. Poll up to ~8s for a clean release.
  // :3002 is the CORS test's second app instance (authn mode).
  for (let i = 0; i < 25; i++) {
    const inUse = spawnSync('bash', ['-c', `lsof -ti tcp:${port} tcp:3002 2>/dev/null`], {
      encoding: 'utf8',
    }).stdout.trim();
    if (!inUse) return;
    spawnSync('bash', ['-c', `echo "${inUse}" | xargs kill -9 2>/dev/null; sleep 0.3`], {
      stdio: 'ignore',
    });
  }
}

function runPlaywright(app, mode, browser = 'chromium') {
  freeAppPort();
  return new Promise((resolve) => {
    const pwArgs = ['playwright', 'test'];
    if (extraGrep) pwArgs.push('--grep', extraGrep);
    const child = spawn('npx', pwArgs, {
      cwd: dir,
      stdio: 'inherit',
      env: { ...env, APP: app, TEST_MODE: mode, BROWSER: browser },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// Component-repo UNIT tests (Vitest). Browser/mode-independent, so run ONCE per
// matrix (not per combo). Writes results/unit.json for the dashboard. Skips a repo
// that has no `test` script / no test files. This is the Tier-0 guard (e.g. the
// authToken/currentAccessToken fix for the Bearer-undefined bug).
function runUnitTests() {
  const repos = ['console-components', 'console-plus-components'];
  const out = [];
  for (const name of repos) {
    const repoDir = path.resolve(dir, '..', name);
    const pkgPath = path.join(repoDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.test) {
      out.push({ repo: name, skipped: 'no test script' });
      continue;
    }
    const jsonFile = path.join(dir, 'results', `unit-${name}.json`);
    console.log(`\n▶ unit tests · ${name}`);
    const res = spawnSync('npm', ['test', '--', '--reporter=json', `--outputFile=${jsonFile}`], {
      cwd: repoDir,
      stdio: 'inherit',
      env,
    });
    let passed = 0, failed = 0, total = 0;
    try {
      const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      passed = j.numPassedTests ?? 0;
      failed = j.numFailedTests ?? 0;
      total = j.numTotalTests ?? passed + failed;
    } catch { /* no parsable output (e.g. no test files) */ }
    out.push({ repo: name, passed, failed, total, code: res.status ?? 1 });
  }
  fs.writeFileSync(path.join(dir, 'results', 'unit.json'), JSON.stringify(out, null, 2));
  return out;
}

const results = [];

// Fresh blob dir — each combo drops a blob here; merged into one report at the end.
fs.rmSync(path.join(dir, 'blob-report'), { recursive: true, force: true });
// Drop the previous run's Playwright artifacts (screenshots/traces/DOM snapshots).
// Playwright already wipes test-results per `playwright test`, so mid-matrix it only
// ever holds the LAST combo — clearing here makes a fresh run start truly clean and
// avoids stale dirs from a prior session confusing diagnosis.
fs.rmSync(path.join(dir, 'test-results'), { recursive: true, force: true });
// Show only THIS run on the dashboard: drop prior runs' per-combo result JSONs so the
// matrix reflects the current invocation's combos, not an accumulation across sessions
// (past runs stay fully browsable via the history/ dropdown). Keep unit*.json (rewritten
// by runUnitTests when it runs; preserved for --grep/--up runs) and current.json (live
// marker). Skipped for --up (brings the stack up without running tests).
if (!upOnly) {
  const resultsDir = path.join(dir, 'results');
  for (const f of fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir) : []) {
    if (f.endsWith('.json') && !f.startsWith('unit') && f !== 'current.json') {
      fs.rmSync(path.join(resultsDir, f), { force: true });
    }
  }
}

// Show "run in progress" on the dashboard immediately (over last run's data).
if (!upOnly) buildDashboard({ RUN_IN_PROGRESS: '1' });

// Component unit tests once up front (fast, browser-independent). Skipped for --up
// and when filtering to a grep (those are targeted e2e iterations).
let unitResults = [];
if (!upOnly && !extraGrep && !env.NO_UNIT) {
  unitResults = runUnitTests();
  buildDashboard({ RUN_IN_PROGRESS: '1' });
}

for (const app of apps) {
  for (const mode of modes) {
    if (!ALL_MODES.includes(mode)) {
      console.error(`⚠️  unknown mode "${mode}" — skipping`);
      continue;
    }
    if (!servedUI && !APP_MODES[app]?.includes(mode)) {
      console.log(`↳ ${app} does not support ${mode} (cedar is console-plus only) — skipping`);
      continue;
    }
    const lkImage = servedUI
      ? LK_IMAGE_DOCKER
      : mode === 'cedar'
        ? env.LK_IMAGE_PLUS
        : env.LK_IMAGE_OSS;
    const stackEnv = { TEST_MODE: mode, LK_IMAGE: lkImage };

    console.log(`\n${'='.repeat(70)}\n▶ ${app} · ${mode}  (image: ${lkImage})\n${'='.repeat(70)}`);

    // The plus image is licensed software → every mode needs the key, not just cedar.
    if ((mode === 'cedar' || servedUI) && !env.LAKEKEEPER__LICENSE__KEY) {
      console.error(
        `✗ ${servedUI ? 'docker (plus image)' : 'cedar mode'} requires LAKEKEEPER__LICENSE__KEY in e2e/.env.secret — skipping`,
      );
      results.push({ app, mode, code: -1, note: 'no license' });
      continue;
    }

    try {
      // clean slate
      compose(['down', '-v', '--remove-orphans'], stackEnv);

      // infra (postgres readiness is gated by the compose healthcheck +
      // migrate's depends_on; keycloak we poll explicitly below)
      compose(['up', '-d', ...SERVICES[mode]], stackEnv);
      if (SERVICES[mode].includes('keycloak')) {
        await waitFor('keycloak realm', KC_DISCOVERY, { timeoutMs: 240_000 });
      }

      // migrate (one-shot) then serve
      const mig = compose(['run', '--rm', 'migrate'], stackEnv);
      if (mig.status !== 0) throw new Error('migrate failed');
      compose(['up', '-d', 'lakekeeper'], stackEnv);
      await waitFor('lakekeeper', HEALTH, { timeoutMs: 120_000 });
      // Served-UI: also confirm the image is serving the embedded console before
      // Playwright (which has no dev server of its own to wait on) starts.
      if (servedUI) {
        await waitFor('console UI', `${env.LK_UI_URL || 'http://localhost:8181'}/ui/`, {
          timeoutMs: 60_000,
        });
      }

      // --up: bring the stack up and LEAVE it running (for `just test-ui` /
      // manual clicking). No tests, no teardown.
      if (upOnly) {
        console.log(`\n✅ Stack up for ${mode} (lakekeeper :8181, keycloak :30080).`);
        console.log(`   Browse/run tests:  just test-ui ${app}`);
        console.log(`   Tear down when done: just test-down`);
        process.exit(0); // exit before the finally teardown so the stack persists
      }

      // tests (Playwright boots the app dev server)
      buildDashboard({ RUN_IN_PROGRESS: '1', RUN_CURRENT: `${app}·${mode}` }); // "now running"
      const code = await runPlaywright(app, mode);
      results.push({ app, mode, code });
      buildDashboard({ RUN_IN_PROGRESS: '1' }); // column now filled, run still going

      // 3D matrix (cross-browser). The stack is up, so run extra browsers now.
      // Skip when filtering (--grep) or via NO_CROSS_BROWSER=1.
      if (!extraGrep && !env.NO_CROSS_BROWSER) {
        // firefox: FULL parity with chromium — runs the whole mode suite every
        // combo (LoQE/DuckDB-WASM works headless in firefox).
        buildDashboard({ RUN_IN_PROGRESS: '1', RUN_CURRENT: `${app}·${mode}·firefox` });
        const ff = await runPlaywright(app, mode, 'firefox');
        results.push({ app, mode: `${mode}-firefox`, code: ff });
        buildDashboard({ RUN_IN_PROGRESS: '1' });

        // webkit: @smoke only, once per app (authn) — Safari/WebKit DuckDB-WASM
        // support is limited, so deep flows stay off it.
        if (mode === 'authn') {
          buildDashboard({ RUN_IN_PROGRESS: '1', RUN_CURRENT: `${app}·${mode}·webkit` });
          const wk = await runPlaywright(app, mode, 'webkit');
          results.push({ app, mode: `${mode}-webkit`, code: wk });
          buildDashboard({ RUN_IN_PROGRESS: '1' });
        }
      }
    } catch (e) {
      console.error(`✗ ${app}·${mode}: ${e.message}`);
      results.push({ app, mode, code: 1, note: e.message });
    } finally {
      const isLast = app === apps.at(-1) && mode === modes.at(-1);
      if (!(keep && isLast)) compose(['down', '-v', '--remove-orphans'], stackEnv);
    }
  }
}

// --- summary ---
console.log(`\n${'='.repeat(70)}\nMATRIX SUMMARY\n${'='.repeat(70)}`);
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'}  ${r.app.padEnd(13)} ${r.mode.padEnd(7)} ${r.note || (ok ? '' : `exit ${r.code}`)}`);
}
console.log(`\n${results.length - failed}/${results.length} combos passed.`);

// Component unit tests (Vitest) summary.
if (unitResults.length) {
  console.log(`\n${'-'.repeat(70)}\nCOMPONENT UNIT TESTS (Vitest)\n${'-'.repeat(70)}`);
  for (const u of unitResults) {
    if (u.skipped) console.log(`➖  ${u.repo.padEnd(24)} ${u.skipped}`);
    else console.log(`${u.code === 0 ? '✅' : '❌'}  ${u.repo.padEnd(24)} ${u.passed}/${u.total} passed${u.failed ? ` (${u.failed} failed)` : ''}`);
  }
}

// Merge every combo's blob into ONE central HTML report.
if (fs.existsSync(path.join(dir, 'blob-report'))) {
  console.log('\nBuilding central report…');
  spawnSync('npx', ['playwright', 'merge-reports', '--reporter', 'html', './blob-report'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...env, PLAYWRIGHT_HTML_OPEN: 'never' },
  });

  // Archive this run under a timestamp so it's never lost when you run again.
  // `playwright-report/` is always the LATEST; `history/<stamp>/` are kept until
  // YOU delete them (nothing here auto-prunes). Stamp + scope in the folder name.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const scope =
    extraGrep || apps.length < ALL_APPS.length || modes.length < ALL_MODES.length
      ? `partial-${apps.join('+')}-${modes.join('+')}`
      : 'full';
  const archive = path.join(dir, 'history', `${stamp}__${scope}`);
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.cpSync(path.join(dir, 'playwright-report'), archive, { recursive: true });

  console.log(`📊 Latest report: e2e/playwright-report/  →  just test-report`);
  console.log(`🗄  Archived run:  e2e/history/${stamp}__${scope}/  (kept until you delete it)`);

  // Rebuild the accumulating matrix dashboard from results/ (one JSON per combo;
  // partial runs only update their own columns — the matrix never shrinks).
  spawnSync('node', ['dashboard.mjs'], { cwd: dir, stdio: 'inherit', env });
  console.log(`🧮 Matrix dashboard: e2e/DASHBOARD.html  →  just test-dashboard`);
  // Keep the catalog (what tests EXIST) in sync with the specs on every run.
  spawnSync('node', ['catalog.mjs'], { cwd: dir, stdio: 'ignore', env });
  console.log(`📚 Test catalog:     e2e/TEST-CATALOG.html  →  just test-catalog`);
  // Warn when this report is only a SUBSET (filtered/partial run) — the report
  // always reflects the LAST run, so a --grep or partial app/mode shrinks it.
  const partial = extraGrep || apps.length < ALL_APPS.length || modes.length < ALL_MODES.length;
  if (partial) {
    console.log(
      `⚠️  PARTIAL report — this run was filtered (` +
        `${apps.join(',')} × ${modes.join(',')}${extraGrep ? ` grep:"${extraGrep}"` : ''}). ` +
        `Run \`just test-matrix\` (no filter) for the full report. ` +
        `For the catalog of ALL cases: \`just test-catalog\`.`,
    );
  }
}
console.log('   Per-combo reports: e2e/reports/<app>-<mode>/');
process.exit(failed > 0 ? 1 : 0);
