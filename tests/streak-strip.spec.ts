import { test, expect } from "../fixtures/auth";
import {
  checkHabitToday,
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  editUser,
  fetchHabits,
  todayIso,
} from "../support/apiClient";

/**
 * The streak strip on screen: the dashboard widgets and the habit card.
 *
 * The numbers are covered by `check-history.spec.ts` against the API. What can
 * only break in the browser is the drawing: a strip that renders the wrong number
 * of squares, a card that shows "undefined dias" because the response lost a
 * field, or — the one that actually shipped broken — a strip that fetches once on
 * mount and keeps drawing today as still-open after the user checks something.
 */

async function seedCheckableHabit(
  api: { ctx: import("@playwright/test").APIRequestContext; accessToken: string },
) {
  const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
    name: "Health",
    icon: "icon:fa-heart",
    description: "Seeded for E2E",
    experience: "BEGINNER",
  });
  const { id: habitId } = await createHabit(api.ctx, api.accessToken, {
    name: "Drink water",
    description: "Stay hydrated",
    motivationalPhrase: "Your body will thank you",
    iconId: "icon:fa-tint",
    importance: 3,
    dificulty: 1,
    categoriesId: [categoryId],
    experience: "BEGINNER",
  });
  const { id: routineId } = await createRoutine(api.ctx, api.accessToken, {
    name: "Morning routine",
    iconId: "icon:fa-sun",
    routineSections: [
      {
        name: "Wake up",
        iconId: "icon:fa-mug-hot",
        startTime: "07:00:00",
        endTime: "08:00:00",
        habitGroup: [{ habitId, startTime: "07:00:00", endTime: "07:10:00" }],
        taskGroup: [],
        favorite: false,
      },
    ],
  });
  await createSchedule(api.ctx, api.accessToken, {
    days: [currentWeekDay()],
    routineId,
  });
  return { habitId, routineId };
}

test.describe("Streak strip", () => {
  test("the widget draws 28 days, and today's square turns done on a check with no reload", async ({
    authedPage,
    api,
  }) => {
    const { habitId } = await seedCheckableHabit(api);
    await editUser(api.ctx, api.accessToken, {
      widgetsId: ["constance", "constanceHeatmap"],
    });

    await authedPage.goto("/dashboard");

    // Both rails are in the DOM (phone carousel + desktop column) and CSS picks
    // one, so the assertion has to name the visible strip.
    const strip = authedPage.locator('[data-testid="streak-strip"]:visible');
    await expect(strip).toBeVisible();
    await expect(strip.locator("i")).toHaveCount(28);

    const todayCell = strip.locator(`[data-day="${todayIso()}"]`);
    // Nothing checked yet, and a day that has not closed is not a failure: it
    // reads UNKNOWN, and the UI draws it as open rather than as an empty day.
    await expect(todayCell).toHaveAttribute("data-outcome", "UNKNOWN");

    const habitRow = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Drink water" });
    const checkToggle = habitRow.locator('label:has(input[type="checkbox"])').first();

    await Promise.all([
      authedPage.waitForResponse(
        (response) => response.url().endsWith("/routine/check") && response.ok(),
      ),
      // The label, not the input: the input is `sr-only` with the ring drawn over
      // it, so a click on the input fails the hit-target test.
      checkToggle.click(),
    ]);

    // The whole point: no reload. The strip re-reads its history when a check is
    // applied, because a number that moves next to a picture that does not is
    // worse than either alone.
    await expect(todayCell).toHaveAttribute("data-outcome", "DONE");
    expect(habitId).toBeTruthy();
  });

  test("the heatmap draws sixteen weeks of squares", async ({ authedPage, api }) => {
    await seedCheckableHabit(api);
    await editUser(api.ctx, api.accessToken, { widgetsId: ["constanceHeatmap"] });

    await authedPage.goto("/dashboard");

    const heatmap = authedPage.locator('[data-testid="constance-heatmap"]:visible');
    await expect(heatmap).toBeVisible();
    await expect(heatmap).toHaveAttribute("data-loading", "false");

    // 16 weeks ending on today's week: a full grid minus the days after today,
    // plus the spacers that push the first day onto its own weekday row. The
    // total is therefore exactly 16 × 7 minus the remainder of the current week.
    const cells = await heatmap.locator("i").count();
    expect(cells).toBeGreaterThan(15 * 7);
    expect(cells).toBeLessThanOrEqual(16 * 7);
  });

  test("the habit card shows the streak, the record, the total and the fortnight", async ({
    authedPage,
    api,
  }) => {
    const { habitId } = await seedCheckableHabit(api);
    await checkHabitToday(api.ctx, api.accessToken, habitId);

    // Sanity: the numbers the card is about to show came from the backend.
    const [habit] = await fetchHabits(api.ctx, api.accessToken);
    expect(habit.currentStreak).toBe(1);
    expect(habit.totalCheckIns).toBe(1);

    await authedPage.goto("/habits");
    // `exact` matters: without it the accessible name also matches the sidebar's
    // "Collapse or expand the menu", and the click folds the menu instead.
    await authedPage.getByRole("button", { name: "Expand", exact: true }).first().click();

    // "1 day", singular — the plural rules matter here because pt-BR reads 0 and 1
    // alike and en does not.
    await expect(authedPage.getByText("1 day", { exact: false }).first()).toBeVisible();
    await expect(authedPage.getByText("Check-ins")).toBeVisible();
    await expect(authedPage.getByText("Last 2 weeks")).toBeVisible();

    const strip = authedPage.locator(`[data-testid="check-strip-${habitId}"]`);
    await expect(strip).toBeVisible();
    await expect(strip.locator("i")).toHaveCount(14);
    await expect(strip.locator(`[data-day="${todayIso()}"]`)).toHaveAttribute(
      "data-outcome",
      "DONE",
    );

    // Nothing anywhere reads "undefined": that is what a missing scalar looks like
    // on screen, and it is the defect this pairing of card and boundary exists to
    // prevent.
    await expect(authedPage.getByText("undefined")).toHaveCount(0);
  });

  test("a habit nobody ever checked says so instead of showing a zero streak proudly", async ({
    authedPage,
    api,
  }) => {
    await seedCheckableHabit(api);

    await authedPage.goto("/habits");
    // `exact` matters: without it the accessible name also matches the sidebar's
    // "Collapse or expand the menu", and the click folds the menu instead.
    await authedPage.getByRole("button", { name: "Expand", exact: true }).first().click();

    await expect(authedPage.getByText("no check-ins yet")).toBeVisible();
    // No streak means no flame chip: a zero beside a dim flame reads as failure
    // rather than as a neutral starting point.
    await expect(authedPage.locator('[title="Streak"]')).toHaveCount(0);
  });
});
