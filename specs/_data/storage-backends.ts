import { Locator } from '@playwright/test';

// The warehouse-create dialog is one FULLSCREEN modal with a vertical rail
// (Settings · one tab per storage provider · Tools). Only the selected
// provider's subform is mounted, but the Settings pane stays in the DOM
// hidden — so every lookup is filtered to visible elements, not just scoped.
async function fillIfPresent(scope: Locator, label: RegExp, value: string) {
  const field = scope.getByLabel(label).filter({ visible: true }).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}

/** Open the provider form's collapsed "Layout & options" accordion (was
 *  "Advanced Storage Options" before the storage form was rebuilt in 0.23). */
async function openLayoutOptions(scope: Locator) {
  const panel = scope.getByRole('button', { name: /Layout & options|Advanced Storage Options/i }).first();
  if (await panel.isVisible().catch(() => false)) {
    const expanded = await panel.getAttribute('aria-expanded');
    if (expanded !== 'true') await panel.click().catch(() => {});
    await scope.page().waitForTimeout(300);
  }
}

/** Client access is one exclusive radio group now ("Remote signing" / "Vended
 *  credentials (STS)" / "None"), not an "Enable STS" switch beside remote
 *  signing. Picking STS reveals the role-ARN field. */
export async function chooseVendedCredentials(scope: Locator, roleArn?: string) {
  const radio = scope.getByRole('radio', { name: /Vended credentials/i }).first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.check().catch(() => radio.click().catch(() => {}));
  } else {
    await scope.getByText(/Vended credentials \(STS\)/i).first().click().catch(() => {});
  }
  if (!roleArn) return;
  const arn = scope.getByLabel(/STS role ARN/i).filter({ visible: true }).first();
  await arn.waitFor({ timeout: 5000 }).catch(() => {});
  await fillIfPresent(scope, /STS role ARN/i, roleArn);
}

/**
 * Storage backends for warehouse tests. Each backend selects its provider in the
 * rail of the "Add Warehouse" modal and fills that provider's form. S3-compatible
 * (Silo) is always available locally; the cloud backends activate only when
 * their credentials are present in the environment — otherwise skipped, the same
 * skip-if-absent pattern as the cedar mode.
 *
 * The storage-provider rail entries are (value · title):
 *   S3 · AWS S3          STACKIT · STACKIT        AZURE · Azure ADLS
 *   ONELAKE · OneLake    S3_COMPAT · S3 Compatible GCS · Google Cloud
 *   R2 · Cloudflare R2   ALIYUN_OSS · Alibaba OSS
 */
export interface StorageBackend {
  key: string;
  /** Rail entry to activate (accessible name / visible text). */
  tab: RegExp;
  /** True when this backend's credentials are configured. */
  enabled: boolean;
  /** Fill the provider's form (scoped to the open create modal). */
  fill: (scope: Locator) => Promise<void>;
  /**
   * Whether deep flows (open detail -> namespace -> table) work. They need the
   * storage endpoint reachable FROM THE BROWSER (the detail page's storage
   * explorer fetches it). Cloud (AWS/R2/...) is browser-reachable; local Silo
   * sends no CORS headers, so it's create+verify only. Default true.
   */
  deepFlows?: boolean;
}

const env = process.env;
const has = (...keys: string[]) => keys.every((k) => !!env[k]);
// Cloud backends: enabled only when their creds exist AND we're not in served-UI
// (docker image) mode. Served-UI tests the pushed image's embedded UI at :8181,
// but the cloud buckets' CORS only allows the :3001 dev origin - so restrict the
// docker matrix to local Silo (wildcard CORS). See `just test-matrix-docker`.
const cloud = (...keys: string[]) => env.SERVED_UI !== '1' && has(...keys);

async function fillS3Compat(scope: Locator) {
  // Local Silo, a maintained MinIO fork (S3-compatible). The endpoint must be
  // reachable from BOTH the browser and the lakekeeper container, so default to
  // the host LAN IP (run.mjs injects S3_LOCAL_ENDPOINT); silo:9000 is
  // server-side only.
  // Field names changed in 0.23: "Bucket Name" -> "Bucket *", "Bucket Region" ->
  // "Region", and Endpoint moved out of the advanced panel (it is required here).
  await fillIfPresent(scope, /^Bucket( \*)?$/i, env.S3_LOCAL_BUCKET || 'lakekeeper-test');
  await fillIfPresent(scope, /^Region( \*)?$/i, env.S3_LOCAL_REGION || 'us-east-1');
  await fillIfPresent(scope, /^Endpoint( \*)?$/i, env.S3_LOCAL_ENDPOINT || 'http://silo:9000');
  await fillIfPresent(scope, /Access Key ID/i, env.S3_LOCAL_ACCESS_KEY || 'lakekeeper');
  await fillIfPresent(scope, /Secret Access Key/i, env.S3_LOCAL_SECRET_KEY || 'lakekeeper-secret');

  // Path-style access lives under the collapsed "Layout & options" accordion —
  // Silo needs it or every request resolves to a virtual-host URL.
  await openLayoutOptions(scope);
  const pathStyle = scope.getByLabel(/path[- ]style/i).filter({ visible: true }).first();
  if (await pathStyle.isVisible().catch(() => false)) {
    await pathStyle.check().catch(() => pathStyle.click().catch(() => {}));
  }

  // Deep flows (docker matrix, S3_LOCAL_DEEP=1) need STS-vended creds so the browser
  // LoQE write succeeds — plain access-key vending 404s the write (same failure mode
  // as AWS). Silo serves AssumeRole from the same endpoint and derives the session
  // from the calling key, so there is no role to name. Pass S3_LOCAL_STS_ROLE_ARN
  // only if a deployment actually wants one.
  if (env.S3_LOCAL_DEEP === '1') {
    await chooseVendedCredentials(scope, env.S3_LOCAL_STS_ROLE_ARN);
  }
}

export const STORAGE_BACKENDS: StorageBackend[] = [
  {
    key: 's3 (silo)',
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
      // Authentication is a button toggle now ("Access key" / "System identity"),
      // not a radio group. Access key is the default, so this only asserts it.
      const accessKeyBtn = scope.getByRole('button', { name: /^Access key$/i }).first();
      if (await accessKeyBtn.isVisible().catch(() => false)) {
        await accessKeyBtn.click().catch(() => {});
      }
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.AWS_S3_BUCKET!);
      await fillIfPresent(scope, /^Region( \*)?$/i, env.AWS_REGION || 'us-east-1');
      await fillIfPresent(scope, /Access Key ID/i, env.AWS_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.AWS_SECRET_ACCESS_KEY!);

      // The old "Key Prefix" (advanced panel) is now "Location", top-level beside
      // the bucket: the folder inside the bucket this warehouse writes under.
      if (env.AWS_KEY_PREFIX) {
        await fillIfPresent(scope, /^Location$/i, env.AWS_KEY_PREFIX);
      }

      // Client access is ONE exclusive choice now — remote signing and STS are no
      // longer two independent switches. LoQE writes from the browser need vended
      // credentials, so pick STS; without it the vended access-key creds write to
      // the bucket root and the browser write 404s.
      if (env.AWS_STS_ROLE_ARN) {
        await chooseVendedCredentials(scope, env.AWS_STS_ROLE_ARN);
      }
    },
  },
  {
    key: 'r2 (cloudflare)',
    tab: /Cloudflare R2|^R2$/i,
    enabled: cloud('R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.R2_BUCKET!);
      await fillIfPresent(scope, /Access Key ID/i, env.R2_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.R2_SECRET_ACCESS_KEY!);
      await fillIfPresent(scope, /Account ID/i, env.R2_ACCOUNT_ID!);
    },
  },
  {
    key: 'adls (azure)',
    tab: /Azure|ADLS/i,
    enabled: cloud('ADLS_ACCOUNT_NAME', 'ADLS_FILESYSTEM', 'ADLS_CLIENT_ID', 'ADLS_CLIENT_SECRET', 'ADLS_TENANT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Account name( \*)?$/i, env.ADLS_ACCOUNT_NAME!);
      await fillIfPresent(scope, /^Filesystem( \*)?$/i, env.ADLS_FILESYSTEM!);
      await fillIfPresent(scope, /^Client ID( \*)?$/i, env.ADLS_CLIENT_ID!);
      await fillIfPresent(scope, /^Client secret( \*)?$/i, env.ADLS_CLIENT_SECRET!);
      await fillIfPresent(scope, /^Tenant ID( \*)?$/i, env.ADLS_TENANT_ID!);
    },
  },
  {
    key: 'onelake (fabric)',
    // Workspace/Lakehouse ids replaced the account-name/filesystem pair in 0.23.
    tab: /OneLake/i,
    enabled: cloud('ONELAKE_WORKSPACE_ID', 'ONELAKE_LAKEHOUSE_ID', 'ONELAKE_CLIENT_ID', 'ONELAKE_CLIENT_SECRET', 'ONELAKE_TENANT_ID'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Workspace ID( \*)?$/i, env.ONELAKE_WORKSPACE_ID!);
      await fillIfPresent(scope, /^Lakehouse ID( \*)?$/i, env.ONELAKE_LAKEHOUSE_ID!);
      await fillIfPresent(scope, /^Client ID( \*)?$/i, env.ONELAKE_CLIENT_ID!);
      await fillIfPresent(scope, /^Client secret( \*)?$/i, env.ONELAKE_CLIENT_SECRET!);
      await fillIfPresent(scope, /^Tenant ID( \*)?$/i, env.ONELAKE_TENANT_ID!);
    },
  },
  {
    key: 'gcs (google)',
    tab: /Google Cloud|GCS/i,
    enabled: cloud('GCS_BUCKET', 'GCS_SERVICE_ACCOUNT_KEY'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.GCS_BUCKET!);
      // GCS uses a service-account JSON key — pasted into the key field.
      await fillIfPresent(scope, /Service account key/i, env.GCS_SERVICE_ACCOUNT_KEY!);
    },
  },
  // New in 0.23: Alibaba Cloud OSS and STACKIT. STACKIT's field guidance is
  // specific — bucket NAME only (never s3://…), and the credential-group URN
  // must be copied verbatim.
  {
    key: 'oss (alibaba)',
    tab: /Alibaba OSS|Aliyun/i,
    enabled: cloud('ALIYUN_OSS_BUCKET', 'ALIYUN_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_SECRET_ACCESS_KEY', 'ALIYUN_OSS_ENDPOINT'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.ALIYUN_OSS_BUCKET!);
      await fillIfPresent(scope, /^Endpoint( \*)?$/i, env.ALIYUN_OSS_ENDPOINT!);
      await fillIfPresent(scope, /^Region( \*)?$/i, env.ALIYUN_OSS_REGION || 'oss-eu-central-1');
      await fillIfPresent(scope, /Access Key ID/i, env.ALIYUN_OSS_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.ALIYUN_OSS_SECRET_ACCESS_KEY!);
    },
  },
  {
    key: 'stackit',
    tab: /STACKIT/i,
    enabled: cloud('STACKIT_BUCKET', 'STACKIT_ACCESS_KEY_ID', 'STACKIT_SECRET_ACCESS_KEY'),
    fill: async (scope) => {
      await fillIfPresent(scope, /^Bucket( \*)?$/i, env.STACKIT_BUCKET!);
      await fillIfPresent(scope, /^Region( \*)?$/i, env.STACKIT_REGION || 'eu01');
      await fillIfPresent(scope, /Access Key ID/i, env.STACKIT_ACCESS_KEY_ID!);
      await fillIfPresent(scope, /Secret Access Key/i, env.STACKIT_SECRET_ACCESS_KEY!);
      if (env.STACKIT_CREDENTIALS_GROUP_URN) {
        const sts = scope.getByLabel(/Vended credentials \(STS\)/i).filter({ visible: true }).first();
        if (await sts.isVisible().catch(() => false)) {
          await sts.check().catch(() => sts.click().catch(() => {}));
        }
        await fillIfPresent(scope, /Credentials group URN/i, env.STACKIT_CREDENTIALS_GROUP_URN);
      }
    },
  },
];

export const ENABLED_BACKENDS = STORAGE_BACKENDS.filter((b) => b.enabled);
