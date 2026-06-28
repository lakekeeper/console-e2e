# console-e2e — Lakekeeper Console test engine

End-to-end test matrix for the Lakekeeper web consoles. One command spins up a full
Lakekeeper stack, serves the app, drives real user journeys in a browser, and
produces a visual pass/fail **dashboard** — across both apps, every auth mode, and
multiple browsers.

- **`console`** — the open-source console
- **`console-plus`** — the premium console (adds Cedar authorization)

> New here? Read **[Quick start](#quick-start)**, run `just test-one console authn`,
> then open the dashboard. The rest of this doc explains the matrix, the modes, and
> the gotchas.

---

## What gets tested — the matrix

Every cell is a full stack brought up from scratch, the app served, and the journeys
run end to end:

| app | `noauth` | `authn` | `authz` (OpenFGA) | `cedar` |
| --- | :---: | :---: | :---: | :---: |
| **console** | ✅ | ✅ | ✅ | — |
| **console-plus** | ✅ | ✅ | ✅ | ✅ |

…and each combo runs on **chromium** (full suite), plus **firefox** (full parity)
and **webkit** (smoke) as a third dimension. Cedar is premium-only, so it only
appears for `console-plus`.

**The modes** (this is the whole point — Lakekeeper behaves very differently):

| mode | authN | authZ | notes |
| --- | --- | --- | --- |
| `noauth` | off | off | anonymous; anyone can do anything |
| `authn` | on | off | must log in; no permission gate |
| `authz` | on | **OpenFGA** | relationship-based grants (roles, per-object grants) |
| `cedar` | on | **Cedar** | policy-file based; **premium only**; no roles |

---

## What the journeys cover

Each spec is a realistic user flow, not a unit test (see [`specs/`](specs/)):

| spec | what it proves |
| --- | --- |
| `bootstrap/` | first-run server bootstrap (the stepper) |
| `auth/login`, `auth/logout`, `auth/noauth-access` | the auth lifecycle per mode |
| `flows/warehouse-lifecycle` | create warehouse → see it in the tree → open it → add a namespace (one journey **per storage backend**) |
| `flows/loqe` | the in-browser **DuckDB-WASM** engine: initializes, then **creates + queries an Iceberg table** end to end (writes parquet to S3 from the browser, reads `1` back) |
| `flows/role` | role CRUD (authz/cedar) |
| `perms/access-control` | **permission enforcement**: a non-admin (`anna`) is *denied* reading a table until an admin (`peter`) grants her — via the **Permissions UI** (OpenFGA) or a **policy edit** (Cedar) |
| `storage/cors` | the storage-CORS gate: a real LoQE `SELECT *` **works on `:3001`** (the bucket's allowed origin) but is **blocked on `:3002`** — with screenshots/video of the in-app error |
| `smoke/route-smoke` | major routes render (the cross-browser smoke subset, tagged `@smoke`) |

Component **unit tests** (Vitest, in the component repos) run once per matrix and
show up on the dashboard too — see [Unit tests](#unit-tests).

---

## Quick start

### Prerequisites

- **podman** with `podman compose` (this engine drives podman, not docker — see
  [Why podman](#why-podman-not-docker)). Verify: `podman compose version`.
- **Node 20+** and **[just](https://github.com/casey/just)** (`brew install just`).
- The sibling app + component repos checked out next to this one:
  ```
  <workspace>/
    console-e2e/        ← you are here
    console/            ← OSS app
    console-plus/       ← premium app
    console-components/ ← shared component library
    lakekeeper/         ← for the Keycloak realm + (optional) policies
  ```

### 1. Configure

```bash
cp .env.example .env                  # non-secret config (paths, ports, images)
cp .env.secret.example .env.secret    # secrets (Cedar license, cloud creds)
```
Edit both. `.env` and `.env.secret` are **git-ignored** — never commit them. See
[Configuration](#configuration).

### 2. Install

```bash
just test-setup        # npm install + playwright browser download (chromium)
npx playwright install firefox webkit   # only if you want the cross-browser dims
```

### 3. Run

```bash
just test-one console authn     # one combo (~3 min) — best first run
just test-matrix                # the whole matrix (~35 min) — the release gate
just test-dashboard             # open the visual matrix in a browser
```

That's it. `just --list` shows every recipe.

---

## Commands

All recipes are namespaced `test-`:

| command | what it does |
| --- | --- |
| `just test-setup` | install deps + chromium |
| `just test-one <app> <mode>` | one combo, e.g. `just test-one console-plus cedar` |
| `just test-app <app>` | one app, all its modes |
| `just test-mode <mode>` | one mode, both apps |
| `just test-matrix` | **the full matrix** (both apps × all modes × browsers) |
| `just test-unit` | component-repo Vitest unit tests (standalone) |
| `just test-coverage` | e2e code coverage on the chromium combos (see [Coverage](#coverage)) |
| `just test-dashboard` | build + serve the matrix dashboard |
| `just test-catalog` | list every defined test case (planning view, no run) |
| `just test-report` | open the merged Playwright report (traces/video/screenshots) |
| `just test-report-combo <app> <mode>` | open one combo's report |
| `just test-up <mode> [app]` | bring the stack up and **leave it running** (for `test-ui`) |
| `just test-ui [app] [mode]` | Playwright UI to browse/run tests (needs `test-up` first) |
| `just test-history` | list archived runs (timestamped, kept until you delete them) |
| `just test-history-keep <n>` | prune to the newest N archives |
| `just test-down` | tear the stack down |

---

## The dashboard & reports

- **`just test-dashboard`** → `DASHBOARD.html`: every test × every app·mode·browser
  with the latest pass/fail. Frozen header + frozen first column, scrollable. While a
  run is active it shows an **in-progress** banner with the **live test name**. It
  *accumulates* across runs (a partial run only updates its own columns).
- **`just test-report`** → the merged Playwright report: traces, video, and a
  screenshot of every step (e.g. the CORS test's `:3001` result vs `:3002` error box).
- **`just test-catalog`** → `TEST-CATALOG.md`/`.html`: what test cases exist, ordered
  by journey — a planning view that needs no run.
- **History**: every full run is archived under `history/<timestamp>__<scope>` and
  kept until you delete it (`just test-history`, `test-history-keep`).

---

## Configuration

Two files, both git-ignored:

**`.env`** — non-secret: image tags, host paths to the sibling repos, `APP_PORT`,
test usernames. Key values:
- `APP_PORT=3001` — run the apps on `:3001`. The AWS demo bucket's CORS allows that
  origin, so the in-browser LoQE Iceberg reads/writes pass. A different port breaks
  storage CORS (the `storage/cors` test proves `:3002` is blocked).
- `CEDAR_POLICY_DIR=./cedar` — a **self-contained** policy dir shipped in this repo.
  The Cedar access-control test mutates `policies.cedar` live; don't point this at a
  real policy dir.

**`.env.secret`** — secrets: the Cedar **license key** (premium image), and cloud
storage credentials (AWS/R2/ADLS/…). Storage backends are **skip-if-absent**: a
backend only runs when its creds are present. ⚠️ Use throwaway, least-privilege keys
— never a prod key.

---

## Storage backends

The warehouse + LoQE journeys run **per enabled backend** (see
[`specs/_data/storage-backends.ts`](specs/_data/storage-backends.ts)):

- **SeaweedFS** — a local S3, started by the stack; always on. Reachable from both the
  browser and the lakekeeper container via the host LAN IP (auto-detected by
  `run.mjs` to solve the [split-horizon](#split-horizon) problem). Create+verify only
  (no deep browser flows by default).
- **AWS S3** — enabled when `AWS_*` creds are set; runs the **deep flows** (open
  detail, LoQE table create/read). Requires an **STS-enabled** warehouse + a bucket
  CORS that allows `http://localhost:3001` — see [LoQE & CORS](#loqe--storage-cors).
- **R2 / ADLS / OneLake / GCS** — enabled when their creds are set; otherwise skipped.

---

## Unit tests

Component-repo **Vitest** tests (e.g. `console-components/src/plugins/authToken.test.ts`,
which guards the token-hydration fix) are browser-independent, so `run.mjs` runs them
**once per matrix** and shows the result on the dashboard. Run standalone with
`just test-unit`. Disable in a matrix run with `NO_UNIT=1`.

---

## Coverage

`just test-coverage` collects **V8 code coverage** during the chromium combos
(coverage is chromium-only) and maps it back to source via sourcemaps, producing a
report per combo under `coverage/`. It builds `console-components` with sourcemaps
first so coverage maps to real source. (Component-library mapping additionally needs
the source-alias — see [troubleshooting](#troubleshooting).) E2E coverage is
broad/integration-level; for line coverage of the library use the Vitest unit tests.

---

## How it works

- **`run.mjs`** — the orchestrator. For each `app × mode`: `compose down -v` →
  bring up infra → migrate → serve lakekeeper → wait for health → run Playwright →
  (cross-browser passes) → archive + rebuild the dashboard → tear down.
- **`docker-compose.yml`** — Postgres, Keycloak, OpenFGA, SeaweedFS (+ bucket-init),
  and Lakekeeper. The Lakekeeper image and `modes/<mode>.env` are swapped per combo.
- **`modes/<mode>.env`** — the per-mode knobs: backend `LAKEKEEPER__*` (container) +
  `VITE_*` (build-time app flags, e.g. `VITE_ENABLE_AUTHENTICATION`).
- **`playwright.config.ts`** — dynamic: reads `APP`/`TEST_MODE`/`BROWSER`, loads that
  mode's `VITE_*` into the dev-server env, tags-filters specs by mode, and launches
  the app on `APP_PORT`.
- **`specs/`** — the journeys + shared helpers (`_utils/`, `_fixtures/`, `_data/`).

---

## Troubleshooting

#### Why podman, not docker
`docker` on this setup is a shell alias to podman (invisible to Node's `spawn`), and a
standalone `docker-compose` binary targets the wrong socket. `run.mjs` drives
`podman compose` so it wires podman's own socket. Override with `COMPOSE_BIN` /
`COMPOSE_SUBCMD` for a real docker install.

#### LoQE & storage CORS
The in-browser DuckDB-WASM engine reads/writes Iceberg data **straight from the
browser to S3**. That only works when (a) the app origin is **`:3001`** and the
bucket's CORS allows it, and (b) for AWS, the warehouse is **STS-enabled** (plain
access-key creds write to the bucket root and 404). The catalog API is CORS-`*`, so
the *tree* loads on any origin — but *data* reads need bucket CORS. The `storage/cors`
test demonstrates `:3001` works / `:3002` is blocked.

#### Split-horizon
Local SeaweedFS must be reachable from **both** the browser (host) and the lakekeeper
container, which see different hostnames. `run.mjs` auto-detects the host LAN IP and
uses it as the single endpoint so the SigV4 signature matches on both sides.

#### "Lakekeeper Unreachable" / bootstrap timeouts
If the app flashes a **"Lakekeeper Unreachable / Check status"** page, lakekeeper is
usually *not* down — it's a token-hydration race (an early request goes out before the
token is ready). The helpers recover from it (`_utils/app.ts`). It traces back to a
real console-components bug worth fixing (the request interceptor should not attach
`Bearer undefined`).

#### Ports
`run.mjs` frees `:3001`/`:3002` and **waits** for release before each combo
(`--strictPort` means a half-released port would otherwise fail the server with
"address already in use"). If a run dies mid-combo, `just test-down` cleans up.

#### DuckDB-WASM version
LoQE is pinned to DuckDB-WASM **1.4.x**; 1.5.x regressed Iceberg writes.

---

## When to run (cadence)

Match the scope to the change:

- **While coding** — the relevant unit test (`vitest`) or one spec via `just test-ui`.
- **Before a PR** — `just test-one console authn` (~3 min) + the unit tests.
- **Before a release** — `just test-matrix` (the gate). Ideally in CI so it doesn't
  block your machine.

---

## Layout

```
run.mjs                 orchestrator (the matrix loop)
docker-compose.yml      the Lakekeeper stack
modes/*.env             per-mode backend + VITE_* config
cedar/policies.cedar    self-contained Cedar base policy (test mutates it)
playwright.config.ts    dynamic per app/mode/browser
dashboard.mjs           builds DASHBOARD.html
catalog.mjs             builds TEST-CATALOG
reporters/current.mjs   live "now-running test" marker for the dashboard
specs/
  _data/                storage backends
  _fixtures/            auth + coverage fixtures
  _utils/               login, warehouse, loqe, permissions, cedar, app helpers
  <area>/*.spec.ts      the journeys
```
