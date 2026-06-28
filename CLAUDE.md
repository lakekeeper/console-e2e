# Agent Instructions — console-e2e

E2E test engine for the Lakekeeper consoles (`console`, `console-plus`). It brings up
a real Lakekeeper stack via **podman compose**, serves the app with Playwright's
`webServer`, and runs browser journeys across a matrix of **app × auth-mode ×
browser**. Read [README.md](README.md) first for the user-facing overview.

## Architecture (where things live)

- **`run.mjs`** — the orchestrator. Loops `app × mode`; per combo: `compose down -v`
  → up infra → `migrate` → serve lakekeeper → poll `/health` → `runPlaywright()` →
  cross-browser passes → archive + rebuild dashboard → teardown. Also runs the
  component **unit tests** once up front (`runUnitTests()`).
- **`docker-compose.yml`** — Postgres, Keycloak (`:30080`), OpenFGA, SeaweedFS
  (`:8333`) + bucket-init, Lakekeeper (`:8181`). Image + `modes/<mode>.env` swapped
  per combo. Postgres/OpenFGA publish **no host ports** (avoid clashes).
- **`modes/<mode>.env`** — backend `LAKEKEEPER__*` (container) + `VITE_*` (build-time
  app flags). `noauth`/`authn`/`authz`(OpenFGA)/`cedar`(Cedar, premium).
- **`playwright.config.ts`** — dynamic from `APP`/`TEST_MODE`/`BROWSER` env. Loads the
  mode's `VITE_*` into the dev-server env, grep-filters specs by `@<mode>` tag,
  launches the app on `APP_PORT`. A **second `:3002` webServer** starts only in
  `authn` (for the CORS test). `reuseExistingServer:false` + `--strictPort`.
- **`specs/`** — `_data/` (storage backends), `_fixtures/` (auth + coverage),
  `_utils/` (login, warehouse, loqe, permissions, cedar, app helpers), and the
  journeys by area.
- **`dashboard.mjs` / `catalog.mjs`** — build `DASHBOARD.html` / `TEST-CATALOG`.
  `reporters/current.mjs` writes `results/current.json` (live test name for the
  dashboard banner).

## Conventions

- **Tags drive selection.** Every `test.describe` is tagged with the modes it applies
  to: `@noauth @authn @authz @cedar`. `run.mjs`/config grep by `@<mode>`. Untagged →
  never runs. `@smoke` is the cross-browser (firefox/webkit) subset. Access-control is
  `@authz` (OpenFGA, UI grant) and a separate `@cedar` block (policy-file grant).
- **Fixtures**: use `bootstrappedPage` (logged in + server bootstrapped, peter) from
  `_fixtures/auth.fixture.ts`. A second user `anna` (non-admin) is `TEST_USER_2`.
- **Helpers, not inline flows**: warehouse create/open/namespace → `_utils/warehouse.ts`;
  LoQE attach/exec/create+read → `_utils/loqe.ts`; grants → `_utils/permissions.ts`
  (FGA UI) / `_utils/cedar.ts` (policy file); recover from the false offline page →
  `_utils/app.ts`. Seeding helpers are **idempotent** (combos share backend state).
- **Robust selectors**: prefer `getByRole`/`getByText`. The Vuetify Permissions v-tab
  resets while data loads — click until `aria-selected=true`. A restricted user's
  first calls 401 during token hydration — reload until the warehouse appears.
- **Per-action timeout** is capped globally (`use.actionTimeout`) so a stuck click
  fails fast and retries instead of eating the test timeout.

## Hard-won gotchas (don't relearn these)

- **podman, not docker** — `docker` is a shell alias invisible to `spawn`; `run.mjs`
  uses `podman compose`.
- **App must run on `:3001`** — the AWS demo bucket's CORS allows that origin; LoQE
  browser→S3 reads/writes fail on any other port. `--strictPort` enforces it.
- **AWS LoQE writes need an STS-enabled warehouse** (`sts-enabled` + `sts-role-arn` +
  key-prefix). Plain access-key creds write to the bucket root and 404. A green
  `CREATE` is not proof — assert the read-back.
- **Split-horizon SeaweedFS** — single host-LAN-IP endpoint for browser + container.
- **CORS error wording is browser-specific** — chromium says "…CORS/404", firefox says
  "Cannot read N bytes from memory buffer". `console-components` LoQEEngine maps both
  to a friendly message; the CORS test asserts the friendly message (don't tighten to
  a chromium-only string).
- **Multi-statement SQL** makes one result tab per statement — run one statement at a
  time and settle on the "Running query…" spinner disappearing.

## Adding things

- **A test**: new `specs/<area>/<name>.spec.ts`, tag the describe with applicable
  modes, reuse `_utils` helpers + `bootstrappedPage`. Add its path to `SPEC_ORDER` in
  both `dashboard.mjs` and `catalog.mjs` for journey ordering.
- **A mode**: add `modes/<mode>.env` + wire it in `run.mjs` (`ALL_MODES`, `APP_MODES`,
  `SERVICES`) and `dashboard.mjs` (`MODE_LABEL`).
- **A storage backend**: add an entry to `specs/_data/storage-backends.ts`
  (skip-if-absent via its env creds; `deepFlows` gates browser-reachable flows).

## Rules

- **Never commit secrets.** `.env` / `.env.secret` are git-ignored; `*.example` files
  hold placeholders only. Generated artifacts (`coverage/`, `results/`, `reports/`,
  `DASHBOARD.html`, `TEST-CATALOG.*`) are ignored — don't commit them.
- **Validate before a matrix run**: `node --check run.mjs dashboard.mjs`, and
  `npx playwright test --list` to confirm the config + reporters load.
- Changes to `console-components` (a sibling repo) go via its **PR workflow**, not a
  direct push, and need the `BEGIN_COMMIT_OVERRIDE` block.
