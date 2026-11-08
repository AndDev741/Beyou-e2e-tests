import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import {
  apiUrl,
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  fetchRoutines,
  type WeekDay,
} from "../support/apiClient";

const WEEK: WeekDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The account's weekday, `offset` days from today. Test accounts register with no timezone, so
 * the server reads them in UTC, and every "is this today" answer here comes from the server.
 * The runner's local weekday would be the wrong one for a few hours a day on any machine that
 * is not in UTC.
 */
function accountWeekDay(offset = 0): WeekDay {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return WEEK[day.getUTCDay()];
}

type Api = { ctx: APIRequestContext; accessToken: string };

async function seedHabit(api: Api, categoryId: string, name: string) {
  return createHabit(api.ctx, api.accessToken, {
    name,
    iconId: "lucide:droplet",
    importance: 3,
    dificulty: 3,
    categoriesId: [categoryId],
    experience: "BEGINNER",
  });
}

/**
 * The case that asked for the feature: a routine that runs on two days, holding "clean the
 * fish tank" limited to only one of them. Here the routine runs today and tomorrow and the
 * fish tank belongs to tomorrow, so today it must be gone from everything that describes
 * today while it stays in the routine itself.
 */
async function seedWeekendRoutine(api: Api, options: { limitFishTank: boolean } = { limitFishTank: true }) {
  const category = await createCategory(api.ctx, api.accessToken, {
    name: "Home",
    icon: "icon:fa-heart",
    description: "Seeded for the item-days specs",
    experience: "BEGINNER",
  });
  const meditate = await seedHabit(api, category.id, "Meditate");
  const fishTank = await seedHabit(api, category.id, "Clean the fish tank");
  const tomorrow = accountWeekDay(1);
  const routine = await createRoutine(api.ctx, api.accessToken, {
    name: "Weekend",
    iconId: "lucide:sun",
    routineSections: [
      {
        name: "Morning",
        iconId: "lucide:sunrise",
        startTime: "07:00",
        endTime: "09:00",
        habitGroup: [
          { habitId: meditate.id, startTime: "07:00", endTime: "07:30" },
          {
            habitId: fishTank.id,
            startTime: "08:00",
            endTime: "08:30",
            ...(options.limitFishTank ? { days: [tomorrow] } : {}),
          },
        ],
      },
    ],
  });
  await createSchedule(api.ctx, api.accessToken, {
    days: [accountWeekDay(0), tomorrow],
    routineId: routine.id,
  });
  return { routineId: routine.id, meditateId: meditate.id, fishTankId: fishTank.id, tomorrow };
}

/**
 * Per-item weekdays. The server owns the rule (ScheduledOnDayResolver) and applies it before
 * anything reaches a client, which is what these specs lock in: GET /routine/today, the check
 * endpoint, and the dashboard that renders the former. The dashboard part is the one an
 * API-level spec cannot see, since a client could still be drawing items the server left out.
 */
test.describe("Routine item days", () => {
  test("an item limited to another weekday stays off today's routine", async ({ authedPage, api }) => {
    const seeded = await seedWeekendRoutine(api);
    const auth = { Authorization: `Bearer ${api.accessToken}` };

    await test.step("the routine itself keeps the item, with its days", async () => {
      const [routine] = await fetchRoutines(api.ctx, api.accessToken);
      const groups = routine.routineSections[0].habitGroup ?? [];
      expect(groups.map((group) => group.habitId).sort()).toEqual(
        [seeded.meditateId, seeded.fishTankId].sort(),
      );
      expect(groups.find((group) => group.habitId === seeded.fishTankId)?.days).toEqual([seeded.tomorrow]);
      expect(groups.find((group) => group.habitId === seeded.meditateId)?.days).toEqual([]);
    });

    await test.step("GET /routine/today leaves it out", async () => {
      const response = await api.ctx.get(`${apiUrl()}/routine/today`, { headers: auth });
      expect(response.ok()).toBe(true);
      const today = await response.json();
      expect(today.id).toBe(seeded.routineId);
      const habitIds = today.routineSections.flatMap(
        (section: { habitGroup: Array<{ habitId: string }> }) => section.habitGroup.map((group) => group.habitId),
      );
      expect(habitIds).toEqual([seeded.meditateId]);
    });

    await test.step("checking it today is refused with its own error key", async () => {
      const [routine] = await fetchRoutines(api.ctx, api.accessToken);
      const fishTankGroup = (routine.routineSections[0].habitGroup ?? []).find(
        (group) => group.habitId === seeded.fishTankId,
      );
      const response = await api.ctx.post(`${apiUrl()}/routine/check`, {
        headers: auth,
        data: {
          routineId: seeded.routineId,
          habitGroupDTO: { habitGroupId: fishTankGroup?.id, startTime: fishTankGroup?.startTime },
        },
      });
      expect(response.status()).toBe(400);
      expect((await response.json()).errorKey).toBe("ROUTINE_ITEM_NOT_ACTIVE_ON_DAY");
    });

    await test.step("the dashboard shows the routine without it", async () => {
      await authedPage.goto("/dashboard");
      await expect(authedPage.getByText("Meditate").first()).toBeVisible();
      await expect(authedPage.getByText("Clean the fish tank")).toHaveCount(0);
    });
  });
  /**
   * The editor is what sends `days`. The payload builder rebuilds every group field by hand and
   * the add-item tray used to copy only ids and times, so a screen that dropped the field would
   * save the routine "fine" and the limit would silently never exist. Only a spec that goes
   * through the screen can see that.
   */
  test("the routine editor limits an item, and the Routines page dims it today", async ({ authedPage, api }) => {
    const seeded = await seedWeekendRoutine(api, { limitFishTank: false });

    await authedPage.goto("/routines");

    await test.step("pick the fish tank's day in the editor and save", async () => {
      await authedPage.getByRole("button", { name: "Edit" }).first().click();
      const dialog = authedPage.getByRole("dialog");
      // The editor fills itself from the routine after it opens, and a section that already
      // holds items starts closed. Wait for the form to carry the routine, then open the section
      // until it says so: a click landing during that first render is lost with the remount.
      await expect(dialog.getByRole("textbox", { name: /name/i })).toHaveValue("Weekend");
      const section = dialog.getByRole("button", { name: "Morning", exact: true });
      await expect(async () => {
        if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
        await expect(section).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
      }).toPass({ timeout: 10_000 });
      await dialog.getByRole("button", { name: "Days for Clean the fish tank" }).click();

      const days = dialog.getByRole("group", { name: "Days" });
      await expect(days.getByText("Every day of the routine")).toBeVisible();
      const tomorrowButton = days.getByRole("button", { name: seeded.tomorrow, exact: true });
      await tomorrowButton.click();
      await expect(tomorrowButton).toHaveAttribute("aria-pressed", "true");

      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await Promise.all([
        authedPage.waitForResponse(
          (response) => /\/routine\/[0-9a-f-]+$/.test(response.url()) && response.request().method() === "PUT" && response.ok(),
        ),
        dialog.getByRole("button", { name: "Save routine" }).click(),
      ]);
    });

    await test.step("the server stored the day on that item only", async () => {
      const [routine] = await fetchRoutines(api.ctx, api.accessToken);
      const groups = routine.routineSections[0].habitGroup ?? [];
      expect(groups.find((group) => group.habitId === seeded.fishTankId)?.days).toEqual([seeded.tomorrow]);
      expect(groups.find((group) => group.habitId === seeded.meditateId)?.days).toEqual([]);
    });

    await test.step("today, the Routines page shows it dimmed and with nothing to tick", async () => {
      await authedPage.reload();
      // The card's own toggle. A loose /expand/i also matches the sidebar's "Collapse or expand
      // the menu", which comes first in the page.
      await authedPage.getByRole("main").getByRole("button", { name: "Expand", exact: true }).click();
      // Today's share leaves the fish tank out: one item runs today, and it is not done yet.
      // The card, the section and the day bar all say it, and none of them says 0/2.
      await expect(authedPage.getByRole("main").getByText("0/1").first()).toBeVisible();
      await expect(authedPage.getByRole("main").getByText("0/2")).toHaveCount(0);
      const offDay = authedPage.getByTestId("off-day-item");
      await expect(offDay).toHaveCount(1);
      await expect(offDay).toContainText("Clean the fish tank");
      await expect(offDay.getByRole("checkbox")).toHaveCount(0);
    });

    await test.step("and the dashboard leaves it out", async () => {
      await authedPage.goto("/dashboard");
      await expect(authedPage.getByText("Meditate").first()).toBeVisible();
      await expect(authedPage.getByText("Clean the fish tank")).toHaveCount(0);
    });
  });
});
