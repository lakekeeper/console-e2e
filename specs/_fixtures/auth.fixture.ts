import { test as base, expect, Page } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';
import { login, isAuthMode, TEST_USER } from '../_utils/auth';

type AuthFixtures = {
  authenticatedPage: Page; // logged in (or direct access in noauth)
  bootstrappedPage: Page; // logged in AND server bootstrapped
  _coverage: void; // auto fixture: collect V8 coverage (chromium, E2E_COVERAGE=1)
};

/**
 * Drives the bootstrap stepper if the server isn't bootstrapped yet.
 * Stepper: 1) Global Admin → Next, 2) EULA (must scroll to bottom) → Next,
 * 3) Submit → Accept. Works for both auth and noauth modes (fresh DB per run).
 */
async function ensureBootstrapped(page: Page) {
  if (!page.url().includes('/bootstrap')) {
    await page.goto('/ui/bootstrap').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!page.url().includes('bootstrap')) return; // already bootstrapped
  }

  const next = page.getByRole('button', { name: 'Next' });

  // Step 1 → 2
  await next.waitFor({ state: 'visible', timeout: 10000 });
  await next.click();

  // Step 2 (EULA): force the overflow container to the bottom and fire a scroll
  // event so the component enables Next, then advance.
  await page.waitForTimeout(500);
  await expect(next).toBeDisabled({ timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('div')).filter(
      (d) => d.scrollHeight > d.clientHeight && getComputedStyle(d).overflowY === 'auto',
    );
    for (const c of containers) {
      c.scrollTop = c.scrollHeight;
      c.dispatchEvent(new Event('scroll'));
    }
  });
  await expect(next).toBeEnabled({ timeout: 5000 });
  await next.click();

  // Step 3 (Submit)
  const accept = page.getByRole('button', { name: 'Accept' });
  await accept.waitFor({ state: 'visible', timeout: 5000 });
  await accept.click();

  // Bootstrap done → app redirects off /bootstrap.
  await page.waitForURL((url) => !url.pathname.includes('bootstrap'), { timeout: 25000 });
}

export const test = base.extend<AuthFixtures>({
  // V8 code coverage, auto-applied to every test's main page. Chromium-only (the
  // CDP coverage API), and only when E2E_COVERAGE=1 so normal runs pay no cost.
  // Captures the peter/bootstrapped page (the bulk of the journeys); anna's
  // separate browser contexts aren't covered. monocart maps it through sourcemaps.
  _coverage: [
    async ({ page, browserName }, use, testInfo) => {
      const on = browserName === 'chromium' && process.env.E2E_COVERAGE === '1';
      if (on) await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      if (on) {
        const entries = await page.coverage.stopJSCoverage();
        await addCoverageReport(entries, testInfo);
      }
    },
    { auto: true },
  ],

  authenticatedPage: async ({ page }, use) => {
    await login(page, TEST_USER);
    await use(page);
  },

  bootstrappedPage: async ({ page }, use) => {
    await login(page, TEST_USER);
    await ensureBootstrapped(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
export { isAuthMode };
