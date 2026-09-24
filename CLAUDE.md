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
- **`docker-compose.yml`** — Postgres, Keycloak (`:30080`), OpenFGA, Silo
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

## Test isolation contract

Three tiers, cheapest first. Pick the weakest one that actually works — a
fresh backend per test would add ~25s each (~20 min per mode across browsers)
to fix what two specs needed.

**Tier 1 — per-test project (default, ~1s).** `bootstrappedPage` creates a
project named `e2e-<browser>-<runid>-<test title>` and seeds it into the app's
persisted store, so every request carries that `x-project-id`. Warehouses,
namespaces and grants are all project-scoped. The run id means a re-run against
a still-running stack starts clean; retries within a run reuse their own project.

**Tier 2 — shared project, scoped names.** For a spec whose subject IS the
project's baseline access: a brand-new project denies a second user even
`get_metadata`, so "grant her the warehouse and she can see it" cannot hold
there. `test.use({ isolatedProject: false })`, and rely on warehouse names
carrying `E2E_RESOURCE_SUFFIX` (browser + run id). `perms/access-control.spec.ts`
is the only one.

**Browser passes get a fresh backend.** run.mjs calls `resetBackend()` before
the firefox and webkit passes: postgres, openfga, silo and bucket-init are
recreated and lakekeeper restarted, while keycloak stays up (no per-test state,
and the slowest to start). ~25s per pass, and it is what lets every spec run on
every browser. Grants live in OpenFGA's MEMORY, so resetting postgres alone
would not clear them.

**Why that was needed.** chromium, firefox and webkit run one after
another against ONE backend, so a spec whose state cannot be undone must run on
one browser only. `perms/access-control.spec.ts` is chromium-only for that
reason: granting `describe` on a warehouse also lets the principal LIST
warehouses in the project, and revoking the row does not take that back, so the
second browser always saw a warehouse "before any grant". Its subject is
server-side authz, which is browser-independent anyway.

**Tier 3 — own backend.** Nothing needs this yet. If something does: recreate
`postgres`, `openfga`, `silo` and `bucket-init` and restart `lakekeeper`, but
leave `keycloak` up — it holds no per-test state and is the slow one. Note
grants live in OpenFGA's MEMORY (`command: run`, no datastore), so resetting
Postgres alone does not clear them.



Combos and browser passes share ONE backend; nothing is reset between them.
Two rules keep that from corrupting results:

1. **Unique names.** `warehouseName()` appends `E2E_RESOURCE_SUFFIX`, which
   `run.mjs` sets per browser pass. Without it firefox inherited chromium's
   OpenFGA grants (anna was already granted before the "grant" step) and
   chromium's deliberately-blocked warehouse (writes could not work).
2. **Unique locations.** A warehouse created with no key-prefix owns the whole
   bucket root, so every later warehouse in that bucket fails "Storage location
   is not used by another warehouse" no matter what it is called. Every
   `StorageBackend.fill` receives `ctx.warehouse` and must use it as the
   storage Location.

A spec that mutates shared state (grants, a storage profile) must either scope
that state to its own warehouse or reset it — see `perms/access-control.spec.ts`,
where the Cedar block resets in before/afterEach and the OpenFGA block relies on
a per-browser warehouse instead.

## Hard-won gotchas (don't relearn these)

- **podman, not docker** — `docker` is a shell alias invisible to `spawn`; `run.mjs`
  uses `podman compose`.
- **App must run on `:3001`** — the AWS demo bucket's CORS allows that origin; LoQE
  browser→S3 reads/writes fail on any other port. `--strictPort` enforces it.
- **AWS LoQE writes need an STS-enabled warehouse** (`sts-enabled` + `sts-role-arn` +
  key-prefix). Plain access-key creds write to the bucket root and 404. A green
  `CREATE` is not proof — assert the read-back.
- **Split-horizon Silo** — single host-LAN-IP endpoint for browser + container.
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
