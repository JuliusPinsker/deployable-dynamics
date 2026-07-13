import { test, expect, type Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
//  Simulation reseed lifecycle regression coverage.
//
//  Guards the invariant that EVERY reseed action — Reset, configuration change,
//  failure-mode change, and Initial Tumble (ω₀) change — cancels the running
//  animation and rebuilds a fresh folded/paused state from the latest selection.
//  Regression context: the ω₀ feature initially shipped with a missing `Vector3`
//  import, so every reseed handler threw a ReferenceError mid-handler and the
//  page stayed stuck in the completed-deployment state.
// ─────────────────────────────────────────────────────────────────────────────

// Telemetry-derived fixtures (TelemetryOverlay renders these exact strings):
//  - Deploy row:  "0%" folded … "100%" fully deployed
//  - Time row:    "0.00s" at a fresh reseed
//  - ω rows:      formatOmegaDegPerSec → "0.00°/s" at rest, "10.00°/s" for the 10°/s preset
const FOLDED = '0%';
const DEPLOYED = '100%';
const TIME_ZERO = '0.00s';
const OMEGA_ZERO = '0.00°/s';

async function gotoSimulation(page: Page) {
  await page.goto('/simulate');
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible();
  await expect(page.getByText(FOLDED, { exact: true })).toBeVisible();
}

/** Click Deploy and wait until the panels report fully deployed (long-edge ≈ 0.4 s). */
async function deployToCompletion(page: Page) {
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByText(DEPLOYED, { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Assert the sim was reseeded: folded panels, t=0, paused (Deploy button back). */
async function expectReseeded(page: Page) {
  await expect(page.getByText(FOLDED, { exact: true })).toBeVisible();
  await expect(page.getByText(TIME_ZERO, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible();
}

test('Reset after a completed deployment returns to the folded state', async ({ page }) => {
  await gotoSimulation(page);
  await deployToCompletion(page);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expectReseeded(page);
});

test('changing failure mode after deployment reseeds the new scenario', async ({ page }) => {
  await gotoSimulation(page);
  await deployToCompletion(page);

  await page.getByRole('button', { name: /1 Panel Stuck/ }).click();
  await expectReseeded(page);
  // The new scenario is active, not left at 100%: stuck-panel banner + stuck status row.
  await expect(page.getByText(/1 Panel Stuck — Asymmetric Inertia/)).toBeVisible();
  await expect(page.getByText(/Stuck @ 0°/)).toBeVisible();
});

test('changing configuration after deployment reseeds the new configuration', async ({ page }) => {
  await gotoSimulation(page);
  await deployToCompletion(page);

  await page.getByRole('button', { name: /Coupled/ }).click();
  await expectReseeded(page);
  // New config really took over: the coupled layout lists 8 panel status rows.
  await expect(page.getByText('Panel 8', { exact: true })).toBeVisible();
});

test('selecting a nonzero ω₀ preset after deployment reseeds with the chosen spin', async ({ page }) => {
  await gotoSimulation(page);
  await deployToCompletion(page);

  await page.getByRole('button', { name: /Typical/ }).click();
  await expectReseeded(page);
  // Telemetry shows the selected initial rate about Z (preset applies ω₀ = (0, 0, 10°/s)).
  await expect(page.getByText('10.00°/s', { exact: true })).toBeVisible();
  // Deploy immediately starts a fresh run from the tumbling state.
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('At rest preset preserves the original zero-spin behavior', async ({ page }) => {
  await gotoSimulation(page);
  // Fresh page starts at rest: all three ω components read exactly 0.00°/s.
  await expect(page.getByText(OMEGA_ZERO, { exact: true })).toHaveCount(3);

  // Round-trip through a tumbling preset and back.
  await page.getByRole('button', { name: /Typical/ }).click();
  await expect(page.getByText(OMEGA_ZERO, { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: /At rest/ }).click();
  await expect(page.getByText(OMEGA_ZERO, { exact: true })).toHaveCount(3);
  await expectReseeded(page);
});
