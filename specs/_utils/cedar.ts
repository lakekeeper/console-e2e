import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cedar "grant" = editing the policy file Lakekeeper loads (/policies/policies.cedar,
// bind-mounted from console-e2e/cedar/). Lakekeeper hot-reloads it. Unlike FGA, a
// table grant is NOT enough — Cedar needs every level permitted explicitly
// (Project/Warehouse/Namespace Describe + TableSelect + IntrospectTableAuthorization).
// We rewrite the WHOLE file (base ± anna block) so state is deterministic.

const dir = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = path.resolve(dir, '../../cedar/policies.cedar');

const BASE = `// Base Cedar policy for the console-e2e \`cedar\` mode. SELF-CONTAINED.
// peter is the instance admin; anna starts with NO grant (denied). Managed by the
// cedar access-control test via _utils/cedar.ts.

permit (
    principal == Lakekeeper::User::"oidc~cfb55bf6-fcbb-4a1e-bfec-30c6649b52f8",
    action,
    resource
);
`;

// anna's OIDC sub (from the iceberg realm). Cedar principals are lowercase oidc~<id>.
const ANNA = 'oidc~d223d88c-85b6-4859-b5c5-27f3825e47f6';

function annaTableReadBlock(wh: string) {
  return `
// GRANT (added live by the access-control test): anna may read tables in ${wh}.
permit (
    principal == Lakekeeper::User::"${ANNA}",
    action in [
        Lakekeeper::Action::"ProjectDescribeActions",
        Lakekeeper::Action::"WarehouseDescribeActions",
        Lakekeeper::Action::"NamespaceDescribeActions",
        Lakekeeper::Action::"TableSelectActions",
        Lakekeeper::Action::"IntrospectTableAuthorization"
    ],
    resource
)
when {
    resource is Lakekeeper::Project
    || (resource is Lakekeeper::Warehouse && resource.name == "${wh}")
    || (resource is Lakekeeper::Namespace && resource.warehouse.name == "${wh}")
    || (resource is Lakekeeper::Table && resource.warehouse.name == "${wh}")
};
`;
}

/** Reset the policy to base (anna denied). */
export function resetCedarPolicy() {
  fs.writeFileSync(POLICY_FILE, BASE);
}

/** Append anna's table-read grant for the given warehouse (anna allowed). */
export function grantAnnaTableReadCedar(wh: string) {
  fs.writeFileSync(POLICY_FILE, BASE + annaTableReadBlock(wh));
}
