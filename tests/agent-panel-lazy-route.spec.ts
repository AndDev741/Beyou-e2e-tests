import { test, expect } from "../fixtures/auth";

/**
 * A page loading for the first time may blank the page area, and nothing else.
 *
 * Every page is a lazy chunk. The Suspense boundary that catches its first load used to be the
 * only one, above the shell, so the first visit to any page hid the sidebar, the bottom bar,
 * the assistant bubble and its open panel while the chunk came down. Two things followed. The
 * visible one: a full-screen spinner on every first navigation. The reported one: the agent's
 * internal links close the panel and navigate in the same handler, and a panel whose exit
 * began in the tick the shell was hidden lost its animation with the layout effects React tears
 * down on a hide. It came back at full opacity while the widget already believed it closed, so
 * the bubble drew over the chat and Escape did nothing.
 *
 * The rule locked in here is the placement, because that is what both symptoms hang off and it
 * is the one thing a browser can observe deterministically: hold the chunk, and look at what is
 * on screen while it is pending. The ghost itself depends on animation-frame timing that a
 * headless run does not reproduce on cue, so it is not what the assertion waits for.
 *
 * Against the production build in CI the chunk comes from nginx; against Vite it is a module
 * request. Both go through the route below, and the assertion is the same.
 */
test.describe("Assistant panel and lazy pages", () => {
  test("a page loading for the first time waits inside the shell, with the panel open", async ({
    authedPage,
  }) => {
    await authedPage.goto("/dashboard");

    // Two buttons carry this name: the phone bar's centre button is `display: none` on a
    // desktop viewport, so the role query resolves to the floating bubble alone.
    const bubble = authedPage.getByRole("button", { name: "Open assistant" });
    const panel = authedPage.getByRole("dialog", { name: "AI Assistant" });
    const sidebarHabits = authedPage.getByRole("link", { name: "Habits" });

    await test.step("open the panel", async () => {
      await bubble.click();
      await expect(panel).toBeVisible();
      await expect(panel).toHaveCSS("opacity", "1");
    });

    await test.step("hold the next page's scripts", async () => {
      // Everything already on the page is loaded, so from here on the only scripts requested
      // are the ones the next page needs. Two seconds is longer than the checks below take.
      await authedPage.route(/\.(js|tsx|ts)(\?.*)?$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.continue();
      });
    });

    await test.step("navigate to a page this context has never loaded", async () => {
      await authedPage.getByRole("link", { name: "Categories" }).click();
    });

    await test.step("while the chunk is pending, only the page area waits", async () => {
      // Short timeouts on purpose: these have to hold DURING the wait, not once it is over. A
      // shell hidden by an outer boundary would only come back after the two seconds, and the
      // default timeout would have waited it out.
      await expect(panel).toBeVisible({ timeout: 500 });
      await expect(sidebarHabits).toBeVisible({ timeout: 500 });
      await expect(authedPage.getByTestId("page-fallback")).toBeVisible({ timeout: 1000 });
    });

    await test.step("and the page arrives under a panel that never moved", async () => {
      await expect(authedPage).toHaveURL(/\/categories$/);
      await expect(authedPage.getByTestId("page-fallback")).toHaveCount(0);
      await expect(panel).toBeVisible();
      await expect(bubble).toHaveCount(0);
    });
  });
});
