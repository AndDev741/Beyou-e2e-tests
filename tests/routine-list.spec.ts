import { test, expect } from "../fixtures/auth";
import {
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  fetchUserSnapshot,
} from "../support/apiClient";

/** A habit needs a category and the 1-5 scales; only the name varies per test. */
async function seedHabit(
  api: { ctx: Parameters<typeof createHabit>[0]; accessToken: string },
  categoryId: string,
  name: string,
  iconId: string,
) {
  return createHabit(api.ctx, api.accessToken, {
    name,
    iconId,
    importance: 3,
    dificulty: 3,
    categoriesId: [categoryId],
    experience: "BEGINNER",
  });
}

async function seedCategoryId(api: { ctx: Parameters<typeof createCategory>[0]; accessToken: string }) {
  const category = await createCategory(api.ctx, api.accessToken, {
    name: "Health",
    icon: "icon:fa-heart",
    description: "Seeded for the list-routine specs",
    experience: "BEGINNER",
  });
  return category.id;
}

/**
 * The LIST routine: a flat, ordered checklist with no sections and no times.
 *
 * Driven through the UI rather than the API on purpose. The point of these specs is that
 * the SCREENS send and render the right shape — the payload builder chooses between
 * `items` and `routineSections`, and the backend rejects a body carrying both, so a
 * component that quietly started sending the wrong one would 400 for every user while an
 * API-level spec stayed green, because it never goes through the component.
 *
 * What is deliberately NOT re-tested here: XP arithmetic, streak walks and snapshot
 * writing. A list is checked by the same endpoint and the same service a sectioned item
 * is, and routine-checkin.spec.ts already locks that down. What is new is the shape.
 */
test.describe("List routines", () => {
  test("built through the form, scheduled, and checked from the dashboard", async ({
    authedPage,
    api,
    testUser,
  }) => {
    const categoryId = await seedCategoryId(api);
    const habit = await seedHabit(api, categoryId, "Call mom", "lucide:phone");

    await authedPage.goto("/routines");
    await authedPage.getByRole("button", { name: /create routine/i }).first().click();

    await test.step("the list type is offered, not dimmed with a 'soon' label", async () => {
      const listOption = authedPage.getByRole("radio", { name: /^list$/i });
      await expect(listOption).toBeVisible();
      await expect(listOption).toBeEnabled();
      await listOption.click();
    });

    await test.step("the form drops sections entirely", async () => {
      // The sections editor is what a daily routine shows here. Its absence IS the feature:
      // if this button is present the type switch did not swap the form.
      await expect(authedPage.getByTestId("add-section")).toHaveCount(0);
      await expect(authedPage.getByTestId("add-list-item")).toBeVisible();
    });

    await authedPage.getByLabel("Name").fill("Errands");
    await authedPage.getByTestId("add-list-item").click();
    await authedPage.getByLabel("Call mom").click();
    await authedPage.getByRole("button", { name: /^Add 1$/ }).click();

    await test.step("save sends items and no sections", async () => {
      const [request] = await Promise.all([
        authedPage.waitForRequest(
          (r) => r.url().endsWith("/routine") && r.method() === "POST",
        ),
        authedPage.getByRole("button", { name: /save routine/i }).click(),
      ]);
      const body = request.postDataJSON();
      expect(body.type).toBe("LIST");
      expect(body.items).toHaveLength(1);
      expect(body.items[0].habitId).toBe(habit.id);
      // Not merely empty — absent. A body carrying both shapes is refused outright.
      expect(body.routineSections).toBeUndefined();
    });

    await expect(authedPage.getByText("Errands").first()).toBeVisible();

    await test.step("the card counts items, not sections", async () => {
      const card = authedPage.getByRole("button", { name: /Errands/ }).first();
      await expect(card).not.toContainText(/section/i);
    });
  });

  test("a scheduled list reaches the dashboard and its items check there", async ({
    authedPage,
    api,
    testUser,
  }) => {
    const categoryId = await seedCategoryId(api);
    const habit = await seedHabit(api, categoryId, "Stretch", "lucide:activity");
    const routine = await createRoutine(api.ctx, api.accessToken, {
      name: "Loose ends",
      iconId: "lucide:list",
      type: "LIST",
      items: [{ habitId: habit.id }],
    });
    // Scheduling is not optional for a list, exactly as for a daily routine: only a
    // scheduled routine reaches the dashboard, and only a scheduled one is snapshotted.
    await createSchedule(api.ctx, api.accessToken, {
      days: [currentWeekDay()],
      routineId: routine.id,
    });

    const before = await fetchUserSnapshot(api.ctx, {
      email: testUser.email,
      password: testUser.password,
    });
    expect(before.xp).toBe(0);

    await authedPage.goto("/dashboard");
    await expect(authedPage.getByText("Loose ends").first()).toBeVisible();
    // "· List" rather than "· N sections": the dashboard header knows the shape.
    await expect(
      authedPage.locator('[data-tutorial-id="dashboard-routine-today"]'),
    ).toContainText("List");

    const row = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Stretch" });
    const checkbox = row.locator('input[type="checkbox"]').first();
    // Same as routine-checkin.spec.ts: the input is sr-only with the ring drawn over it,
    // so the label is what a person actually hits.
    const toggle = row.locator('label:has(input[type="checkbox"])').first();

    await expect(checkbox).not.toBeChecked();
    await Promise.all([
      authedPage.waitForResponse(
        (r) => r.url().endsWith("/routine/check") && r.ok(),
      ),
      toggle.click(),
    ]);
    await expect(checkbox).toBeChecked();

    await test.step("XP landed, through the very same endpoint a sectioned item uses", async () => {
      const after = await fetchUserSnapshot(api.ctx, {
        email: testUser.email,
        password: testUser.password,
      });
      expect(after.xp).toBeGreaterThan(before.xp);
    });

    await test.step("and it survives a reload", async () => {
      await authedPage.reload();
      await expect(
        authedPage
          .locator("div")
          .filter({ has: authedPage.locator('input[type="checkbox"]') })
          .filter({ hasText: "Stretch" })
          .locator('input[type="checkbox"]')
          .first(),
      ).toBeChecked();
    });
  });

  test("a list keeps its check history when its items are reordered", async ({
    authedPage,
    api,
  }) => {
    const categoryId = await seedCategoryId(api);
    const first = await seedHabit(api, categoryId, "Read a book", "lucide:book");
    const second = await seedHabit(api, categoryId, "Water plants", "lucide:sprout");
    const routine = await createRoutine(api.ctx, api.accessToken, {
      name: "Evening",
      iconId: "lucide:moon",
      type: "LIST",
      items: [{ habitId: first.id }, { habitId: second.id }],
    });
    await createSchedule(api.ctx, api.accessToken, {
      days: [currentWeekDay()],
      routineId: routine.id,
    });

    await authedPage.goto("/dashboard");
    const row = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Read a book" });
    await Promise.all([
      authedPage.waitForResponse((r) => r.url().endsWith("/routine/check") && r.ok()),
      row.locator('label:has(input[type="checkbox"])').first().click(),
    ]);

    await test.step("reorder through the edit form", async () => {
      await authedPage.goto("/routines");
      await authedPage.getByRole("button", { name: /^Edit$/ }).first().click();
      // Moving the second item up is what rewrites every orderIndex. The row ids have to
      // ride along in the request, or the merge recreates the groups and the check-in
      // recorded a moment ago is gone with them.
      const [request] = await Promise.all([
        authedPage.waitForRequest(
          (r) => r.url().includes("/routine/") && r.method() === "PUT",
        ),
        authedPage.getByRole("button", { name: /save/i }).last().click(),
      ]);
      const body = request.postDataJSON();
      expect(body.items).toHaveLength(2);
      for (const item of body.items) {
        expect(item.id).toBeTruthy();
      }
    });

    await test.step("the check-in is still there", async () => {
      await authedPage.goto("/dashboard");
      await expect(
        authedPage
          .locator("div")
          .filter({ has: authedPage.locator('input[type="checkbox"]') })
          .filter({ hasText: "Read a book" })
          .locator('input[type="checkbox"]')
          .first(),
      ).toBeChecked();
    });
  });
});
