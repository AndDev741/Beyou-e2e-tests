import { test, expect } from "../fixtures/auth";

/**
 * Configuration page smoke — every section mounts and nothing throws.
 *
 * Why this matters: a component that throws during mount takes the whole page
 * down via the error boundary, and the user loses access to ALL settings. No
 * other spec opens /configuration, which is exactly how a widget crash slipped
 * through once (chart.js "radar is not a registered controller").
 *
 * The redesign changed WHAT this page renders: the widget board used to mount a
 * live preview of every registered widget, and is now a compact list of names.
 * The live previews moved to the dashboard rail — the crash surface there is
 * covered by the dashboard specs. What stays here is the smoke: the four
 * sections and a clean console.
 */
test.describe("Configuration page", () => {
  test("renders all sections and every widget preview without crashing", async ({
    authedPage,
  }) => {
    const pageErrors: Error[] = [];
    authedPage.on("pageerror", (error) => pageErrors.push(error));

    await authedPage.goto("/configuration");

    // The grouped sections from the UX polish PR. ConfigSection headings are
    // <h2>; level: 2 disambiguates from inner component headings (e.g. the
    // ProfileConfiguration <h1> is also named "Profile").
    for (const section of [
      "Profile",
      "Dashboard widgets",
      "Appearance",
      "Preferences",
    ]) {
      await expect(
        authedPage.getByRole("heading", { level: 2, name: section, exact: true }),
      ).toBeVisible();
    }

    // The widget board mounted: it lists every widget by name, in dashboard
    // order, with the leftovers as "+ name" chips.
    await expect(
      authedPage.getByRole("heading", { name: "On the dashboard" }),
    ).toBeVisible();
    await expect(authedPage.getByText("Life Balance").first()).toBeVisible();

    expect(
      pageErrors,
      `Uncaught page errors: ${pageErrors.map((e) => e.message).join(" | ")}`,
    ).toEqual([]);
  });
});
