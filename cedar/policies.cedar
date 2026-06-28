// Base Cedar policy for the console-e2e `cedar` mode. SELF-CONTAINED.
// peter is the instance admin; anna starts with NO grant (denied). Managed by the
// cedar access-control test via _utils/cedar.ts.

permit (
    principal == Lakekeeper::User::"oidc~cfb55bf6-fcbb-4a1e-bfec-30c6649b52f8",
    action,
    resource
);
