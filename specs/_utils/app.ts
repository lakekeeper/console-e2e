import { Page } from '@playwright/test';

// The router's beforeEach guard calls getServerInfo(); if the access token hasn't
// hydrated yet, that call goes out as "Bearer undefined" → 401 → empty serverInfo,
// and the guard bounces to /ui/server-offline ("Lakekeeper Unreachable / Check
// status"). Lakekeeper is NOT actually down — it's the token-hydration race. A
// reload (or the page's own "Check status" button) re-runs the guard once the
// token is in place. Recover from it before interacting with the real page.
export async function recoverFromOffline(page: Page, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (!/\/ui\/server-offline/.test(page.url())) return;
    // The page's "Check status" button re-runs getServerInfo(); fall back to reload.
    const check = page.getByRole('button', { name: /check status/i });
    if (await check.isVisible().catch(() => false)) await check.click().catch(() => {});
    else await page.reload().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
  }
}

/** goto a path and shake off the transient server-offline page (auth race). */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await recoverFromOffline(page);
}
