import { test, expect } from '@playwright/test';

test('landing page shows hero and navigates to simulation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/CubeSat\s+Solar Panel/i);

  // click Launch Simulation and verify URL changes
  await page.getByRole('button', { name: /Launch Simulation/i }).click();
  await expect(page).toHaveURL(/\/simulate/);

  // basic content on simulate page should be present
  await expect(page.getByText(/Simulation/)).toBeVisible();
});
