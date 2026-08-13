import { test, expect } from "../fixtures/auth";
import { fixtureFor } from "../fixtures/onboardingSuggestions";

/**
 * AI personalized onboarding coverage.
 *
 * The intro modal's fork screen offers "Personalized setup" (AI wizard) vs
 * "Hands-on tour" (the spotlight walkthrough covered by tutorial.spec.ts).
 *
 * ONLY `POST /onboarding/suggestions` is intercepted — the wizard creates
 * every accepted category/habit/task/routine/goal through the REAL backend,
 * so a green run proves the whole create-from-suggestions pipeline works
 * end to end, not just the wizard UI.
 */
test.describe("AI personalized onboarding", () => {
  test("full AI path creates real entities and lands on a populated app", async ({
    freshAuthedPage: page,
  }) => {
    test.setTimeout(90_000);

    // The category chips float on an infinite framer-motion loop, so Playwright
    // never considers them "stable" enough to click. The wizard honors
    // prefers-reduced-motion (useReducedMotion), which disables the float —
    // emulate it instead of force-clicking moving targets. (test.use() would
    // not reach the fixture-built context, so emulate on the page directly.)
    await page.emulateMedia({ reducedMotion: "reduce" });

    // ONLY the AI suggestion endpoint is stubbed — entity creation hits the
    // real backend. The API origin is :8099, hence the cross-origin glob.
    await page.route("**/onboarding/suggestions", async (route) => {
      const body = route.request().postDataJSON() as { step: string };
      await route.fulfill({ json: fixtureFor(body.step) });
    });

    await test.step("intro cards -> fork -> choose personalized", async () => {
      await page.goto("/dashboard");
      for (let i = 0; i < 4; i++) {
        await page.getByRole("button", { name: "Next" }).click();
      }
      await page.getByRole("button", { name: "Get Started" }).click();
      await expect(page.getByText("How do you want to start?")).toBeVisible();
      // The fork cards carry aria-labels with the path titles.
      await page.getByRole("button", { name: "Personalized setup" }).click();
    });

    await test.step("categories: pick two chips and continue", async () => {
      await expect(
        page.getByText("Which parts of your life do you want to improve?"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Health", exact: true }).click();
      await page.getByRole("button", { name: "Career", exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
    });

    await test.step("habits & tasks: select all habits + the task", async () => {
      await expect(page.getByText("Habits & tasks for you")).toBeVisible();
      // One "Select all" per group: habits first, tasks second.
      const selectAlls = page.getByRole("button", { name: "Select all" });
      await selectAlls.first().click();
      await selectAlls.last().click();
      await page.getByRole("button", { name: "Continue" }).click();
    });

    await test.step("routine: accept the draft", async () => {
      await expect(page.getByText("Your daily routine draft")).toBeVisible();
      await expect(page.getByText("Morning run")).toBeVisible();
      await page.getByRole("button", { name: "Accept routine" }).click();
    });

    await test.step("goals: select and continue", async () => {
      await expect(page.getByText("Goals to aim for")).toBeVisible();
      await page.getByRole("button", { name: /Run a 10k/ }).click();
      await page.getByRole("button", { name: "Continue" }).click();
    });

    await test.step("summary -> start using -> tutorial completed", async () => {
      await expect(page.getByText("You're all set!")).toBeVisible();
      await expect(page.getByText("AI Starter Routine")).toBeVisible();
      await page.getByRole("button", { name: "Start using Beyou" }).click();
      // completeTutorial persists the backend flag then clears the local phase.
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              window.localStorage.getItem("beyou.tutorial.phase"),
            ),
          { timeout: 10_000 },
        )
        .toBeNull();
    });

    await test.step("entities are real: categories page shows them", async () => {
      await page.goto("/categories");
      await expect(page.getByText("Health").first()).toBeVisible();
      await expect(page.getByText("Career").first()).toBeVisible();
    });
  });

  test("AI failure offers the hands-on tour fallback", async ({
    freshAuthedPage: page,
  }) => {
    // Same reduced-motion emulation as above: stop the chip float animation.
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.route("**/onboarding/suggestions", (route) =>
      route.fulfill({
        status: 400,
        json: { errorKey: "AI_UNAVAILABLE", message: "down" },
      }),
    );

    await page.goto("/dashboard");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await page.getByRole("button", { name: "Get Started" }).click();
    await page.getByRole("button", { name: "Personalized setup" }).click();

    // The categories step itself is static; the failure surfaces after
    // Continue fires the first (stubbed-to-fail) suggestions request.
    await page.getByRole("button", { name: "Health", exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByText("AI setup is unavailable right now"),
    ).toBeVisible();
    // Two buttons share this name: the wizard header's escape hatch and the
    // error banner's CTA. Both start the manual tour; click the banner's
    // (last in DOM order) to exercise the fallback path.
    await page
      .getByRole("button", { name: "Take the hands-on tour" })
      .last()
      .click();

    // The manual dashboard spotlight starts.
    await expect(
      page.getByRole("heading", { name: "Your Profile" }),
    ).toBeVisible();
  });
});
