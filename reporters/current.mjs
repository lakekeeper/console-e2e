import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny Playwright reporter: records the currently-running test to
// results/current.json so the dashboard's "run in progress" banner can show the
// live test name (the dashboard polls this file client-side). Everything is wrapped
// in try/catch so it can never break a test run.
const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(dir, '../results/current.json');

export default class CurrentTestReporter {
  constructor(opts = {}) {
    this.combo = opts.combo || `${process.env.APP || 'console'}-${process.env.TEST_MODE || 'authn'}`;
  }

  onTestBegin(test) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rel = test.location?.file ? path.relative(path.resolve(dir, '..'), test.location.file) : '';
      // titlePath() = [project, file, ...describes, test]; keep describes + test.
      const title = test.titlePath().filter(Boolean).slice(2).join(' › ') || test.title;
      fs.writeFileSync(file, JSON.stringify({ combo: this.combo, file: rel, test: title, ts: Date.now() }));
    } catch {
      /* never break the run */
    }
  }

  onEnd() {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
