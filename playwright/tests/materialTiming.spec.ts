import { test, expect, type Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
//  Browser smoke tests: end-to-end material selection + timing resolution.
//
//  1. Simulation: FR4 → Al-Kapton → CFRP visibly refreshes mass/telemetry and
//     resets any in-progress run.
//  2. Compare: material selector relabels and regenerates the physics runs.
//  3. Report: all three materials appear with their correct masses.
//  4. Compare: δt = 0 vs δt = 5 ms produces a distinct result (staggered release).
// ─────────────────────────────────────────────────────────────────────────────

async function waitForCompareComputed(page: Page) {
  // The computing badge appears while the four physics runs execute (~3.5 s).
  await expect(page.getByText('computing physics runs…')).toBeHidden({ timeout: 60_000 });
}

test('Simulation: material switching refreshes mass/telemetry and resets the run', async ({ page }) => {
  await page.goto('/simulate');

  // Default FR4 with mass in grams, visible in the sidebar and telemetry overlay.
  await expect(page.getByText('Panel: FR4 PCB — 32 g each')).toBeVisible();
  await expect(page.getByText('FR4 PCB (32 g)')).toBeVisible(); // telemetry row

  // Start a run, then switch material mid-run: the run must reset (t = 0, folded).
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.getByRole('radio', { name: /Al \/ Kapton Flex/ }).click();
  await expect(page.getByText('Panel: Al / Kapton Flex — 50 g each')).toBeVisible();
  await expect(page.getByText('Al / Kapton Flex (50 g)')).toBeVisible();
  await expect(page.getByText('0.00s', { exact: true })).toBeVisible();       // time reset
  await expect(page.getByText('0%', { exact: true })).toBeVisible();          // folded
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible(); // paused

  await page.getByRole('radio', { name: /CFRP Composite/ }).click();
  await expect(page.getByText('Panel: CFRP Composite — 20 g each')).toBeVisible();
  await expect(page.getByText('CFRP Composite (20 g)')).toBeVisible();
});

test('Compare: material selector relabels and regenerates runs', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/compare');

  await expect(page.getByText('Material: FR4 PCB (32 g/panel)')).toBeVisible();
  await waitForCompareComputed(page);

  await page.getByRole('radio', { name: /CFRP/ }).click();
  await expect(page.getByText('Material: CFRP Composite (20 g/panel)')).toBeVisible();
  await waitForCompareComputed(page);

  // Summary table renders real deployment times from the physics runs (~20 s latch).
  const deployCells = page.locator('table tbody tr td:last-child');
  await expect(deployCells.first()).not.toHaveText('0.00');
});

test('Report: all three materials present with correct masses', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/report');

  // Async physics sweep with progress, then 48 rows.
  await expect(page.getByText(/Running physics-driven scenario sweep/)).toBeVisible();
  await expect(page.getByTestId('report-row')).toHaveCount(48, { timeout: 150_000 });

  const rows = page.getByTestId('report-row');
  await expect(rows.filter({ hasText: 'FR4' }).first()).toContainText('0.032');
  await expect(rows.filter({ hasText: 'Al/Kapton' }).first()).toContainText('0.050');
  await expect(rows.filter({ hasText: 'CFRP' }).first()).toContainText('0.020');
  expect(await rows.filter({ hasText: 'FR4' }).count()).toBe(16);
  expect(await rows.filter({ hasText: 'Al/Kapton' }).count()).toBe(16);
  expect(await rows.filter({ hasText: 'CFRP' }).count()).toBe(16);
});

test('Compare: staggered δt produces a distinct result; 5 ms preset regenerates', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/compare');
  await waitForCompareComputed(page);

  // Snapshot the Peak ω column at ideal sync (δt = 0).
  const peakCells = page.locator('table tbody tr td:nth-child(3)');
  const before = await peakCells.allTextContents();

  // Numeric distinctness at DISPLAY precision needs a stagger whose body-rate
  // transient exceeds the table's 2-decimal °/s resolution: use δt = 50 ms.
  // (A 5 ms stagger IS distinct at engine level — pinned by
  // timingResolution.test.ts — but its ~0.003 °/s transient rounds away in the
  // displayed table, so asserting on the 5 ms table text would be meaningless.)
  await page.locator('input[type="number"]').first().fill('50');
  await page.getByRole('button', { name: 'ms', exact: true }).click();
  await waitForCompareComputed(page);
  const after50 = await peakCells.allTextContents();
  expect(after50).not.toEqual(before);

  // The Worst-case 5 ms preset still triggers a full physics regeneration and
  // the caption states the 0.83 ms timing resolution honestly.
  await page.getByRole('button', { name: 'Worst-case (5 ms)' }).click();
  await expect(page.getByText('computing physics runs…')).toBeVisible();
  await waitForCompareComputed(page);
  await expect(page.getByText(/0\.83 ms \(1\/1200 s\)/)).toBeVisible();
});
