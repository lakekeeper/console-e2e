#!/usr/bin/env node
/**
 * Give OLD history archives a dashboard. Runs before history snapshots existed
 * kept only the merged Playwright report, but its index.html embeds the report
 * data as a base64 zip — every test's outcome per project. Unpack that, rewrite
 * it into the JSON-reporter shape dashboard.mjs reads (history/<run>/results/),
 * then render history/<run>/dashboard.html.
 *
 * Skips archives that already have results/. Archives from before the blob fix
 * only hold their run's LAST combo, so their dashboard shows that one column.
 * Usage: node history-backfill.mjs   (or `just test-history-backfill`)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const historyDir = path.join(dir, 'history');
const runs = fs.existsSync(historyDir)
  ? fs
      .readdirSync(historyDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

let done = 0;
for (const run of runs.sort()) {
  const archive = path.join(historyDir, run);
  const resultsDir = path.join(archive, 'results');
  const indexHtml = path.join(archive, 'index.html');
  if (fs.existsSync(resultsDir) || !fs.existsSync(indexHtml)) continue;

  const m = fs.readFileSync(indexHtml, 'utf8').match(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/);
  if (!m) {
    console.log(`➖ ${run}: no embedded report data`);
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-backfill-'));
  try {
    fs.writeFileSync(path.join(tmp, 'report.zip'), Buffer.from(m[1], 'base64'));
    const unz = spawnSync('unzip', ['-q', '-o', 'report.zip'], { cwd: tmp });
    if (unz.status !== 0) throw new Error(`unzip failed: ${unz.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8'));
    const startTime = new Date(report.startTime).toISOString();

    // project -> file -> specs[]  (JSON-reporter shape: suites[].specs[].tests[0].status)
    const byProject = {};
    for (const f of report.files) {
      const detail = JSON.parse(fs.readFileSync(path.join(tmp, `${f.fileId}.json`), 'utf8'));
      for (const t of detail.tests) {
        const file = t.location?.file || f.fileName;
        ((byProject[t.projectName] ||= {})[file] ||= []).push({
          title: t.title,
          file,
          ok: t.ok,
          tests: [{ status: t.outcome }],
        });
      }
    }

    fs.mkdirSync(resultsDir, { recursive: true });
    for (const [project, files] of Object.entries(byProject)) {
      const suites = Object.entries(files).map(([file, specs]) => ({
        title: file,
        file,
        specs,
        suites: [],
      }));
      fs.writeFileSync(path.join(resultsDir, `${project}.json`), JSON.stringify({ config: { projects: [{ name: project }] }, stats: { startTime }, suites }));
    }
    spawnSync('node', ['dashboard.mjs', '--results', resultsDir, '--out', path.join(archive, 'dashboard.html')], {
      cwd: dir,
      stdio: 'inherit',
    });
    console.log(`✅ ${run}: ${Object.keys(byProject).join(', ')}`);
    done++;
  } catch (e) {
    console.log(`✗ ${run}: ${e.message}`);
    fs.rmSync(resultsDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`${done} archive(s) backfilled.`);
