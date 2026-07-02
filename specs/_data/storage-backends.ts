import { Locator } from '@playwright/test';

// v-tabs keeps every storage subform mounted, so field lookups must be scoped to
// the active panel to avoid matching hidden tabs.
async function fillIfPresent(scope: Locator, label: RegExp, value: string) {
  const field = scope.getByLabel(label).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}

/**
 * Storage backends for warehouse tests. Each backend fills its tab's subform in
 * the "Add Warehouse" dialog. S3-compatible (SeaweedFS) is always available locally;
 * the cloud backends activate only when their credentials are present in the
 * environment (export locally now; GitHub secrets later) — otherwise skipped,
 * the same skip-if-absent pattern as the cedar mode.
 *
 * The storage-type tabs in WarehouseAddDialog have values:
 *   S3 · GCS · AZURE · ONELAKE · R2 · S3_COMPAT
 */
export interface StorageBackend {
  key: string;
  /** v-tab to activate (accessible name / visible text). */
  tab: RegExp;
  /** True when this backend's credentials are configured. */
  enabled: boolean;
  /** Fill the subform fields for this backend (scoped to the active tab panel). */
  fill: (scope: Locator) => Promise<void>;
  /**
   * Whether deep flows (open detail → namespace → table) work. They need the
   * storage endpoint reachable FROM THE BROWSER (the detail page's storage
   * explorer fetches it). Cloud (AWS/R2/…) is browser-reachable; local SeaweedFS
   * sends no CORS headers, so it's create+verify only. Default true.
   */
  deepFlows?: boolean;
}

const env = process.env;
const has = (...keys: string[]) => keys.every((k) => !!env[k]);
// Cloud backends: enabled only when their creds exist AND we're not in served-UI
// (docker image) mode. Served-UI tests the pushed image's embedded UI at :8181,
// but the cloud buckets' CORS only allows the :3001 dev origin — so restrict the
// docker matrix to local SeaweedFS (wildcard CORS). See `just test-matrix-docker`.
const cloud = (...keys: string[]) => env.SERVED_UI !== '1' && has(...keys);

async function fillS3Compat(scope: Locator) {
  // Local SeaweedFS (S3-compatible). The endpoint must be reachable from BOTH the
  // browser and the lakekeeper container, so default to the host LAN IP (run.mjs
  // injects S3_LOCAL_ENDPOINT); seaweedfs:8333 only works server-side.
  await fillIfPresent(scope, /Access Key ID/i, env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
  await fillIfPresent(scope, /Secret Access Key/i, env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret');
  await fillIfPresent(scope, /Bucket Name/i, env.S3_LOCAL_BUCKET || 'lakekeeper-test');
  await fillIfPresent(scope, /Bucket Region/i, env.S3_LOCAL_REGION || 'us-east-1');
  // Endpoint + path-style live under the collapsed "Advanced Storage Options"
  // panel — expand it or they silently stay empty (→ no URL → "Failed to fetch").
  const adv = scope.getByRole('button', { name: /Advanced Storage Options/i });
  if (await adv.isVisible().catch(() => false)) await adv.click();
  await fillIfPresent(scope, /Endpoint/i, env.S3_LOCAL_ENDPOINT || 'http://seaweedfs:8333');
  const pathStyle = scope.getByLabel(/path[- ]style/i);
  if (await pathStyle.isVisible().catch(() => false)) {
    await pathStyle.check().catch(() => pathStyle.click());
  }
  // Deep flows (docker matrix, S3_LOCAL_DEEP=1) need STS-vended creds so the browser
  // LoQE write succeeds — plain access-key vending 404s the write (same failure mode
  // as AWS). SeaweedFS AssumeRole (LakekeeperVendedRole in seaweedfs/s3.json) vends
  // short-lived creds. The npm matrix leaves STS off (create+verify only).
  if (env.S3_LOCAL_DEEP === '1') {
    const stsToggle = scope.getByText(/Enable STS/i).first();
    if (await stsToggle.isVisible().catch(() => false)) await stsToggle.click();
    const roleArn = scope.getByLabel(/STS Role ARN/i).first();
    await roleArn.waitFor({ timeout: 5000 }).catch(() => {});
    await fillIfPresent(
      scope,
      /STS Role ARN/i,
      env.S3_LOCAL_STS_ROLE_ARN || 'arn:aws:iam::000000000000:role/LakekeeperVendedRole',
    );
  }
}

export const STORAGE_BACKENDS: StorageBackend[] = [
  {
    key: 's3 (seaweedfs)',
    tab: /S3 Compatible|S3.?Compat/i,
    // On by default (the always-available local backend); run.mjs injects a host
    // LAN-IP endpoint so it's reachable from both browser and container. Opt out
    // with S3_LOCAL_ENABLE=0.
    enabled: process.env.S3_LOCAL_ENABLE !== '0',
    // Deep flows (browser open→namespace→table→LoQE read/write) need the bucket
    // reachable from the browser WITH write-CORS. Off by default (npm matrix: the
    // shipped bucket-init sets wildcard CORS, but we keep the historical create+verify
    // behavior). The docker matrix (served-UI) sets S3_LOCAL_DEEP=1 to turn it ON so
    // LoQE + access-control actually run against the pushed image, fully local (no AWS).
    deepFlows: env.S3_LOCAL_DEEP === '1',
    fill: fillS3Compat,
  },
  {
    key: 's3 (aws)',
    tab: /AWS S3|Amazon S3/i,
    enabled: cloud('AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'),
    fill: async (scope) => {
      // credential type = access-key (radio), if the AWS variant shows the toggle
      const accessKeyRadio = scope.getByRole('radio', { name: /access key/i }).first();
      if (await accessKeyRadio.isVisible().catch(() => false)) {
        await accessKeyRadio.check().catch(() => {});
      }
      await fillIfPresent(scope, /Access Key ID/i, env.AWS_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.AWS_SECRET_ACCESS_KEY!);
      await fillIfPresent(scope, /Bucket Name/i, env.AWS_S3_BUCKET!);
      await fillIfPresent(scope, /Bucket Region/i, env.AWS_REGION || 'us-east-1');

      // Match the working manual profile: { remote-signing-enabled (default on),
      // sts-enabled, sts-role-arn, key-prefix }. Without STS the warehouse uses
      // plain vended access-key creds writing to the bucket root, and the browser
      // write 404s. The two fields live in different places:

      // 1) Key Prefix — inside the collapsed "Advanced Storage Options" panel.
      if (env.AWS_KEY_PREFIX) {
        const adv = scope.getByRole('button', { name: /Advanced Storage Options/i });
        if (await adv.isVisible().catch(() => false)) {
          await adv.click();
          await scope.getByLabel(/Key Prefix/i).first().waitFor({ timeout: 5000 }).catch(() => {});
        }
        await fillIfPresent(scope, /Key Prefix/i, env.AWS_KEY_PREFIX);
      }

      // 2) STS — an always-visible switch (after the panel). Toggle it on by
      //    clicking its label, which reveals the "STS Role ARN" field.
      if (env.AWS_STS_ROLE_ARN) {
        const stsToggle = scope.getByText(/Enable STS/i).first();
        if (await stsToggle.isVisible().catch(() => false)) await stsToggle.click();
        const roleArn = scope.getByLabel(/STS Role ARN/i).first();
        await roleArn.waitFor({ timeout: 5000 }).catch(() => {});
        await fillIfPresent(scope, /STS Role ARN/i, env.AWS_STS_ROLE_ARN);
      }
    },
  },
  {
    key: 'r2 (cloudflare)',
    tab: /Cloudflare R2|^R2$/i,
    enabled: cloud('R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /Access Key ID/i, env.R2_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.R2_SECRET_ACCESS_KEY!);
      await fillIfPresent(scope, /Account ID/i, env.R2_ACCOUNT_ID!);
      await fillIfPresent(scope, /Bucket Name/i, env.R2_BUCKET!);
    },
  },
  {
    key: 'adls (azure)',
    tab: /Azure|ADLS/i,
    enabled: cloud('ADLS_ACCOUNT_NAME', 'ADLS_FILESYSTEM', 'ADLS_CLIENT_ID', 'ADLS_CLIENT_SECRET', 'ADLS_TENANT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /Account Name/i, env.ADLS_ACCOUNT_NAME!);
      await fillIfPresent(scope, /Filesystem/i, env.ADLS_FILESYSTEM!);
      await fillIfPresent(scope, /Client ID/i, env.ADLS_CLIENT_ID!);
      await fillIfPresent(scope, /Client Secret/i, env.ADLS_CLIENT_SECRET!);
      await fillIfPresent(scope, /Tenant ID/i, env.ADLS_TENANT_ID!);
    },
  },
  {
    key: 'onelake (fabric)',
    tab: /OneLake/i,
    enabled: cloud('ONELAKE_ACCOUNT_NAME', 'ONELAKE_FILESYSTEM', 'ONELAKE_CLIENT_ID', 'ONELAKE_CLIENT_SECRET', 'ONELAKE_TENANT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /Account Name/i, env.ONELAKE_ACCOUNT_NAME!);
      await fillIfPresent(scope, /Filesystem|Workspace/i, env.ONELAKE_FILESYSTEM!);
      await fillIfPresent(scope, /Client ID/i, env.ONELAKE_CLIENT_ID!);
      await fillIfPresent(scope, /Client Secret/i, env.ONELAKE_CLIENT_SECRET!);
      await fillIfPresent(scope, /Tenant ID/i, env.ONELAKE_TENANT_ID!);
    },
  },
  {
    key: 'gcs (google)',
    tab: /GCS|Google/i,
    enabled: cloud('GCS_BUCKET', 'GCS_SERVICE_ACCOUNT_KEY'),
    fill: async (scope) => {
      await fillIfPresent(scope, /Bucket Name/i, env.GCS_BUCKET!);
      // GCS uses a service-account JSON key — pasted into the key field.
      await fillIfPresent(scope, /Service Account|Key|Credential/i, env.GCS_SERVICE_ACCOUNT_KEY!);
    },
  },
];

export const ENABLED_BACKENDS = STORAGE_BACKENDS.filter((b) => b.enabled);
