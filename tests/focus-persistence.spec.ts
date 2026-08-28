import { test, expect } from "../fixtures/auth";
import {
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  fetchFocusDay,
  fetchFocusMicroTasks,
  fetchListItemGroupIds,
  recordFocusCycle,
  todayIso,
} from "../support/apiClient";

/**
 * Focus Mode persistence (F6): what the screen writes, and what it must not.
 *
 * Two rules locked in here, both decided 2026-08-27.
 *
 * A micro-task belongs to ONE routine item. Moving to the next item does not carry the list
 * over. The one exception is a pinned name, which the server materialises on every item the
 * person arrives at, as a fresh row, ticked on its own. So "Stretch" pinned on item A shows up
 * on item B too, and ticking it on B leaves A's row untouched. That is the whole point of the
 * per-item scope: history later says WHICH habit each small thing was done alongside.
 *
 * A cycle is written only when it COMPLETES, and abandoning one writes nothing. The feature has
 * no failure state, so there is nothing to record. Playwright cannot wait 25 minutes, so the
 * completed-cycle write is exercised through the API and the abandoned one through the UI,
 * which is the half where a regression would actually come from (a well-meaning "log the
 * partial session" change).
 *
 * What is deliberately NOT here: the snapshot join (micro-tasks and pomodoro counts on each
 * check row). Snapshots are created only by the per-timezone scheduler, so no browser run can
 * reach one; that join is locked in by FocusServiceIT on the backend.
 */

// The account's day and the browser's day have to agree, or the micro-task the screen writes
// lands on a different date than the one the API read below asks for.
test.use({ timezoneId: "Europe/Lisbon" });

async function seedTwoItemList(
  ctx: Parameters<typeof createCategory>[0],
  accessToken: string,
): Promise<{ routineId: string; itemIds: string[] }> {
  const { id: categoryId } = await createCategory(ctx, accessToken, {
    name: "Work",
    icon: "icon:fa-briefcase",
    description: "Seeded for E2E",
    experience: "BEGINNER",
  });
  const habitIds: string[] = [];
  for (const name of ["Deep work", "Inbox zero"]) {
    const { id } = await createHabit(ctx, accessToken, {
      name,
      description: name,
      motivationalPhrase: "One thing at a time",
      iconId: "icon:fa-tint",
      importance: 3,
      dificulty: 1,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    habitIds.push(id);
  }
  const { id: routineId } = await createRoutine(ctx, accessToken, {
    name: "Focus list",
    iconId: "lucide:list",
    type: "LIST",
    items: habitIds.map((habitId) => ({ habitId })),
  });
  await createSchedule(ctx, accessToken, { days: [currentWeekDay()], routineId });
  const itemIds = await fetchListItemGroupIds(ctx, accessToken, routineId);
  expect(itemIds).toHaveLength(2);
  return { routineId, itemIds };
}

test.describe("Focus Mode persistence", () => {
  test("a micro-task stays on its item, and only a pinned one follows to the next", async ({
    authedPage,
    api,
  }) => {
    const { itemIds } = await seedTwoItemList(api.ctx, api.accessToken);
    const [itemA, itemB] = itemIds;

    await authedPage.goto("/focus");
    await authedPage.getByTestId("focus-mode-toggle").click();
    await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Deep work");

    await test.step("the screen asks the server for THIS item's list", async () => {
      // The read is keyed by the item group, which is the contract the whole scope rests on.
      await authedPage.waitForResponse(
        (r) => r.url().includes(`/focus/micro-tasks?itemGroupId=${itemA}`) && r.ok(),
      );
    });

    await test.step("write one on the first item", async () => {
      // "Add task" reveals the field; Enter submits it, the way a checklist is written in a burst.
      await authedPage.getByTestId("focus-micro-task-add").click();
      await authedPage.getByTestId("focus-micro-task-input").fill("Stretch");
      const [response] = await Promise.all([
        authedPage.waitForResponse(
          (r) =>
            r.url().endsWith("/focus/micro-tasks") && r.request().method() === "POST" && r.ok(),
        ),
        authedPage.getByTestId("focus-micro-task-input").press("Enter"),
      ]);
      expect(response.request().postDataJSON()).toMatchObject({ itemGroupId: itemA, name: "Stretch" });
      await expect(authedPage.getByTestId("focus-micro-tasks")).toContainText("Stretch");
    });

    await test.step("the next item starts with nothing", async () => {
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.url().includes(`/focus/micro-tasks?itemGroupId=${itemB}`) && r.ok(),
        ),
        authedPage.getByTestId("focus-ultra-next").click(),
      ]);
      await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Inbox zero");
      await expect(authedPage.getByTestId("focus-micro-tasks")).not.toContainText("Stretch");
    });

    await test.step("pin it back on the first item", async () => {
      await authedPage.getByTestId("focus-ultra-prev").click();
      await expect(authedPage.getByTestId("focus-micro-tasks")).toContainText("Stretch");
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.url().includes("/pin?pinned=true") && r.request().method() === "PATCH" && r.ok(),
        ),
        authedPage.locator('[data-testid^="focus-micro-task-pin-"]').first().click(),
      ]);
    });

    await test.step("now it is waiting on the next item, as its own row", async () => {
      await authedPage.getByTestId("focus-ultra-next").click();
      await expect(authedPage.getByTestId("focus-ultra").locator("h2")).toHaveText("Inbox zero");
      await expect(authedPage.getByTestId("focus-micro-tasks")).toContainText("Stretch");
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.url().includes("/toggle") && r.request().method() === "PATCH" && r.ok(),
        ),
        authedPage.locator('[data-testid^="focus-micro-task-check-"]').first().click(),
      ]);
    });

    await test.step("the server holds one row per item, ticked independently", async () => {
      const onA = await fetchFocusMicroTasks(api.ctx, api.accessToken, itemA);
      const onB = await fetchFocusMicroTasks(api.ctx, api.accessToken, itemB);
      expect(onA).toHaveLength(1);
      expect(onB).toHaveLength(1);
      expect(onA[0]).toMatchObject({ name: "Stretch", pinned: true, doneAt: null });
      expect(onB[0]).toMatchObject({ name: "Stretch", pinned: true });
      expect(onB[0].doneAt).not.toBeNull();
      expect(onA[0].id).not.toBe(onB[0].id);

      const day = await fetchFocusDay(api.ctx, api.accessToken, todayIso());
      expect(day.microTasks).toHaveLength(2);
    });
  });

  test("a completed cycle is filed on its item and its day; an abandoned one writes nothing", async ({
    authedPage,
    api,
  }) => {
    const { itemIds } = await seedTwoItemList(api.ctx, api.accessToken);
    const [itemA] = itemIds;

    await test.step("stopping a running pomodoro reports nothing", async () => {
      await authedPage.goto("/focus");
      await authedPage.getByTestId("focus-mode-toggle").click();
      await expect(authedPage.getByTestId("focus-ultra")).toBeVisible();

      const cycleWrites: string[] = [];
      authedPage.on("request", (request) => {
        if (request.url().endsWith("/focus/cycles") && request.method() === "POST") {
          cycleWrites.push(request.url());
        }
      });
      await authedPage.getByTestId("focus-pomodoro-start").click();
      await expect(authedPage.getByTestId("focus-pomodoro-stop")).toBeVisible();
      await authedPage.getByTestId("focus-pomodoro-stop").click();
      await expect(authedPage.getByTestId("focus-pomodoro-start")).toBeVisible();
      expect(cycleWrites).toHaveLength(0);

      const day = await fetchFocusDay(api.ctx, api.accessToken, todayIso());
      expect(day.cycles).toHaveLength(0);
    });

    await test.step("a completed one lands, dated by the server", async () => {
      const endedAt = new Date();
      const startedAt = new Date(endedAt.getTime() - 25 * 60_000);
      const response = await recordFocusCycle(api.ctx, api.accessToken, {
        itemGroupId: itemA,
        kind: "POMODORO",
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        minutes: 25,
      });
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({ itemGroupId: itemA, kind: "POMODORO", minutes: 25 });
      // The day comes from the account's timezone, never from the client.
      expect(body.date).toBe(todayIso());

      const day = await fetchFocusDay(api.ctx, api.accessToken, todayIso());
      expect(day.cycles).toHaveLength(1);
      expect(day.cycles[0].itemGroupId).toBe(itemA);
    });

    await test.step("a cycle that ends before it starts is refused", async () => {
      const now = new Date();
      const response = await recordFocusCycle(api.ctx, api.accessToken, {
        itemGroupId: null,
        kind: "SHORT_BREAK",
        startedAt: now.toISOString(),
        endedAt: new Date(now.getTime() - 60_000).toISOString(),
        minutes: 5,
      });
      expect(response.status()).toBe(400);
    });
  });
});
