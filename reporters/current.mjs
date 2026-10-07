import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Live progress for the dashboard. Two files, both removed when the run ends:
//
// - results/current.json — the test running now, for the "run in progress" banner
//   (the dashboard polls it client-side).
// - results/<combo>.live.json — every test of the combo with its status so far
//   (pending → running → passed / failed / flaky / skipped). The JSON reporter
//   writes results/<combo>.json only once the whole combo is done, so without
//   this a column stays empty for the length of the combo. After each test the
//   dashboard is rebuilt, and its column fills in row by row.
//
// Everything is wrapped in try/catch so it can never break a test run.
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const resultsDir = path.join(root, 'results');
const currentFile = path.join(resultsDir, 'current.json');

export default class CurrentTestReporter {
  constructor(opts = {}) {
    this.combo = opts.combo || `${process.env.APP || 'console'}-${process.env.TEST_MODE || 'authn'}`;
    this.liveFile = path.join(resultsDir, `${this.combo}.live.json`);
    this.live = null;
    this.rootDir = root;
  }

  /** The dashboard's row key: file relative to the test dir, then the test title. */
  key(test) {
    const rel = test.location?.file ? path.relative(this.rootDir, test.location.file) : '';
    return `${rel} › ${test.title}`;
  }

  writeLive() {
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(this.liveFile, JSON.stringify(this.live));
    } catch {
      /* never break the run */
    }
  }

  rebuildDashboard() {
    try {
      spawnSync('node', ['dashboard.mjs'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, RUN_IN_PROGRESS: '1', RUN_CURRENT: process.env.RUN_CURRENT || this.combo },
        timeout: 20000,
      });
    } catch {
      /* never break the run */
    }
  }

  onBegin(config, suite) {
    try {
      this.rootDir = config.rootDir || root;
      const tests = {};
      for (const t of suite.allTests()) tests[this.key(t)] = 'pending';
      this.live = {
        combo: this.combo,
        metadata: config.metadata || {},
        startTime: new Date().toISOString(),
        tests,
      };
      this.writeLive();
      this.rebuildDashboard();
    } catch {
      /* never break the run */
    }
  }

  onTestBegin(test) {
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      const rel = test.location?.file ? path.relative(root, test.location.file) : '';
      // titlePath() = [project, file, ...describes, test]; keep describes + test.
      const title = test.titlePath().filter(Boolean).slice(2).join(' › ') || test.title;
      fs.writeFileSync(currentFile, JSON.stringify({ combo: this.combo, file: rel, test: title, ts: Date.now() }));
      if (this.live) {
        this.live.tests[this.key(test)] = 'running';
        this.writeLive();
      }
    } catch {
      /* never break the run */
    }
  }

  onTestEnd(test, result) {
    try {
      if (!this.live) return;
      const outcome = test.outcome(); // expected | unexpected | flaky | skipped
      let status;
      if (outcome === 'expected') status = 'passed';
      else if (outcome === 'flaky') status = 'flaky';
      else if (outcome === 'skipped') status = 'skipped';
      // A failed attempt with retries left is not the verdict yet.
      else status = result.retry < test.retries ? 'retrying' : 'failed';
      this.live.tests[this.key(test)] = status;
      this.writeLive();
      this.rebuildDashboard();
    } catch {
      /* never break the run */
    }
  }

  onEnd() {
    // The JSON reporter's results/<combo>.json now holds the verdict.
    for (const f of [currentFile, this.liveFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
