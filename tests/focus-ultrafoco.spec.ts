import { test, expect } from "../fixtures/auth";
import {
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  fetchUserSnapshot,
} from "../support/apiClient";

/**
 * Ultrafoco (F2): one item at a time, and the clock never gets the last word.
 *
 * The product decision this locks in, decided 2026-08-27: the schedule SUGGESTS which item to
 * open and nothing more. The person may switch items, jump ahead, and do an afternoon habit at
 * nine in the morning, with nothing blocking it and nothing warning about it. Anybody later
 * "fixing" the screen by gating a check on its window, or by adding an are-you-sure, breaks
 * this spec rather than a user's morning.
 *
 * Why the assertions never mention an hour. Playwright cannot move the wall clock, so a spec
 * that says "at 09:00 it lands on the noon item" only passes when CI happens to run at nine.
 * The invariant used instead needs no clock at all: at most ONE item's window can contain the
 * current minute, so whichever item the resolver did not pick is, by definition, off-schedule
 * right now. Landing and then stepping away therefore always lands on an off-window item,
 * whatever the hour. Which item the resolver picks at each hour is covered exhaustively by the
 * unit tests on `resolveFocusStart`.
 */

// Pinned so the account's day boundary and the browser's agree. The assertions do not depend
// on the hour, but a mismatched day would make the checks land on a different date than the
// one the screen reads.
test.use({ timezoneId: "Europe/Lisbon" });

/** Three habits at hours far apart, so at most one can ever be the current one. */
async function seedSpreadRoutine(
  ctx: Parameters<typeof createCategory>[0],
  accessToken: string,
): Promise<void> {
  const { id: categoryId } = await createCategory(ctx, accessToken, {
    name: "Health",
    icon: "icon:fa-heart",
    description: "Seeded for E2E",
    experience: "BEGINNER",
  });

  const spread = [
    { name: "Dawn walk", start: "03:00:00", end: "03:10:00" },
    { name: "Midday reading", start: "12:00:00", end: "12:10:00" },
    { name: "Night stretch", start: "22:00:00", end: "22:10:00" },
  ];

  const sections = [];
  for (const entry of spread) {
    const { id: habitId } = await createHabit(ctx, accessToken, {
      name: entry.name,
      description: entry.name,
      motivationalPhrase: "Keep going",
      iconId: "icon:fa-tint",
      importance: 3,
      dificulty: 1,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    sections.push({
      name: entry.name,
      iconId: "icon:fa-mug-hot",
      startTime: entry.start,
      endTime: entry.end,
      habitGroup: [{ habitId, startTime: entry.start, endTime: entry.end }],
      taskGroup: [],
      favorite: false,
    });
  }

  const { id: routineId } = await createRoutine(ctx, accessToken, {
    name: "Spread day",
    iconId: "icon:fa-sun",
    routineSections: sections,
  });

  await createSchedule(ctx, accessToken, { days: [currentWeekDay()], routineId });
}

test.describe("Ultrafoco", () => {
  test("checks an item that is off its window, with nothing blocking and nothing warning", async ({
    authedPage,
    api,
    testUser,
  }) => {
    await seedSpreadRoutine(api.ctx, api.accessToken);

    const before = await fetchUserSnapshot(api.ctx, {
      email: testUser.email,
      password: testUser.password,
    });
    expect(before.xp).toBe(0);

    await authedPage.goto("/focus");
    await expect(authedPage.getByTestId("focus-screen")).toBeVisible();

    await test.step("switch the same screen to one item at a time", async () => {
      await authedPage.getByTestId("focus-mode-toggle").click();
      await expect(authedPage.getByTestId("focus-ultra")).toBeVisible();
      // Three items seeded, and the counter proves the flattening found all of them across
      // the three sections.
      await expect(authedPage.getByTestId("focus-ultra-picker-toggle")).toContainText("3");
    });

    const landedOn = await authedPage.getByTestId("focus-ultra").locator("h2").innerText();

    await test.step("step to an item the clock did not choose", async () => {
      // At most one window can contain this minute, so anything other than the item the
      // resolver landed on is off-schedule right now, at every hour of the day.
      const forward = authedPage.getByTestId("focus-ultra-next");
      if (await forward.isEnabled()) {
        await forward.click();
      } else {
        await authedPage.getByTestId("focus-ultra-prev").click();
      }
      await expect(authedPage.getByTestId("focus-ultra").locator("h2")).not.toHaveText(landedOn);
    });

    await test.step("the check is offered, not withheld", async () => {
      // The regression this exists for: a well-meaning "you can only do this in its window"
      // guard. There is no such rule, on the client or on the server.
      await expect(authedPage.getByTestId("focus-ultra-check")).toBeEnabled();
      await expect(authedPage.getByRole("alert")).toHaveCount(0);
    });

    await test.step("and it lands on the backend", async () => {
      await Promise.all([
        authedPage.waitForResponse(
          (response) => response.url().endsWith("/routine/check") && response.ok(),
        ),
        authedPage.getByTestId("focus-ultra-check").click(),
      ]);

      const after = await fetchUserSnapshot(api.ctx, {
        email: testUser.email,
        password: testUser.password,
      });
      expect(after.xp).toBeGreaterThan(before.xp);
    });

    await test.step("and no confirmation was ever asked for", async () => {
      await expect(authedPage.locator('[role="dialog"]')).toHaveCount(0);
    });
  });

  test("the picker reaches any item of the day in one click", async ({ authedPage, api }) => {
    // Without this, reaching this morning late at night means pressing back as many times as
    // the day is long, which is what would make the freedom rule true on paper only.
    await seedSpreadRoutine(api.ctx, api.accessToken);

    await authedPage.goto("/focus");
    await authedPage.getByTestId("focus-mode-toggle").click();
    await expect(authedPage.getByTestId("focus-ultra")).toBeVisible();

    await authedPage.getByTestId("focus-ultra-picker-toggle").click();
    const picker = authedPage.getByTestId("focus-ultra-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button")).toHaveCount(3);

    await picker.getByRole("button").filter({ hasText: "Dawn walk" }).click();

    await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Dawn walk");
    await expect(picker).toHaveCount(0);
  });

  test("a LIST routine reaches ultrafoco with no times at all", async ({ authedPage, api }) => {
    // The shape the whole screen was designed around: a list has no schedule, so the clock has
    // nothing to say and the screen is permanently "pick the next thing". Built the other way
    // round, this is where an `if (!startTime)` branch would have failed.
    const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
      name: "Health",
      icon: "icon:fa-heart",
      description: "Seeded for E2E",
      experience: "BEGINNER",
    });
    const { id: habitId } = await createHabit(api.ctx, api.accessToken, {
      name: "Untimed habit",
      description: "No schedule at all",
      motivationalPhrase: "Whenever you like",
      iconId: "icon:fa-tint",
      importance: 3,
      dificulty: 1,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    const { id: routineId } = await createRoutine(api.ctx, api.accessToken, {
      name: "My list",
      iconId: "lucide:list",
      // A list carries `items` and no sections; order is position in the array.
      type: "LIST",
      items: [{ habitId }],
    });
    await createSchedule(api.ctx, api.accessToken, {
      days: [currentWeekDay()],
      routineId,
    });

    await authedPage.goto("/focus");
    await authedPage.getByTestId("focus-mode-toggle").click();

    await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Untimed habit");
    // No window, and nothing inventing one.
    await expect(authedPage.getByTestId("focus-ultra-window")).not.toContainText(":");

    await Promise.all([
      authedPage.waitForResponse(
        (response) => response.url().endsWith("/routine/check") && response.ok(),
      ),
      authedPage.getByTestId("focus-ultra-check").click(),
    ]);

    // Checking the last open item keeps you ON it, with the action turned into an undo, rather
    // than swapping the screen out from under you for a "day complete" panel. Deliberate: the
    // person sees their check land and can take it back, and the celebratory moment already
    // lives on the routine card (RoutineCompleteSummary). The done panel is for ARRIVING at a
    // finished day, which the next test covers.
    await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Untimed habit");
    await expect(authedPage.getByTestId("focus-ultra-check")).toBeEnabled();
    await expect(authedPage.getByTestId("focus-ultra-done")).toHaveCount(0);
  });

  test("arriving at an already finished day says so, with no tally of what was skipped", async ({
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
      name: "Only habit",
      description: "The single item of the day",
      motivationalPhrase: "Go",
      iconId: "icon:fa-tint",
      importance: 3,
      dificulty: 1,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    const { id: routineId } = await createRoutine(api.ctx, api.accessToken, {
      name: "One thing",
      iconId: "lucide:list",
      type: "LIST",
      items: [{ habitId }],
    });
    await createSchedule(api.ctx, api.accessToken, {
      days: [currentWeekDay()],
      routineId,
    });

    // Check it, leave, and come back: the resolver runs fresh on arrival and finds nothing open.
    await authedPage.goto("/focus");
    await authedPage.getByTestId("focus-mode-toggle").click();
    await Promise.all([
      authedPage.waitForResponse(
        (response) => response.url().endsWith("/routine/check") && response.ok(),
      ),
      authedPage.getByTestId("focus-ultra-check").click(),
    ]);
    await authedPage.getByTestId("focus-exit").click();

    await authedPage.goto("/focus");
    await authedPage.getByTestId("focus-mode-toggle").click();

    await expect(authedPage.getByTestId("focus-ultra-done")).toBeVisible();
  });
});
