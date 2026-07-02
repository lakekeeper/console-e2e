import { Page, expect } from '@playwright/test';

export interface AuthCredentials {
  username: string;
  password: string;
}

export const TEST_MODE = process.env.TEST_MODE || 'authn';
export const isAuthMode = TEST_MODE !== 'noauth';

// Instance admin (bootstraps the server, can do everything).
export const TEST_USER: AuthCredentials = {
  username: process.env.TEST_USERNAME || 'peter',
  password: process.env.TEST_PASSWORD || 'iceberg',
};

// Second, NON-admin user — used to prove permission enforcement in authz/cedar:
// they should be DENIED actions the admin can do.
export const TEST_USER_2: AuthCredentials = {
  username: process.env.TEST_USERNAME_2 || 'anna',
  password: process.env.TEST_PASSWORD_2 || 'iceberg',
};

/**
 * OIDC login through Keycloak. No-op in noauth mode (no login screen).
 */
export async function login(page: Page, credentials: AuthCredentials = TEST_USER) {
  // Served-UI (docker image) mode: the console lives under /ui/ on the lakekeeper
  // origin, and `/` is the API root (not the SPA). The npm dev server serves the
  // SPA at `/`, so keep that path there.
  await page.goto(process.env.SERVED_UI === '1' ? '/ui/' : '/');

  if (!isAuthMode) return; // noauth: app is reachable directly

  const { username, password } = credentials;

  const alreadyAuthenticated = await page
    .locator('[data-testid="user-menu"], .v-app-bar')
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (alreadyAuthenticated) return;

  const loginButton = page
    .locator('button:has-text("Login"), button:has-text("Sign In"), [data-testid="login-button"]')
    .first();

  // Click "Sign In" and wait for the actual redirect to Keycloak. The app's OIDC
  // client can init slightly after the button paints (more so in console-plus,
  // which boots heavier), so retry the click until the redirect happens.
  const onKeycloak = () => /\/realms\/iceberg\//.test(page.url());
  for (let attempt = 0; attempt < 3 && !onKeycloak(); attempt++) {
    if (await loginButton.isVisible({ timeout: 8000 }).catch(() => false)) {
      await loginButton.click().catch(() => {});
    }
    await page.waitForURL(/\/realms\/iceberg\//, { timeout: 8000 }).catch(() => {});
  }

  const keycloakFormVisible = await page
    .locator('#kc-form-login, input[name="username"], input[id="username"]')
    .first()
    .isVisible({ timeout: 10000 })
    .catch(() => false);

  if (keycloakFormVisible) {
    const usernameField = page
      .locator('input[name="username"]')
      .or(page.locator('#username'))
      .or(page.locator('input[id="username"]'))
      .first();
    await usernameField.waitFor({ state: 'visible', timeout: 5000 });
    await usernameField.fill(username);

    const passwordField = page
      .locator('input[name="password"]')
      .or(page.locator('#password'))
      .or(page.locator('input[id="password"]'))
      .first();
    await passwordField.fill(password);

    const submit = page
      .locator('input[type="submit"]')
      .or(page.locator('button[type="submit"]'))
      .or(page.locator('#kc-login'))
      .first();
    await submit.click();

    await page.waitForURL(/\/(ui\/)?callback/, { timeout: 15000 });
    await page.waitForURL(/\/$|\/ui\/$|\/ui\/bootstrap/, { timeout: 15000 });
  }
}

export async function logout(page: Page) {
  const userMenu = page.locator('[data-testid="user-menu"], .v-app-bar .v-avatar').first();
  if (await userMenu.isVisible({ timeout: 5000 }).catch(() => false)) {
    await userMenu.click();
    const logoutButton = page
      .locator('[data-testid="logout-button"], .v-list-item:has-text("Logout"), button:has-text("Logout")')
      .first();
    await logoutButton.click();
  } else {
    await page.goto('/ui/logout');
  }
  await page.waitForURL(/\/ui\/login/, { timeout: 10000 });
}

export async function clearSession(page: Page) {
  try {
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
  } catch {
    /* page may not be loaded yet */
  }
}
