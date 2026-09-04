import { test, expect } from "../fixtures/auth";
import {
  completeGoal,
  createGoal,
  GoalPayload,
  increaseGoal,
} from "../support/apiClient";

/**
 * The goal viewer: one goal at a time, full screen, ordered by status by default.
 *
 * Why a browser test. The ordering itself is a pure function with unit tests in
 * `@beyou/state`; what only a browser can show is that the page wires it to the real
 * list, that `?goal=` lands on the right slide, that the arrows move through the same
 * deck, and that Escape hands the person back to the goals page. Each of those is a
 * seam between two pieces that are individually tested and could still disagree.
 *
 * The three goals are set up so the "by status" order is unambiguous: one in progress
 * (an increment started it), one never touched, one completed.
 */
test.describe("Goal viewer", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  function payload(name: string, days: number): GoalPayload {
    const today = new Date();
    const end = new Date(today);
    end.setDate(today.getDate() + days);
    return {
      name,
      iconId: "icon:fa-flag",
      targetValue: 5,
      unit: "sessions",
      currentValue: 0,
      categoriesId: [],
      startDate: iso(today),
      endDate: iso(end),
      status: "NOT_STARTED",
      term: "SHORT_TERM",
    };
  }

  test("orders by status, follows the arrows, opens on the linked goal, and leaves on Escape", async ({
    authedPage,
    api,
  }) => {
    const { id: fresh } = await createGoal(api.ctx, api.accessToken, payload("Learn to juggle", 20));
    const { id: active } = await createGoal(api.ctx, api.accessToken, payload("Swim twice a week", 10));
    const { id: done } = await createGoal(api.ctx, api.accessToken, payload("Read one book", 5));
    await increaseGoal(api.ctx, api.accessToken, active, 2);
    await increaseGoal(api.ctx, api.accessToken, done, 5);
    await completeGoal(api.ctx, api.accessToken, done);

    await authedPage.goto("/goals/view");
    const viewer = authedPage.getByTestId("goal-viewer");
    await expect(viewer).toBeVisible();
    const slide = authedPage.getByTestId("goal-viewer-slide");

    await test.step("in progress comes first, then not started, then completed", async () => {
      await expect(slide).toHaveAttribute("data-goal-id", active);
      await expect(viewer.getByText("Swim twice a week")).toBeVisible();

      await authedPage.getByTestId("goal-viewer-next").click();
      await expect(slide).toHaveAttribute("data-goal-id", fresh);

      await authedPage.getByTestId("goal-viewer-next").click();
      await expect(slide).toHaveAttribute("data-goal-id", done);
      await expect(viewer.getByText("Read one book")).toBeVisible();
    });

    await test.step("the previous arrow walks the same deck backwards", async () => {
      await authedPage.getByTestId("goal-viewer-prev").click();
      await expect(slide).toHaveAttribute("data-goal-id", fresh);
    });

    await test.step("a deep link opens on the linked goal", async () => {
      await authedPage.goto(`/goals/view?goal=${done}`);
      await expect(authedPage.getByTestId("goal-viewer-slide")).toHaveAttribute("data-goal-id", done);
    });

    await test.step("Escape leaves to the goals page", async () => {
      await authedPage.keyboard.press("Escape");
      await expect(authedPage).toHaveURL(/\/goals$/);
    });
  });

  test("the goals page offers the way in, and a card opens on its own goal", async ({ authedPage, api }) => {
    const { id } = await createGoal(api.ctx, api.accessToken, payload("Plant a garden", 15));

    await authedPage.goto("/goals");
    await authedPage.getByTestId("open-goal-viewer").click();
    await expect(authedPage).toHaveURL(/\/goals\/view$/);
    await expect(authedPage.getByTestId("goal-viewer-slide")).toHaveAttribute("data-goal-id", id);
  });
});
