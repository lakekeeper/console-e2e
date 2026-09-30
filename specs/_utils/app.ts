import { expect, Page } from '@playwright/test';

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

/**
 * Ask again when the DEV SERVER, not the app, killed the page's boot.
 *
 * When vite re-optimizes its dep bundle mid-run it answers requests already in
 * flight with 504 "Outdated Optimize Dep". A route loaded by dynamic import then
 * fails to import, the router never starts ([VUE_ROUTER_R0011]), and the browser
 * is left on a URL vite answers with its own "configured with a public base URL
 * of /ui/" notice — a page with no app in it at all, which reads downstream as
 * "the alert never appeared". Nothing is wrong with the app and the next request
 * is served normally, so just ask again.
 */
export async function recoverFromDeadBoot(page: Page, path: string, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (await page.locator('.v-application').count().catch(() => 0)) return;
    await page.goto(path).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);
  }
}

/** goto a path and shake off the transient server-offline page (auth race). */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await recoverFromDeadBoot(page, path);
  await recoverFromOffline(page);
}

/**
 * A tab pane can be mounted, sized, and still show nothing.
 *
 * Vuetify's `crossfade` puts a permanent `mix-blend-mode: plus-lighter` on every
 * window item — not only while a transition runs. On a light surface that blends
 * the pane into its background, so the content is laid out and invisible, while
 * every ordinary assertion (node present, `.v-application` visible, no error
 * text) still passes. That exact failure shipped three times before anyone
 * looked at the CSS, and the deep-link smoke test walked straight past it.
 *
 * Asserts the pixels can carry content, not just that the DOM is there.
 */
export async function expectPanesReadable(page: Page, where: string) {
  const blended = await page.evaluate(() =>
    [...document.querySelectorAll('.v-window-item, .v-window__container')]
      .map((el) => ({ cls: el.className, blend: getComputedStyle(el).mixBlendMode }))
      .filter((x) => x.blend !== 'normal'),
  );
  expect(blended, `${where}: window panes must not be blended into their background`).toEqual([]);

  // Every pane stays in the DOM — VWindowItem toggles with v-show — so the one
  // on screen has to be picked by visibility, not by position.
  const pane = page.locator('.v-window-item:visible').first();
  if (await pane.count()) {
    const text = (await pane.innerText().catch(() => '')).trim();
    expect(text.length, `${where}: the visible pane has no text`).toBeGreaterThan(0);
  }
}
