import { test, expect } from "../fixtures/auth";
import {
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
} from "../support/apiClient";

/**
 * A long section name used to push the day's routine past the card's edge.
 *
 * The section header row was laid out at its content width (its parent is a
 * column with `items-start`), so the name never had to shorten: the row simply
 * grew, and the collapse chevron ended up outside the card, half-cut against the
 * right edge of a phone screen. Reported from production with a routine whose
 * first section is "Manhã Pessoal - transição…".
 *
 * The assertion is the chevron's own box: it is the thing that fell off, and it
 * sits at the far end of the row, so it is only in the viewport if everything
 * before it shortened as it should.
 */
const PHONE = { width: 390, height: 844 };
const LONG_SECTION = "Manhã Pessoal - transição para o trabalho focado do dia";

test.describe("Dashboard routine layout", () => {
  test("a long section name does not push the collapse control off screen", async ({
    authedPage,
    api,
  }) => {
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
          name: LONG_SECTION,
          iconId: "icon:fa-mug-hot",
          startTime: "07:00:00",
          endTime: "08:00:00",
          habitGroup: [
            { habitId, startTime: "07:00:00", endTime: "07:10:00" },
          ],
          taskGroup: [],
          favorite: false,
        },
      ],
    });

    await createSchedule(api.ctx, api.accessToken, {
      days: [currentWeekDay()],
      routineId,
    });

    await authedPage.setViewportSize(PHONE);
    await authedPage.goto("/dashboard");

    const collapse = authedPage
      .getByRole("button", { name: /^(Collapse|Expand)$/ })
      .first();
    await expect(collapse).toBeVisible();

    const box = await collapse.boundingBox();
    expect(box).not.toBeNull();
    // The whole control, not just its left edge: half a chevron is the bug.
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);

    // And nothing else the section drags along leaves the page either.
    const overflowPx = await authedPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowPx).toBeLessThanOrEqual(1);
  });
});
