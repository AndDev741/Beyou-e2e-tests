import { test, expect } from "../fixtures/auth";
import {
  checkHabitToday,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  createCategory,
  deleteHabit,
  deleteRoutine,
  editRoutine,
  fetchCheckHistory,
  fetchCheckHistoryResponse,
  fetchHabit,
  outcomeOn,
  todayIso,
} from "../support/apiClient";

/**
 * `GET /check-history` — the day-by-day record behind every streak strip.
 *
 * Why this file exists: the strip is the one part of the product that claims to
 * remember. A card can recover from a wrong number on the next fetch; a history
 * that quietly rewrites itself, or forgets a day, cannot be recovered from at all
 * — and nothing about it is visible in a screenshot. So the guarantees are asserted
 * against the API, where they can be stated exactly.
 *
 * The four that matter, from the backend's own notes:
 *   1. a check writes today, and the strip shows it;
 *   2. the check response carries the scalars, so a card need not ask again;
 *   3. editing a routine does not repaint days that are already closed;
 *   4. deleting a habit clears its history; deleting a routine does not.
 */

/** Everything a check needs: a category, a habit, a routine holding it, scheduled today. */
async function seedCheckableHabit(
  api: { ctx: import("@playwright/test").APIRequestContext; accessToken: string },
  names: { habit: string; routine: string },
) {
  const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
    name: "Health",
    icon: "icon:fa-heart",
    description: "Seeded for E2E",
    experience: "BEGINNER",
  });
  const { id: habitId } = await createHabit(api.ctx, api.accessToken, {
    name: names.habit,
    description: "Seeded for E2E",
    motivationalPhrase: "Keep going",
    iconId: "icon:fa-tint",
    importance: 3,
    dificulty: 1,
    categoriesId: [categoryId],
    experience: "BEGINNER",
  });
  const { id: routineId } = await createRoutine(api.ctx, api.accessToken, {
    name: names.routine,
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
  return { habitId, routineId, categoryId };
}

test.describe("Check history", () => {
  test("today is unknown until it is checked, then it is done", async ({ api }) => {
    const { habitId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    const today = todayIso();

    const before = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: habitId,
    });
    // A day's outcome is only decided when the day closes, so today reads UNKNOWN
    // all day — never MISSED, which would call a morning a failure.
    expect(outcomeOn(before, today)).toBe("UNKNOWN");

    await checkHabitToday(api.ctx, api.accessToken, habitId);

    const after = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: habitId,
    });
    expect(outcomeOn(after, today)).toBe("DONE");
  });

  test("the check response carries the scalars, so a card need not ask again", async ({
    api,
  }) => {
    const { habitId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });

    const refresh = await checkHabitToday(api.ctx, api.accessToken, habitId);

    // If anyone strips these from RefreshUiDTO, a card's streak goes stale at the
    // exact moment it changes — and the only visible symptom is a number that
    // needs a page reload to catch up.
    expect(refresh.refreshHabit).toBeDefined();
    expect(refresh.refreshHabit?.id).toBe(habitId);
    expect(refresh.refreshHabit?.currentStreak).toBe(1);
    expect(refresh.refreshHabit?.totalCheckIns).toBe(1);
    expect(refresh.refreshHabit?.bestStreak).toBe(1);

    // And the same numbers survive to the list endpoint.
    const habit = await fetchHabit(api.ctx, api.accessToken, "Drink water");
    expect(habit.currentStreak).toBe(1);
    expect(habit.totalCheckIns).toBe(1);
    expect(habit.firstCheckInDate).toBe(todayIso());
    expect(habit.streakDormant).toBe(false);
  });

  test("editing the routine does not repaint a day that is already closed", async ({
    api,
  }) => {
    const { habitId, routineId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    const today = todayIso();
    await checkHabitToday(api.ctx, api.accessToken, habitId);

    // Take the habit out of every routine. The stored day must not be recomputed
    // into NOT_IN_ROUTINE: the record is of what happened, not of what the current
    // schedule would imply. This is the guarantee that is easiest to break without
    // noticing and the most expensive to discover later.
    await editRoutine(api.ctx, api.accessToken, routineId, {
      name: "Morning routine",
      iconId: "icon:fa-sun",
      routineSections: [
        {
          name: "Wake up",
          iconId: "icon:fa-mug-hot",
          startTime: "07:00:00",
          endTime: "08:00:00",
          habitGroup: [],
          taskGroup: [],
          favorite: false,
        },
      ],
    });
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: habitId,
    });
    expect(outcomeOn(history, today)).toBe("DONE");

    // The scalars hold too — an edit is not a reason to lose a run.
    const habit = await fetchHabit(api.ctx, api.accessToken, "Drink water");
    expect(habit.currentStreak).toBe(1);
    expect(habit.totalCheckIns).toBe(1);
  });

  test("deleting the routine keeps the habit's history", async ({ api }) => {
    const { habitId, routineId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    const today = todayIso();
    await checkHabitToday(api.ctx, api.accessToken, habitId);

    await deleteRoutine(api.ctx, api.accessToken, routineId);

    // A day's record outlives the routine it was recorded through — which is why
    // entity_check_day carries no foreign key to the owner.
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: habitId,
    });
    expect(outcomeOn(history, today)).toBe("DONE");
  });

  test("deleting the habit clears its history", async ({ api }) => {
    const { habitId, routineId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    const today = todayIso();
    await checkHabitToday(api.ctx, api.accessToken, habitId);
    await deleteRoutine(api.ctx, api.accessToken, routineId);

    await deleteHabit(api.ctx, api.accessToken, habitId);

    // The asymmetry with the routine case above is deliberate, and it is the pair
    // of tests that documents it: deleting the thing itself takes its record with
    // it, deleting a container does not.
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: habitId,
    });
    expect(outcomeOn(history, today)).toBe("UNKNOWN");
    expect(history.days.every((entry) => entry.outcome === "UNKNOWN")).toBe(true);
  });

  test("the account's own history needs no id and defaults to 28 days", async ({
    api,
  }) => {
    const { habitId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    await checkHabitToday(api.ctx, api.accessToken, habitId);

    // The dashboard widget asks exactly like this — no ownerId, no range — because
    // the default window is resolved in the USER's timezone, not the browser's.
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "USER",
    });

    expect(history.days).toHaveLength(28);
    expect(history.to).toBe(history.days[27].day);
    expect(history.from).toBe(history.days[0].day);

    // Today stays UNKNOWN even though a habit was just checked: a check writes the
    // day of the HABIT it belongs to, and the ACCOUNT's day is closed by
    // DayCloseService hours after midnight. This is why the widget lights today's
    // square from `constanceIncreaseToday` on the profile instead of from a row —
    // if this assertion ever flips to DONE, that special case can go.
    expect(outcomeOn(history, todayIso())).toBe("UNKNOWN");
  });

  test("a check counts the day on the account even before the day is closed", async ({
    api,
    testUser,
  }) => {
    const { habitId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });

    const refresh = await checkHabitToday(api.ctx, api.accessToken, habitId);
    expect(refresh.refreshUser?.currentConstance).toBe(1);

    // The profile flag is the same fact as the row the scheduler will write, and it
    // is what lets the widget light today without inventing an outcome.
    const login = await api.ctx.post(
      `${process.env.API_URL ?? "http://localhost:8099/api/v1"}/auth/login`,
      { data: { email: testUser.email, password: testUser.password } },
    );
    expect(login.ok()).toBeTruthy();
    const body = (await login.json()) as {
      success: { constance: number; constanceIncreaseToday: boolean; constanceDormant: boolean };
    };
    expect(body.success.constance).toBe(1);
    expect(body.success.constanceIncreaseToday).toBe(true);
    expect(body.success.constanceDormant).toBe(false);
  });

  test("a range wider than the cap comes back clamped, and says so", async ({ api }) => {
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "USER",
      from: "2020-01-01",
      to: todayIso(),
    });

    // 366 days, both ends inclusive. A client that drew from its own request
    // parameters instead of these two would render a window it was never sent.
    expect(history.days).toHaveLength(366);
    expect(history.from).not.toBe("2020-01-01");
    expect(history.from).toBe(history.days[0].day);
  });

  test("every day of the range is present, with no gaps", async ({ api }) => {
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "USER",
    });

    // A missing day would leave every client guessing whether it was unknown or
    // failed; the strips map the array in order and would silently shift.
    const days = history.days.map((entry) => entry.day);
    expect(new Set(days).size).toBe(days.length);
    expect([...days].sort()).toEqual(days);
  });

  test("somebody else's owner id leaks nothing: 200, all unknown", async ({ api }) => {
    const response = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: "11111111-1111-1111-1111-111111111111",
    });

    // Deliberately not a 403: the read is filtered on the account in one
    // predicate, so there is nothing to deny — and denying would confirm the id
    // exists. It also keeps working for a habit that was deleted.
    expect(response.status()).toBe(200);
    const history = (await response.json()) as { days: Array<{ outcome: string }> };
    expect(history.days.every((entry) => entry.outcome === "UNKNOWN")).toBe(true);
  });

  test("a bad request is refused with an errorKey, not answered empty", async ({
    api,
  }) => {
    const missingType = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {});
    expect(missingType.status()).toBe(400);
    expect((await missingType.json()).errorKey).toBe("INVALID_REQUEST");

    const unknownType = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "GOAL",
    });
    expect(unknownType.status()).toBe(400);
    expect((await unknownType.json()).errorKey).toBe("INVALID_REQUEST");

    const noOwnerId = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "HABIT",
    });
    expect(noOwnerId.status()).toBe(400);
    expect((await noOwnerId.json()).errorKey).toBe("INVALID_REQUEST");

    // An inverted range names no days at all. Answering it empty would read as
    // "this owner has no history" — a wrong answer rather than a refused one.
    const inverted = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "USER",
      from: todayIso(),
      to: "2026-01-01",
    });
    expect(inverted.status()).toBe(400);
    expect((await inverted.json()).errorKey).toBe("INVALID_REQUEST");
  });

  test("an unchecked habit reports zeros rather than nothing", async ({ api }) => {
    await seedCheckableHabit(api, { habit: "Stretch", routine: "Evening routine" });

    const habit = await fetchHabit(api.ctx, api.accessToken, "Stretch");
    // The card draws this state — no flame, no record, "no check-ins yet" — so the
    // fields have to be present and zero, not absent.
    expect(habit.currentStreak).toBe(0);
    expect(habit.bestStreak).toBe(0);
    expect(habit.totalCheckIns).toBe(0);
    expect(habit.firstCheckInDate).toBeNull();
    expect(habit.streakDormant).toBe(false);
  });

  test("a malformed parameter is refused inside the errorKey envelope too", async ({ api }) => {
    // `ownerType` is hand-parsed to keep a bad value inside `{errorKey, message}`.
    // The other three bind through Spring, and a client that only understands the
    // envelope shows a generic failure for anything that escapes it.
    const badOwnerId = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "HABIT",
      ownerId: "not-a-uuid",
    });
    expect(badOwnerId.status()).toBe(400);
    expect((await badOwnerId.json()).errorKey).toBe("INVALID_REQUEST");

    const badFrom = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "USER",
      from: "13/08/2026",
    });
    expect(badFrom.status()).toBe(400);
    expect((await badFrom.json()).errorKey).toBe("INVALID_REQUEST");

    // An extreme date used to answer 500: the 28-day default was derived before the
    // range was bounded, and LocalDate underflowed.
    const absurdTo = await fetchCheckHistoryResponse(api.ctx, api.accessToken, {
      ownerType: "USER",
      to: "-999999999-01-01",
    });
    expect(absurdTo.status()).toBe(400);
    expect((await absurdTo.json()).errorKey).toBe("INVALID_REQUEST");
  });

  test("a routine's history answers correctly and carries nothing", async ({ api }) => {
    const { habitId, routineId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });
    await checkHabitToday(api.ctx, api.accessToken, habitId);

    // No writer records routine-level presence. The type is accepted so the route is
    // not shaped around today's writers, and this pins the contract: if somebody adds
    // that writer, this test is where the change gets noticed.
    const history = await fetchCheckHistory(api.ctx, api.accessToken, {
      ownerType: "ROUTINE",
      ownerId: routineId,
    });
    expect(history.days.every((entry) => entry.outcome === "UNKNOWN")).toBe(true);
  });

  test("the habits list reflects a check-in immediately, cache or no cache", async ({
    api,
  }) => {
    const { habitId } = await seedCheckableHabit(api, {
      habit: "Drink water",
      routine: "Morning routine",
    });

    // Warm whatever cache sits in front of the list, then check, then read again.
    // `GET /habit` is cached for thirty minutes per user; a check that does not evict
    // it serves a stale streak to every device for that long, and the only symptom is
    // a number that refuses to move.
    const before = await fetchHabit(api.ctx, api.accessToken, "Drink water");
    expect(before.currentStreak).toBe(0);

    await checkHabitToday(api.ctx, api.accessToken, habitId);

    const after = await fetchHabit(api.ctx, api.accessToken, "Drink water");
    expect(after.currentStreak).toBe(1);
    expect(after.totalCheckIns).toBe(1);
    expect(after.xp).toBeGreaterThan(before.xp);
  });

  /**
   * NOT COVERED HERE, on purpose: unskipping a closed past day.
   *
   * `PUT /routine/skip` with `skip:false` on a past date used to overwrite a stored
   * DONE with MISSED, because the guard read live check rows that the midnight
   * snapshot pass has already removed. Driving it needs a day whose live rows are
   * gone and whose history row remains — i.e. a real snapshot boundary. Through the
   * API alone a fresh database cannot get there: `POST /routine/check` with a past
   * `localDate` writes no row for that day (verified — the day stays UNKNOWN), and
   * back-dating is the snapshot endpoint's job.
   *
   * So this belongs in a backend integration test that owns the snapshot ordering,
   * not here. Left written down rather than silently skipped, because the guarantee
   * matters more than where it is asserted.
   */
});
