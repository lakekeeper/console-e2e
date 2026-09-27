import { expect, Locator, Page } from '@playwright/test';

/**
 * Layout assertions for LONG lists.
 *
 * Both apps pin the shell to the viewport — `body { position: fixed; overflow:
 * hidden; height: 100% }` + `#app { height: 100vh }` (Safari bounce + trackpad
 * back-gesture prevention) — and `v-main` is not scrollable either. So there is
 * no page-level scrollbar anywhere: every page has to build its OWN bounded
 * `overflow-y: auto` region, and a table that forgets to is simply CLIPPED by
 * the body with no way to reach the rows below the fold.
 *
 * That failure is invisible to ordinary assertions: the rows are in the DOM,
 * the table is "visible", nothing errors — the user just cannot get to them.
 * These helpers assert the geometry instead, and they only mean anything when
 * the list is longer than the viewport, which is why the specs that use them
 * seed hundreds of rows first.
 */

/** px of slack for sub-pixel rounding. A clipped list overflows by hundreds. */
const SLACK = 8;

/**
 * The document must not scroll — neither by the browser's own scrollbar nor by
 * content the fixed body silently clips.
 *
 * `body.scrollHeight > body.clientHeight` is the interesting half: with
 * `overflow: hidden` the browser reports no scrollable document, so a page that
 * overflows looks fine to `window.scrollY` checks while the surplus is
 * unreachable.
 */
export async function expectNoPageScroll(page: Page, where: string) {
  const m = await page.evaluate(() => {
    const de = document.scrollingElement || document.documentElement;
    return {
      doc: de.scrollHeight - de.clientHeight,
      body: document.body.scrollHeight - document.body.clientHeight,
    };
  });
  expect(m.doc, `${where}: the document itself must not scroll (the app shell is fixed)`).toBeLessThanOrEqual(SLACK);
  expect(
    m.body,
    `${where}: content overflows <body>, which is overflow:hidden — those rows are clipped and unreachable`,
  ).toBeLessThanOrEqual(SLACK);
}

/** The scroll container of a `v-data-table` that was given a `height`. */
function tableViewport(table: Locator) {
  return table.locator('.v-table__wrapper').first();
}

/**
 * A long table must fit the viewport and scroll INSIDE itself.
 *
 * Asserts, in order: the table's own scroll region has a real height and ends
 * above the fold; it declares an overflow; it actually has more content than
 * fits; scrolling it moves; and the last row becomes reachable while the
 * `fixed-header` stays pinned.
 */
export async function expectTableScrollsWithinViewport(page: Page, table: Locator, where: string) {
  await expect(table, `${where}: no data table on screen`).toBeVisible({ timeout: 20000 });
  const viewport = tableViewport(table);
  await expect(viewport, `${where}: the data table has no scroll wrapper`).toBeVisible({ timeout: 10000 });

  const m = await viewport.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
      top: r.top,
      bottom: r.bottom,
      innerHeight: window.innerHeight,
    };
  });

  expect(m.clientHeight, `${where}: the table's scroll region collapsed to ${m.clientHeight}px`).toBeGreaterThan(120);
  expect(
    Math.round(m.bottom),
    `${where}: the table ends ${Math.round(m.bottom - m.innerHeight)}px below the fold — it is not bounded to the page height`,
  ).toBeLessThanOrEqual(m.innerHeight + SLACK);
  expect(['auto', 'scroll'], `${where}: the table's scroll region is overflow:${m.overflowY}`).toContain(m.overflowY);
  expect(
    m.scrollHeight,
    `${where}: the seeded rows do not overflow the table — the test is not exercising scrolling`,
  ).toBeGreaterThan(m.clientHeight + 50);

  // It scrolls, and it lands where it was asked to.
  const scrolled = await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, `${where}: the table did not scroll`).toBeGreaterThan(0);

  // …and the rows below the fold are genuinely reachable, with the header still
  // pinned above them (the point of `fixed-header`).
  await expect(
    table.locator('tbody tr').last(),
    `${where}: the last row is not on screen after scrolling to the bottom`,
  ).toBeInViewport({ timeout: 10000 });
  await expect(
    table.locator('thead').first(),
    `${where}: the fixed header scrolled away with the rows`,
  ).toBeInViewport({ timeout: 5000 });

  await expectNoPageScroll(page, where);
}

/** The visible data table on the current page (both apps render exactly one per pane). */
export function visibleDataTable(page: Page) {
  return page.locator('.v-data-table').filter({ visible: true }).first();
}
