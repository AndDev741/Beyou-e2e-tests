import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import { makeUser } from "../support/testData";
import {
  acknowledgeCalendarTask,
  addDaysIso,
  createCalendarTask,
  createGoal,
  deleteCalendarTask,
  editCalendarTask,
  editUser,
  fetchCalendarOverview,
  fetchCalendarOverviewResponse,
  fetchNotificationPreferences,
  fetchUpcomingCalendarTasks,
  fetchUserSnapshot,
  loginUser,
  registerUser,
  saveMoodEntry,
  toggleCalendarTask,
  updateNotificationPreferences,
} from "../support/apiClient";

/**
 * The Calendar: one-off dated tasks with a reminder, and each day's routine, goal deadlines and
 * mood, joined by the server.
 *
 * Why this file exists: the reminder instant is computed in exactly one place (the server) and
 * read by three consumers (the browser notifier, the email job, the screens). If a client or a
 * zone shift moved it, a reminder would fire at the wrong hour and nothing on screen would say
 * so. The same goes for the XP a completion pays and the ownership of a task, which are rules
 * between a controller and two apps. Those are cross-repo contracts, which is what this suite
 * is for.
 */

/** Today as the server sees it for this account: read back, never computed on the runner. */
async function serverToday(ctx: APIRequestContext, accessToken: string): Promise<string> {
  const probe = new Date().toISOString().slice(0, 10);
  const overview = await fetchCalendarOverview(ctx, accessToken, { from: probe, to: probe });
  return overview.today;
}

/** A fresh account registered in a given zone, so instant arithmetic is pinned. */
async function accountIn(ctx: APIRequestContext, timezone: string) {
  const user = makeUser();
  await registerUser(ctx, { ...user, timezone });
  const { accessToken } = await loginUser(ctx, { email: user.email, password: user.password });
  return { user, accessToken };
}

const instant = (iso: string) => new Date(iso).toISOString();

test.describe("calendar API", () => {
  /**
   * AE1 from the plan. Sao Paulo has had no daylight saving since 2019, so UTC-3 holds all year
   * and a runner in any zone computes the same expectation.
   */
  test("the reminder instant is the date at its time, or the default time, minus the advance, in the user's zone", async ({
    api,
  }) => {
    const { accessToken } = await accountIn(api.ctx, "America/Sao_Paulo");

    const untimed = await createCalendarTask(api.ctx, accessToken, {
      title: "Sign the lease",
      date: "2026-12-14",
      advanceMinutes: 1440,
    });
    expect(instant(untimed.notifyAt)).toBe("2026-12-13T12:00:00.000Z");

    const timed = await createCalendarTask(api.ctx, accessToken, {
      title: "Dentist",
      date: "2026-12-14",
      time: "10:00",
      advanceMinutes: 60,
    });
    expect(instant(timed.notifyAt)).toBe("2026-12-14T12:00:00.000Z");

    // The instant is derived on every read, so a new default time moves untimed tasks at once.
    await updateNotificationPreferences(api.ctx, accessToken, { reminderDefaultTime: "07:30" });
    const overview = await fetchCalendarOverview(api.ctx, accessToken, {
      from: "2026-12-14",
      to: "2026-12-14",
    });
    const reread = overview.days[0].tasks.find((task) => task.id === untimed.id)!;
    expect(instant(reread.notifyAt)).toBe("2026-12-13T10:30:00.000Z");
  });

  test("completing pays task XP and un-completing takes exactly that back", async ({ api, testUser }) => {
    const credentials = { email: testUser.email, password: testUser.password };
    const today = await serverToday(api.ctx, api.accessToken);
    const task = await createCalendarTask(api.ctx, api.accessToken, { title: "Book the doctor", date: today });

    const before = await fetchUserSnapshot(api.ctx, credentials);

    const done = await toggleCalendarTask(api.ctx, api.accessToken, task.id);
    expect(done.ok()).toBe(true);
    const body = await done.json();
    expect(body.task.completed).toBe(true);
    expect(body.task.xpAwarded).toBe(10);
    expect((await fetchUserSnapshot(api.ctx, credentials)).xp).toBe(before.xp + 10);

    const undone = await toggleCalendarTask(api.ctx, api.accessToken, task.id);
    expect((await undone.json()).task.completed).toBe(false);
    expect((await fetchUserSnapshot(api.ctx, credentials)).xp).toBe(before.xp);
  });

  test("a missed task stays on its own day instead of moving to today", async ({ api }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    const yesterday = addDaysIso(today, -1);
    const missed = await createCalendarTask(api.ctx, api.accessToken, { title: "Renew the ID", date: yesterday });

    const overview = await fetchCalendarOverview(api.ctx, api.accessToken, { from: yesterday, to: today });
    const [dayBefore, dayOf] = overview.days;

    expect(dayBefore.date).toBe(yesterday);
    expect(dayBefore.tasks.map((task) => [task.id, task.completed])).toEqual([[missed.id, false]]);
    expect(dayOf.tasks).toEqual([]);
  });

  test("a day lists the goals ending on it and the mood with its diary flag", async ({ api }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    const deadline = addDaysIso(today, 5);
    const { id: goalId } = await createGoal(api.ctx, api.accessToken, {
      name: "Read 12 books",
      iconId: "icon:fa-book",
      targetValue: 12,
      unit: "books",
      currentValue: 0,
      categoriesId: [],
      startDate: today,
      endDate: deadline,
      status: "NOT_STARTED",
      term: "SHORT_TERM",
    });
    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 4, note: "A calm one." });

    const overview = await fetchCalendarOverview(api.ctx, api.accessToken, { from: today, to: deadline });
    const byDate = Object.fromEntries(overview.days.map((day) => [day.date, day]));

    expect(overview.days).toHaveLength(6);
    expect(byDate[deadline].goals.map((goal) => goal.goalId)).toEqual([goalId]);
    expect(byDate[today].goals).toEqual([]);
    expect(byDate[today].mood).toEqual({ level: 4, hasNote: true });
    expect(byDate[deadline].mood).toBeNull();
  });

  test("a range longer than the cap is refused with its own error key", async ({ api }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    const response = await fetchCalendarOverviewResponse(api.ctx, api.accessToken, {
      from: today,
      to: addDaysIso(today, 80),
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).errorKey).toBe("CALENDAR_RANGE_INVALID");
  });

  /** Every route answers the same 404 for someone else's task, so none of them confirms it exists. */
  test("another account can neither see nor touch the task", async ({ api }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    const task = await createCalendarTask(api.ctx, api.accessToken, { title: "Private errand", date: today });

    const stranger = makeUser();
    await registerUser(api.ctx, stranger);
    const { accessToken: strangerToken } = await loginUser(api.ctx, {
      email: stranger.email,
      password: stranger.password,
    });

    const attempts = [
      await editCalendarTask(api.ctx, strangerToken, task.id, { title: "Hijacked", date: today }),
      await toggleCalendarTask(api.ctx, strangerToken, task.id),
      await acknowledgeCalendarTask(api.ctx, strangerToken, task.id),
      await deleteCalendarTask(api.ctx, strangerToken, task.id),
    ];
    for (const attempt of attempts) {
      expect(attempt.status()).toBe(404);
      expect((await attempt.json()).errorKey).toBe("CALENDAR_TASK_NOT_FOUND");
    }

    const theirs = await fetchCalendarOverview(api.ctx, strangerToken, { from: today, to: today });
    expect(theirs.days[0].tasks).toEqual([]);

    const mine = await fetchCalendarOverview(api.ctx, api.accessToken, { from: today, to: today });
    expect(mine.days[0].tasks.map((t) => [t.title, t.completed])).toEqual([["Private errand", false]]);
  });

  /**
   * The reaction rule behind the email fallback: a clicked reminder is done with, and moving the
   * task arms it again. Upcoming is the window the browser notifier reads.
   */
  test("acknowledging takes a reminder out of upcoming, and moving the task re-arms it", async ({ api }) => {
    const { accessToken } = await accountIn(api.ctx, "UTC");
    const at = (hoursAhead: number) => {
      const when = new Date(Date.now() + hoursAhead * 3_600_000);
      return { date: when.toISOString().slice(0, 10), time: when.toISOString().slice(11, 16) };
    };

    const task = await createCalendarTask(api.ctx, accessToken, { title: "Call the bank", ...at(2) });
    expect((await fetchUpcomingCalendarTasks(api.ctx, accessToken)).map((t) => t.id)).toContain(task.id);

    expect((await acknowledgeCalendarTask(api.ctx, accessToken, task.id)).status()).toBe(204);
    expect((await fetchUpcomingCalendarTasks(api.ctx, accessToken)).map((t) => t.id)).not.toContain(task.id);

    const moved = await editCalendarTask(api.ctx, accessToken, task.id, { title: "Call the bank", ...at(3) });
    expect(moved.ok()).toBe(true);
    expect((await fetchUpcomingCalendarTasks(api.ctx, accessToken)).map((t) => t.id)).toContain(task.id);
  });

  test("reminder preferences save one field without touching the others", async ({ api }) => {
    const before = await fetchNotificationPreferences(api.ctx, api.accessToken);
    expect(before).toMatchObject({ reminderEmail: true, reminderWeb: true, reminderDefaultTime: "09:00" });

    const after = await updateNotificationPreferences(api.ctx, api.accessToken, { reminderEmail: false });

    expect(after).toEqual({ ...before, reminderEmail: false });
    expect(await fetchNotificationPreferences(api.ctx, api.accessToken)).toEqual(after);
  });
});

test.describe("calendar in the browser", () => {
  test.use({ timezoneId: "UTC", viewport: { width: 1280, height: 900 } });

  test("a task created on a day shows in that day's panel and at its hour in the week view", async ({
    authedPage,
    api,
  }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));

    const target = addDaysIso(await serverToday(api.ctx, api.accessToken), 3);
    await authedPage.goto(`/calendar?date=${target}`);

    await authedPage.getByTestId("calendar-add-task-on-day").click();
    await authedPage.getByTestId("calendar-task-title").fill("Pick up the passport");
    await authedPage.getByTestId("calendar-task-time").fill("10:00");
    await authedPage.getByTestId("calendar-task-save").click();

    await expect(authedPage.getByTestId("calendar-day-panel")).toContainText("Pick up the passport");

    // The component sent the day it was opened on, and the time typed: read back off the server.
    await expect
      .poll(async () => {
        const overview = await fetchCalendarOverview(api.ctx, api.accessToken, { from: target, to: target });
        return overview.days[0].tasks.map((task) => [task.title, task.time]);
      })
      .toEqual([["Pick up the passport", "10:00"]]);

    await authedPage.getByTestId("calendar-view-week").click();
    await expect(authedPage.getByTestId(`calendar-week-cell-${target}-10`)).toContainText(
      "Pick up the passport",
    );

    expect(errors).toEqual([]);
  });

  test("completing a task from the day panel pays its XP", async ({ authedPage, api, testUser }) => {
    const credentials = { email: testUser.email, password: testUser.password };
    const today = await serverToday(api.ctx, api.accessToken);
    const task = await createCalendarTask(api.ctx, api.accessToken, { title: "Pay the rent", date: today });
    const before = await fetchUserSnapshot(api.ctx, credentials);

    await authedPage.goto(`/calendar?date=${today}`);
    await authedPage.getByTestId(`calendar-task-toggle-${task.id}`).click();

    await expect.poll(async () => (await fetchUserSnapshot(api.ctx, credentials)).xp).toBe(before.xp + 10);
  });

  test("the dashboard widget lists today's tasks once the user turns it on", async ({ authedPage, api }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    await createCalendarTask(api.ctx, api.accessToken, { title: "Water the plants", date: today });
    await editUser(api.ctx, api.accessToken, { widgetsId: ["calendarToday"] });

    await authedPage.goto("/dashboard");

    await expect(visible(authedPage, "calendar-today-widget")).toContainText("Water the plants");
  });

  test("turning reminder emails off in the settings reaches the server", async ({ authedPage, api }) => {
    await authedPage.goto("/configuration");
    await authedPage.getByTestId("reminder-email-toggle").click();

    await expect
      .poll(async () => (await fetchNotificationPreferences(api.ctx, api.accessToken)).reminderEmail)
      .toBe(false);
  });
});

/**
 * The dashboard renders every widget twice (phone carousel and desktop rail) and CSS hides one,
 * so take the visible copy (see mood.spec.ts).
 */
function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}
