import { expect } from "@playwright/test";
import { test } from "../fixtures/auth";

/**
 * AI routine generation E2E.
 *
 * The backend e2e profile uses CannedRoutineDraftGenerator (no real AI call),
 * so the draft is deterministic: routine "AI Morning Routine" with habits
 * "Drink water" + "Stretch", task "Prepare breakfast", new category "Wellness".
 *
 * New flow: the AI materializes the new habits/tasks/categories and injects the
 * structure into the MANUAL routine form (real SectionItem rendering, with a
 * "New" badge). The user then edits traditionally and clicks Create to persist
 * the routine. If those canned names change, update both sides.
 */
test.describe("AI routine generation", () => {
  test("AI fills the manual form, items are badged New, then the user saves the routine", async ({
    authedPage: page,
  }) => {
    await test.step("open the daily routine form and launch the AI assistant", async () => {
      await page.goto("/routines");
      await page.locator('[data-tutorial-id="routine-add-button"]').click();
      await page.getByTestId("daily-routine-example").click();
      await page.getByTestId("create-with-ai").click();
    });

    await test.step("describe the routine", async () => {
      await page
        .getByTestId("ai-description")
        .fill(
          "I wake up at 6am and want a healthy morning with water, stretching and a good breakfast"
        );
      await page.getByTestId("ai-generate").click();
    });

    await test.step("the form is filled with the AI structure (real SectionItem rendering)", async () => {
      // wizard closes, the manual form now shows the generated section + items
      await expect(page.getByText("Morning")).toBeVisible();
      await expect(page.getByText("Drink water")).toBeVisible();
      await expect(page.getByText("Stretch")).toBeVisible();
      await expect(page.getByText("Prepare breakfast")).toBeVisible();
      // new items are badged (the i18n key renders as "New" in en)
      await expect(page.getByText("New").first()).toBeVisible();
    });

    await test.step("the new habits/tasks/category already exist app-wide", async () => {
      // materialize persisted them before injecting into the form
      await page.goto("/habits");
      await expect(page.getByText("Drink water")).toBeVisible();
      await expect(page.getByText("Stretch")).toBeVisible();

      await page.goto("/tasks");
      await expect(page.getByText("Prepare breakfast")).toBeVisible();

      await page.goto("/categories");
      await expect(page.getByText("Wellness")).toBeVisible();
    });

    await test.step("save the routine from the form and see it in the list", async () => {
      await page.goto("/routines");
      await page.locator('[data-tutorial-id="routine-add-button"]').click();
      await page.getByTestId("daily-routine-example").click();
      await page.getByTestId("create-with-ai").click();
      await page
        .getByTestId("ai-description")
        .fill("Simple morning routine with water and stretching");
      await page.getByTestId("ai-generate").click();
      await expect(page.getByText("Morning")).toBeVisible();

      // the form's Create button persists the routine
      await page.getByRole("button", { name: /^create$/i }).click();
      await expect(page.getByText("AI Morning Routine")).toBeVisible();
    });
  });
});
