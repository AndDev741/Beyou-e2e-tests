import { test, expect } from "../fixtures/auth";
import {
  completeGoal,
  createCategory,
  createGoal,
  fetchUserSnapshot,
  increaseGoal,
} from "../support/apiClient";

/**
 * Locks in the goal endpoint asymmetry that CLAUDE.md calls out:
 *   - `PUT /goal/increase` returns a `GoalResponseDTO` and awards NO user XP.
 *   - `PUT /goal/complete` returns a `RefreshUiDTO` and awards XP.
 *
 * The intentional behavior (today): a user who reaches the target value by
 * incrementing never gets credit — they have to explicitly "Complete" the
 * goal. If someone "fixes" the increment path to also grant XP they have to
 * update this test on purpose, not by accident.
 *
 * This spec is API-only because the asymmetry lives at the endpoint contract;
 * dragging a UI through it adds flake without sharpening the assertion.
 */
test.describe("Goal XP", () => {
  test("/goal/increase awards no XP; /goal/complete does", async ({
    api,
    testUser,
  }) => {
    const today = new Date();
    const oneWeekOut = new Date(today);
    oneWeekOut.setDate(today.getDate() + 7);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
      name: "Career",
      icon: "icon:fa-briefcase",
      experience: "BEGINNER",
    });

    const { id: goalId } = await createGoal(api.ctx, api.accessToken, {
      name: "Read seven chapters",
      description: "One chapter a day for a week",
      iconId: "icon:fa-book",
      targetValue: 7,
      unit: "chapters",
      currentValue: 0,
      categoriesId: [categoryId],
      startDate: iso(today),
      endDate: iso(oneWeekOut),
      status: "IN_PROGRESS",
      term: "SHORT_TERM",
    });

    const credentials = {
      email: testUser.email,
      password: testUser.password,
    };
    const before = await fetchUserSnapshot(api.ctx, credentials);
    expect(before.xp).toBe(0);

    await test.step("incrementing currentValue does not move user XP", async () => {
      const goal = await increaseGoal(api.ctx, api.accessToken, goalId);
      expect(goal.currentValue).toBe(1);
      expect(goal.complete).toBe(false);

      const after = await fetchUserSnapshot(api.ctx, credentials);
      expect(after.xp).toBe(before.xp);
    });

    await test.step("completing the goal awards XP to the user", async () => {
      const refresh = await completeGoal(api.ctx, api.accessToken, goalId);
      expect(refresh.refreshUser.xp).toBeGreaterThan(before.xp);

      const after = await fetchUserSnapshot(api.ctx, credentials);
      expect(after.xp).toBeGreaterThan(before.xp);
      // The complete response and the freshly-fetched snapshot must agree —
      // mismatch here means the backend wrote a different XP value than it
      // reported in the response.
      expect(after.xp).toBeCloseTo(refresh.refreshUser.xp, 5);
    });
  });
});
