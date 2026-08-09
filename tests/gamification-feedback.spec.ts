import { test, expect } from "../fixtures/auth";

/**
 * Gamification feedback layer — the emotional payoff of the check-in loop.
 *
 * Why this matters: the UX audit's #1 finding was that gaining XP was
 * completely silent — the data moved, but the user felt nothing ("a habit
 * tracker that happens to have XP numbers"). The fix renders a floating
 * "+N XP" element (data-testid="xp-float") next to the item the moment
 * POST /routine/check resolves, using the real xpGenerated value from the
 * RefreshUiDTO.
 *
 * The float self-removes after ~1.2s, so this spec clicks and immediately
 * asserts. If the pipeline (response → xpFloats state → XpFloat render)
 * breaks anywhere, this fails.
 */
test.describe("Gamification feedback", () => {
  test("checking a habit shows a floating +XP with the awarded amount", async ({
    authedPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();

    await authedPage.goto("/dashboard");

    const habitRow = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Drink water" });
    const checkbox = habitRow.locator('input[type="checkbox"]').first();
    // The check's input is `sr-only` with the ring drawn on top (the new design's
    // pattern, on the dashboard routine and on the routines page). Clicking the
    // input fails Playwright's hit-target test — what receives the click is the
    // ring, its sibling inside the `<label>`. So click the LABEL, which is what a
    // person actually hits.
    const checkToggle = habitRow.locator('label:has(input[type="checkbox"])').first();
    await expect(checkbox).toBeVisible();

    const xpFloat = authedPage.getByTestId("xp-float");

    await Promise.all([
      authedPage.waitForResponse(
        (response) =>
          response.url().endsWith("/routine/check") && response.ok(),
      ),
      checkToggle.click(),
    ]);

    // The float lives ~1.2s — assert fast, with a generous-but-bounded wait.
    await expect(xpFloat).toBeVisible({ timeout: 2000 });
    await expect(xpFloat).toHaveText(/^\+\d+ XP$/);

    // And it cleans itself up (no lingering absolute-positioned artifacts).
    await expect(xpFloat).toHaveCount(0, { timeout: 3000 });
  });
});
