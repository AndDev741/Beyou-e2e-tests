import { test, expect } from "../fixtures/auth";

/**
 * Configuration page smoke — the page that renders EVERY widget preview.
 *
 * Why this matters: WidgetsConfiguration renders a live preview of every
 * registered widget (current + available lists). A single widget that throws
 * during mount (e.g. chart.js "radar is not a registered controller" when a
 * chart type ships without its controller) takes down the whole page via the
 * error boundary — users lose access to ALL settings. No other spec opened
 * /configuration, which is exactly how that crash slipped through.
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
    for (const section of ["Profile", "Appearance", "Preferences", "Dashboard"]) {
      await expect(
        authedPage.getByRole("heading", { level: 2, name: section, exact: true }),
      ).toBeVisible();
    }

    // The widget drag-and-drop board mounted (it previews every widget,
    // including chart-based ones — this is where a bad chart registration
    // crashes the tree).
    await expect(
      authedPage.getByRole("heading", { name: "Life Balance" }),
    ).toBeVisible();

    expect(
      pageErrors,
      `Uncaught page errors: ${pageErrors.map((e) => e.message).join(" | ")}`,
    ).toEqual([]);
  });
});
