import { Page, Locator, expect } from '@playwright/test';

// Maintenance lives in console-plus only: the task-queue config, the per-object
// schedule pane and the project-wide dashboard all come from
// console-plus-components. The OSS console has no equivalent surface, so every
// spec using these helpers has to skip on `console`.
export const isPlusApp =
  process.env.SERVED_UI === '1'
    ? process.env.SERVED_APP === 'console-plus'
    : (process.env.APP || 'console') === 'console-plus';

/** The Maintenance modal — warehouse or table, both carry the same rail. */
export function maintenanceDialog(page: Page): Locator {
  return page
    .locator('.v-overlay__content')
    .filter({ hasText: /Maintenance —/ })
    .last();
}

/**
 * Open Maintenance from a warehouse or table header cog.
 *
 * Same shape as `openWarehouseSettings`: the entry is an option in a v-menu
 * whose activator repeats its label, so a bare getByText can re-toggle the menu
 * instead of choosing the entry. Retry until the modal is actually up.
 */
export async function openMaintenance(page: Page): Promise<Locator> {
  const dialog = maintenanceDialog(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await dialog.isVisible().catch(() => false)) return dialog;
    // Icon-only button, so it has no accessible name.
    await page.locator('button:has(.mdi-cog)').first().click().catch(() => {});
    const option = page.getByRole('option', { name: /^maintenance$/i }).first();
    if (await option.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await option.click().catch(() => {});
    } else {
      await page.getByText('Maintenance', { exact: true }).last().click().catch(() => {});
    }
    if (await dialog.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
      return dialog;
    }
  }
  await expect(dialog, 'Maintenance dialog never opened').toBeVisible({ timeout: 15000 });
  return dialog;
}

/** Pick a pane on the Maintenance rail ("Schedule task" / "Task configuration"). */
export async function selectMaintenancePane(dialog: Locator, name: RegExp) {
  const tab = dialog.getByRole('tab', { name }).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await tab.click({ timeout: 8000 }).catch(() => {});
    if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') return;
  }
  await expect(tab, `maintenance pane ${name} never selected`).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 10000 },
  );
}

/**
 * The optimize tab of the Task configuration pane.
 *
 * The pane shows one tab per queue; optimize is the one this suite cares about
 * because its config key was renamed (`enabled` -> `enable-optimize`) and a
 * stale client writes a field the server refuses outright.
 */
export async function selectOptimizeConfigTab(dialog: Locator) {
  const tab = dialog.getByRole('tab', { name: /optimize/i }).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await tab.click({ timeout: 8000 }).catch(() => {});
    if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') return;
  }
  await expect(tab, 'optimize config tab never selected').toHaveAttribute('aria-selected', 'true', {
    timeout: 10000,
  });
}

/** Every optimize step the pickers offer, in run order. */
export const OPTIMIZE_STEPS = [
  'Compaction',
  'Rewrite position deletes',
  'Remove dangling deletes',
  'Rewrite manifests',
] as const;

/** The two a run does when nobody narrows it. */
export const OPTIMIZE_DEFAULT_STEPS = ['Compaction', 'Rewrite manifests'] as const;

/** The caption the pickers show only once the pick is narrowed AND includes the
 *  manifest rewrite — the one step whose manual behaviour differs from its
 *  automatic one. */
export const MANIFEST_REWRITE_HINT = /re-packs every manifest of the current partition spec/i;
