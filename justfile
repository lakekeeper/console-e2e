# console-e2e test framework. Run from the console-e2e/ directory.
# All recipes are namespaced under `test-`. List them with `just --list`.

# Install deps + browser
test-setup:
    npm install
    npx playwright install chromium

# Full matrix: both apps × all modes
test-matrix:
    node run.mjs

# E2E CODE COVERAGE (chromium combos only — V8/CDP is chromium-only). Builds
# console-components WITH sourcemaps so coverage maps to real source, clears the
# apps' vite caches so the fresh dist is used, runs the chromium matrix collecting
# V8 coverage, then MERGES every combo into one report at coverage/index.html.
test-coverage:
    cd ../console-components && npx vite build --sourcemap >/dev/null
    rm -rf ../console/node_modules/.vite ../console-plus/node_modules/.vite coverage
    E2E_COVERAGE=1 NO_CROSS_BROWSER=1 node run.mjs
    npx monocart-coverage-reports --input coverage/.raw --output coverage --reports v8,console-summary
    @echo "→ open console-e2e/coverage/index.html"

# Component-repo UNIT tests (Vitest) — fast, browser-independent (the Tier-0 guard,
# e.g. the authToken/Bearer-undefined fix). Runs automatically as part of the matrix
# too; this is for running them standalone.
test-unit:
    cd ../console-components && npm test
    @cd ../console-plus-components 2>/dev/null && [ -f vitest.config.ts ] && npm test || echo "➖ console-plus-components: no unit tests yet"

# One combo, e.g. `just test-one console authn`
test-one app mode:
    node run.mjs --app {{app}} --mode {{mode}}

# One app, all modes, e.g. `just test-app console-plus`
test-app app:
    node run.mjs --app {{app}}

# One mode, both apps, e.g. `just test-mode authz`
test-mode mode:
    node run.mjs --mode {{mode}}

# CENTRAL TEST CATALOG — what test cases exist (planning view, no run).
# Writes TEST-CATALOG.md + TEST-CATALOG.html (open the .html for the visual matrix).
test-catalog:
    node catalog.mjs >/dev/null && echo "→ open console-e2e/TEST-CATALOG.html (visual)  or  TEST-CATALOG.md"

# THE matrix dashboard — every test × every app·mode, latest pass/fail,
# accumulates across runs (partial runs only update their columns). Serves it.
test-dashboard:
    node dashboard.mjs && python3 -m http.server 9325 --bind 127.0.0.1 --directory . >/dev/null 2>&1 & sleep 1 && echo "→ http://127.0.0.1:9325/DASHBOARD.html"

# List archived runs (each kept until YOU delete it).
test-history:
    @ls -1t history 2>/dev/null || echo "no runs yet — run `just test-matrix`"

# Open a specific archived run, e.g. `just test-report-at 2026-06-28T10-30-00__full`
test-report-at run:
    npx playwright show-report history/{{run}}

# Keep only the N most recent run archives in history/ (delete older).
# e.g. `just test-history-keep 2`  (default keeps 2)
test-history-keep n="2":
    @ls -1dt history/*/ 2>/dev/null | tail -n +$(( {{n}} + 1 )) | while read d; do rm -rf "$d"; done; echo "kept newest {{n}} run archive(s); $(ls -1d history/*/ 2>/dev/null | wc -l | tr -d ' ') remain"

# Delete archived runs older than N days.
test-history-prune days="14":
    find history -maxdepth 1 -mindepth 1 -type d -mtime +{{days}} -exec rm -rf {} + 2>/dev/null; echo done

# Bring the backend stack UP for a mode and LEAVE it running — required before
# `test-ui` if you want to actually RUN tests (not just browse the tree).
# e.g. `just test-up authn` then `just test-ui`. Tear down with `just test-down`.
test-up mode="authn" app="console":
    node run.mjs --up --app {{app}} --mode {{mode}}

# Playwright UI portal — browse/run ALL e2e tests in a tree. To RUN tests, first
# `just test-up <mode>` (same mode), else the app has no Lakekeeper → failures.
test-ui app="console" mode="authn":
    E2E_ALL=1 APP={{app}} TEST_MODE={{mode}} npx playwright test --ui

# Vitest UI portal for the component tests (run from the component repo).
test-ui-components:
    cd ../console-components && npx vitest --ui

# Open the CENTRAL merged report across all combos (RESULTS, after a run).
test-report:
    npx playwright show-report playwright-report

# Open one combo's report, e.g. `just test-report-combo console authn`
test-report-combo app mode:
    npx playwright show-report reports/{{app}}-{{mode}}

# Tear everything down
test-down:
    docker-compose -f docker-compose.yml down -v --remove-orphans
