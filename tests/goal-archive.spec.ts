import { test, expect } from "../fixtures/auth";
import {
  archiveGoal,
  completeGoal,
  createGoal,
  fetchGoals,
  fetchUserSnapshot,
  moveGoalUnder,
  postGoal,
  type GoalPayload,
  type GoalRow,
} from "../support/apiClient";

/**
 * Archived goals (kanban: "Arquivar metas"): put away, not deleted.
 *
 * The rules locked in here are the ones that live on the server and that neither client could
 * be trusted to repeat:
 *
 *   - archiving a goal takes its sub-goals with it, under ONE stamp, and restoring it brings
 *     back exactly those, so a sub-goal archived on its own earlier stays archived;
 *   - archiving is not an outcome: it moves no XP and leaves the status alone;
 *   - nothing new goes under an archived goal, but the link a sub-goal already has survives
 *     an edit, because every edit sends the parent back.
 *
 * Plus one UI walk, because the page is where "archived" either becomes a place you can find
 * again or a goal that simply disappeared.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

function goalPayload(name: string, parentId: string | null = null, targetValue = 10): GoalPayload {
  const today = new Date();
  const out = new Date(today);
  out.setDate(today.getDate() + 45);
  return {
    name,
    iconId: "icon:fa-flag",
    targetValue,
    unit: "steps",
    currentValue: 0,
    categoriesId: [],
    startDate: iso(today),
    endDate: iso(out),
    status: "NOT_STARTED",
    term: "MEDIUM_TERM",
    parentId,
  };
}

const byName = (rows: GoalRow[], name: string) => rows.find((g) => g.name === name)!;

test.describe("archived goals", () => {
  test("archiving a goal takes its sub-goals, and restoring brings back exactly those", async ({ api }) => {
    const { id: big } = await createGoal(api.ctx, api.accessToken, goalPayload("Get fit"));
    const { id: mid } = await createGoal(api.ctx, api.accessToken, goalPayload("Run 10 km", big));
    await createGoal(api.ctx, api.accessToken, goalPayload("Run 3x a week", mid));
    const { id: early } = await createGoal(api.ctx, api.accessToken, goalPayload("Swim", big));

    await test.step("a sub-goal archived on its own first", async () => {
      const response = await archiveGoal(api.ctx, api.accessToken, early, true);
      expect(response.status()).toBe(200);
    });

    await test.step("archiving the big goal archives the rest of its tree under one stamp", async () => {
      const response = await archiveGoal(api.ctx, api.accessToken, big, true);
      expect(response.status()).toBe(200);
      const changed = (await response.json()) as GoalRow[];
      // The goal first, then what came along; the one already archived is not re-stamped.
      expect(changed.map((g) => g.name)).toEqual(["Get fit", "Run 10 km", "Run 3x a week"]);
      expect(new Set(changed.map((g) => g.archivedAt)).size).toBe(1);

      const rows = await fetchGoals(api.ctx, api.accessToken);
      expect(byName(rows, "Swim").archivedAt).not.toBe(changed[0].archivedAt);
    });

    await test.step("restoring it leaves the separately archived one where it was", async () => {
      const response = await archiveGoal(api.ctx, api.accessToken, big, false);
      expect(response.status()).toBe(200);
      const rows = await fetchGoals(api.ctx, api.accessToken);
      expect(byName(rows, "Get fit").archivedAt ?? null).toBeNull();
      expect(byName(rows, "Run 10 km").archivedAt ?? null).toBeNull();
      expect(byName(rows, "Run 3x a week").archivedAt ?? null).toBeNull();
      expect(byName(rows, "Swim").archivedAt).toBeTruthy();
    });
  });

  test("archiving moves no XP and leaves a completed goal completed", async ({ api, testUser }) => {
    const { id } = await createGoal(api.ctx, api.accessToken, { ...goalPayload("Read 12 books"), currentValue: 10 });
    await completeGoal(api.ctx, api.accessToken, id);
    const before = await fetchUserSnapshot(api.ctx, { email: testUser.email, password: testUser.password });

    const response = await archiveGoal(api.ctx, api.accessToken, id, true);
    expect(response.status()).toBe(200);

    const after = await fetchUserSnapshot(api.ctx, { email: testUser.email, password: testUser.password });
    expect(after.xp).toBe(before.xp);
    const row = byName(await fetchGoals(api.ctx, api.accessToken), "Read 12 books");
    expect(row.status).toBe("COMPLETED");
    expect(row.complete).toBe(true);
    expect(row.archivedAt).toBeTruthy();
  });

  test("nothing new goes under an archived goal, but an existing sub-goal stays editable", async ({ api }) => {
    const { id: parent } = await createGoal(api.ctx, api.accessToken, goalPayload("Learn the ukulele"));
    const { id: child } = await createGoal(api.ctx, api.accessToken, goalPayload("Three chords", parent));
    const { id: other } = await createGoal(api.ctx, api.accessToken, goalPayload("Practice daily"));
    await archiveGoal(api.ctx, api.accessToken, parent, true);

    const create = await postGoal(api.ctx, api.accessToken, goalPayload("Fourth chord", parent));
    expect(create.status()).toBe(400);
    expect(((await create.json()) as { errorKey?: string }).errorKey).toBe("GOAL_PARENT_ARCHIVED");

    const move = await moveGoalUnder(api.ctx, api.accessToken, other, parent);
    expect(move.status()).toBe(400);
    expect(((await move.json()) as { errorKey?: string }).errorKey).toBe("GOAL_PARENT_ARCHIVED");

    // An edit echoes the parent it already has: that must keep working.
    const edit = await moveGoalUnder(api.ctx, api.accessToken, child, parent);
    expect(edit.status()).toBe(200);
  });

  test.describe("on the goals page", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("archive from the card, find it under Archived, restore it", async ({ authedPage, api }) => {
      const { id } = await createGoal(api.ctx, api.accessToken, goalPayload("Learn Italian"));
      await createGoal(api.ctx, api.accessToken, goalPayload("Stay put"));

      await authedPage.goto("/goals");
      const card = authedPage.locator(`#goal-${id}`);
      await expect(card).toBeVisible();

      await card.hover();
      await Promise.all([
        authedPage.waitForResponse((r) => r.url().endsWith("/goal/archive") && r.ok()),
        authedPage.getByTestId(`archive-goal-${id}`).click(),
      ]);
      // Off the page, without a reload, and the rest of the list stays.
      await expect(card).toHaveCount(0);
      await expect(authedPage.getByText("Stay put")).toBeVisible();

      const status = authedPage.getByLabel("Status");
      await status.selectOption("ARCHIVED");
      await expect(authedPage.locator(`#goal-${id}`)).toBeVisible();
      await expect(authedPage.getByText("Stay put")).toHaveCount(0);

      await Promise.all([
        authedPage.waitForResponse((r) => r.url().endsWith("/goal/archive") && r.ok()),
        authedPage.getByTestId(`restore-goal-inline-${id}`).click(),
      ]);
      await status.selectOption("all");
      await expect(authedPage.locator(`#goal-${id}`)).toBeVisible();
      expect(byName(await fetchGoals(api.ctx, api.accessToken), "Learn Italian").archivedAt ?? null).toBeNull();
    });
  });
});
