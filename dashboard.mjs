#!/usr/bin/env node
/**
 * Matrix dashboard — ONE page showing every test × every app×mode with the
 * LATEST pass/fail, accumulated across runs (it does NOT shrink on a partial run).
 *
 * Reads results/<app>-<mode>.json (Playwright JSON reporter output; one file per
 * combo, overwritten only when that combo runs) and renders DASHBOARD.html.
 * Each column header shows when that combo last ran, so stale cells are visible.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(dir, 'results');
const files = fs.existsSync(resultsDir)
  ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json') && f !== 'current.json' && !f.startsWith('unit'))
  : []; // current.json (live marker) + unit*.json (component unit tests) are not combos

// Component unit tests (Vitest), written by run.mjs runUnitTests() → results/unit.json.
let unit = [];
try {
  unit = JSON.parse(fs.readFileSync(path.join(resultsDir, 'unit.json'), 'utf8'));
} catch {
  /* no unit results yet */
}

const combos = {}; // combo -> { startTime, tests: Map(key->status) }
const allTests = new Map(); // key -> { file, title }

function statusOf(spec) {
  const t = spec.tests?.[0];
  const s = t?.status; // expected | unexpected | flaky | skipped
  if (s === 'expected') return 'passed';
  if (s === 'unexpected') return 'failed';
  if (s === 'flaky') return 'flaky';
  if (s === 'skipped') return 'skipped';
  return spec.ok ? 'passed' : 'failed';
}

function walk(suite, combo, fileHint) {
  const file = suite.file || fileHint;
  for (const spec of suite.specs || []) {
    const f = spec.file || file;
    const key = `${f} › ${spec.title}`;
    allTests.set(key, { file: f, title: spec.title });
    combos[combo].tests.set(key, statusOf(spec));
  }
  for (const s of suite.suites || []) walk(s, combo, file);
}

for (const f of files) {
  const combo = f.replace(/\.json$/, '');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
  } catch {
    continue;
  }
  combos[combo] = { startTime: data.stats?.startTime || null, tests: new Map() };
  for (const s of data.suites || []) walk(s, combo, null);
}

const comboNames = Object.keys(combos).sort();
// Preserve definition order (Playwright reports specs in file order), NOT alpha.
const testKeys = [...allTests.keys()];

// Logical journey order for the spec files (a user's real flow), not alphabetical.
const SPEC_ORDER = [
  'bootstrap/bootstrap',
  'auth/login',
  'auth/noauth-access',
  'auth/logout',
  'smoke/route-smoke',
  'flows/warehouse-lifecycle',
  'flows/loqe',
  'flows/warehouse',
  'flows/role',
  'perms/access-control',
  'storage/cors',
];
const orderOf = (file) => {
  const i = SPEC_ORDER.findIndex((s) => file.includes(s));
  return i === -1 ? SPEC_ORDER.length : i;
};

// Human label per mode — makes explicit that authZ has TWO backends (OpenFGA,
// Cedar); both are "authZ on", just different authorizers.
const MODE_LABEL = {
  noauth: 'authN ✗ · authZ ✗',
  authn: 'authN ✓ · authZ ✗',
  authz: 'authN ✓ · authZ OpenFGA',
  cedar: 'authN ✓ · authZ Cedar',
  // Cross-browser @smoke columns (combo = <app>-authn-<browser>).
  firefox: 'Firefox · @smoke',
  webkit: 'Safari/WebKit · @smoke',
};
// Combo key is <app>-<mode> or <app>-<mode>-<browser>; the trailing segment is the
// label key in both cases (browser for cross-browser columns, else the mode).
const modeOf = (combo) => combo.split('-').pop();

const ICON = {
  passed: '<span class="p">✅</span>',
  failed: '<span class="f">❌</span>',
  flaky: '<span class="k">⚠️</span>',
  skipped: '<span class="s">➖</span>',
};
const cell = (st) => (st ? ICON[st] || st : '<span class="na">·</span>');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// group rows by file
const byFile = {};
for (const k of testKeys) {
  const { file, title } = allTests.get(k);
  (byFile[file] ||= []).push({ key: k, title });
}

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// per-combo tallies
const tally = (combo) => {
  let p = 0, f = 0, k = 0, s = 0;
  for (const st of combos[combo].tests.values()) {
    if (st === 'passed') p++;
    else if (st === 'failed') f++;
    else if (st === 'flaky') k++;
    else if (st === 'skipped') s++;
  }
  return { p, f, k, s };
};

const header =
  `<tr><th class="rowh">Test</th>` +
  comboNames
    .map((c) => {
      const t = tally(c);
      const cls = t.f ? 'colfail' : 'colok';
      // Link the column to that combo's NATIVE Playwright report (drill into
      // traces/video/screenshots). Served from the same dir as this dashboard.
      const link = `reports/${c}/index.html`;
      const label = MODE_LABEL[modeOf(c)] || '';
      return `<th class="${cls}"><a href="${link}" target="_blank" title="Open ${esc(c)} Playwright report">${esc(c)} ↗</a><div class="meta">${esc(label)}<br>${t.p}✅ ${t.f}❌${t.k ? ` ${t.k}⚠️` : ''}${t.s ? ` ${t.s}➖` : ''} · ${fmt(combos[c].startTime)}</div></th>`;
    })
    .join('') +
  `</tr>`;

const rows = Object.keys(byFile)
  .sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b))
  .map((file) => {
    const fileRow = `<tr class="filerow"><td colspan="${comboNames.length + 1}">${esc(file)}</td></tr>`;
    const testRows = byFile[file]
      .map((t) => {
        const cells = comboNames.map((c) => `<td class="c">${cell(combos[c].tests.get(t.key))}</td>`).join('');
        return `<tr><td class="rowh">${esc(t.title)}</td>${cells}</tr>`;
      })
      .join('');
    return fileRow + testRows;
  })
  .join('');

const totalP = comboNames.reduce((a, c) => a + tally(c).p, 0);
const totalF = comboNames.reduce((a, c) => a + tally(c).f, 0);

// Run-in-progress state (run.mjs sets these while a run is active). When running,
// refresh faster and show a clear "in progress" banner so the matrix isn't
// mistaken for the final result.
const running = !!process.env.RUN_IN_PROGRESS;
const runCurrent = process.env.RUN_CURRENT || '';
const refreshSecs = running ? 8 : 60;
const runBanner = running
  ? `<div class="banner run">⏳ Test run IN PROGRESS${runCurrent ? ` — now running <b>${esc(runCurrent)}</b>` : ''}<div id="curtest" class="curtest"></div><div class="runsub">columns fill in as combos finish (auto-refreshing every ${refreshSecs}s). Results below are not final.</div></div>`
  : '';
// Client-side poll of results/current.json (written by reporters/current.mjs) so the
// banner shows the live test name BETWEEN the per-combo HTML rebuilds.
const livePoll = running
  ? `<script>
(function(){
  function tick(){
    fetch('results/current.json?t='+Date.now()).then(function(r){return r.ok?r.json():null;}).then(function(d){
      var el=document.getElementById('curtest'); if(!el)return;
      el.textContent = d&&d.test ? ('▶ '+(d.file?d.file.replace('specs/','')+' › ':'')+d.test) : '';
    }).catch(function(){});
  }
  tick(); setInterval(tick, 2000);
})();
</script>`
  : '';

const html = `<!doctype html><meta charset="utf-8"><title>Test Matrix Dashboard</title>
<meta http-equiv="refresh" content="${refreshSecs}">
<style>
 body{font:13px/1.45 system-ui,sans-serif;margin:1.5rem;color:#1a1a2e}
 h1{margin:0 0 .25rem} .sub{color:#667;margin:0 0 1rem}
 .tablewrap{max-height:74vh;overflow:auto;border:1px solid #e3e3ef;border-radius:8px;width:fit-content;max-width:100%}
 table{border-collapse:separate;border-spacing:0;font-size:12px}
 th,td{border-right:1px solid #e3e3ef;border-bottom:1px solid #e3e3ef;padding:5px 9px}
 /* frozen header row */
 th{background:#f6f6fb;position:sticky;top:0;z-index:2}
 /* frozen first column (Test name) */
 .rowh{text-align:left;max-width:340px;position:sticky;left:0;background:#fff;z-index:1}
 th.rowh{z-index:3;background:#f6f6fb} /* top-left corner: above both */
 td.c{text-align:center;font-size:14px} .meta{font-weight:400;color:#778;font-size:10px;margin-top:2px}
 .colfail{background:#fdecec} .colok{background:#eefaf0}
 .filerow td{background:#f0f0f7;font-family:ui-monospace,monospace;color:#556;font-weight:600;position:sticky;left:0}
 .p{} .f{} .k{} .s{} .na{color:#cfd2dd}
 .banner{padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-weight:600}
 .green{background:#eefaf0;color:#1a7d44} .red{background:#fdecec;color:#b32020}
 .run{background:#ffe08a;color:#6b4500;border:3px solid #f0a500;border-radius:12px;
   font-size:1.6rem;line-height:1.35;padding:1.4rem 1.6rem;text-align:center;
   box-shadow:0 4px 18px rgba(240,165,0,.35);animation:pulse 1.4s ease-in-out infinite}
 .run b{font-size:1.7rem}
 .unit{padding:.5rem 1rem;border:1px solid #e3e3ef;border-radius:8px;margin-bottom:1rem;font-size:12px}
 .u-ok{color:#1a7d44} .u-fail{color:#b32020} .u-skip{color:#888}
 .curtest{font-size:1rem;font-weight:600;color:#7a4d00;margin-top:.5rem;font-family:ui-monospace,monospace;min-height:1.2em}
 .runsub{font-size:.95rem;font-weight:400;margin-top:.4rem}
 @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(240,165,0,.55)}50%{box-shadow:0 0 0 10px rgba(240,165,0,0)}}
</style>
<h1>Test Matrix Dashboard</h1>
<p class="sub">Every test × every app·mode. Latest result per combo (accumulates across runs — partial runs only update their own columns). Auto-refreshes every 30s. ✅ pass · ❌ fail · ⚠️ flaky · ➖ skipped/n-a · · not run in that mode.<br>
Click a <b>combo column ↗</b> to open its native Playwright report (traces/video). Full merged report: <a href="playwright-report/index.html" target="_blank">playwright-report ↗</a>.</p>
${runBanner}<div class="banner ${totalF ? 'red' : 'green'}">${totalF ? `❌ ${totalF} failing across the matrix` : `✅ all ${totalP} executed checks green`} — ${comboNames.length} combos.</div>
${
  unit.length
    ? `<div class="unit"><b>Component unit tests (Vitest)</b> — run once per matrix, browser-independent:${unit
        .map((u) =>
          u.skipped
            ? ` <span class="u-skip">➖ ${esc(u.repo)} (${esc(u.skipped)})</span>`
            : ` <span class="${u.failed ? 'u-fail' : 'u-ok'}">${u.failed ? '❌' : '✅'} ${esc(u.repo)} ${u.passed}/${u.total}</span>`,
        )
        .join(' · ')}</div>`
    : ''
}
${comboNames.length ? `<div class="tablewrap"><table>${header}${rows}</table></div>` : '<p>No results yet — run <code>just test-matrix</code>.</p>'}
${livePoll}`;

fs.writeFileSync(path.join(dir, 'DASHBOARD.html'), html);
console.log(`Matrix dashboard → console-e2e/DASHBOARD.html (${comboNames.length} combos, ${testKeys.length} tests, ${totalF} failing)`);
