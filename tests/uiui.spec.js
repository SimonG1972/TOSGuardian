// tests/uiui.spec.js
const { test, expect } = require('@playwright/test');

test('compose → run check → rulebook', async ({ page }) => {
  // Use absolute URL so local/CI behave the same
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#scanBtn', { state: 'visible' });

  // Platform switch affects labels / visibility
  const platform = page.locator('#platform');
  await platform.selectOption('instagram');

  await expect(page.locator('#labelTitle')).toContainText(/Post title/i);
  await expect(page.locator('#captionWrap')).toBeHidden();

  // Turn on Advanced → caption appears for instagram
  // Programmatic toggle avoids overlay/visibility flakes
  await page.evaluate(() => {
    const el = document.querySelector('#simpleAdvanced');
    if (el && !el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(page.locator('#captionWrap')).toBeVisible();

  // Fill fields
  await page.fill('#title', 'Sunday garden tips');
  await page.fill('#description', 'Sharing helpful tips for repotting plants.');
  await page.fill('#caption', 'Happy weekend!');

  // ---- Run check (robust wait) ----
  // Set the waiter BEFORE clicking so we don't miss a fast response
  const respPromise = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes('/api/check'),
    { timeout: 15000 }
  );

  await page.click('#scanBtn');
  const resp = await respPromise;

  if (!resp.ok()) {
    const status = resp.status();
    const text = await resp.text().catch(() => '');
    throw new Error(`/api/check did not return 200. Status ${status}. Body: ${text}`);
  }

  // Status should leave the initial “Checking…”/“Waiting…” state
  await expect(page.locator('#status')).not.toHaveText(/Checking…|Waiting…/);

  // Results container should be visible even if lists are empty
  const results = page.locator('#results, #analysis, #outcome, #issues, #fixes');
  await expect(results.first()).toBeVisible();

  // Switch platform, ensure fields react
  await platform.selectOption('pinterest');

  // Wait for the Pinterest rulebook fetch to complete before expanding
  await page.waitForResponse(
    r => r.url().includes('/api/rules/pinterest') && r.ok(),
    { timeout: 5000 }
  );

  await expect(page.locator('#labelTitle')).toContainText(/Pin title/i);

  // Rulebook summary present, expand, edit cancel
  await expect(page.locator('#rbSummary')).toBeVisible();
  await page.click('#rbToggle'); // Expand
  await expect(page.locator('#rulebookPre')).toBeVisible();

  await page.click('#rbEdit');
  await expect(page.locator('#rulebookText')).toBeVisible();
  await page.click('#rbCancel');
  await expect(page.locator('#rulebookText')).toBeHidden();
});
