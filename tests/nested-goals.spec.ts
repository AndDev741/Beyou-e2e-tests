import { test, expect } from "../fixtures/auth";
import {
  completeGoal,
  createGoal,
  deleteGoal,
  fetchGoals,
  fetchUserSnapshot,
  GoalPayload,
  increaseGoal,
  loginUser,
  moveGoalUnder,
  newApiContext,
  postGoal,
  registerUser,
} from "../support/apiClient";
import { makeUser } from "../support/testData";

/**
 * Nested goals: the tree rules live in ONE place, GoalService.resolveParent, and both
 * clients only pre-filter their parent picker. These specs hit the wire directly because
 * that is where the rule is: a picker that hides an option proves nothing about what the
 * server accepts from a client that did not hide it (or from the AI agent, which sends
 * ids straight to the same service).
 *
 * What is locked in:
 *   - a parent must be the caller's own goal (GOAL_NOT_OWNED),
 *   - no cycles (GOAL_PARENT_CYCLE), measured on the whole chain, not one edge,
 *   - three levels at most (GOAL_DEPTH_EXCEEDED), measured from above AND below,
 *   - deleting a parent promotes its children (ON DELETE SET NULL), never deletes them,
 *   - a sub-goal's first increment starts a NOT_STARTED parent, and nothing else moves,
 *   - completion still pays once per goal: a parent with complete children has no XP
 *     until it is completed itself.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

function goalPayload(name: string, parentId?: string | null): GoalPayload {
  const today = new Date();
  const out = new Date(today);
  out.setDate(today.getDate() + 30);
  return {
    name,
    iconId: "icon:fa-flag",
    targetValue: 10,
    unit: "steps",
    currentValue: 0,
    categoriesId: [],
    startDate: iso(today),
    endDate: iso(out),
    status: "NOT_STARTED",
    term: "MEDIUM_TERM",
    parentId: parentId ?? null,
  };
}

async function errorKeyOf(response: Awaited<ReturnType<typeof postGoal>>): Promise<string> {
  const body = (await response.json()) as { errorKey?: string; error?: string };
  return body.errorKey ?? body.error ?? "";
}

test.describe("Nested goals", () => {
  test("a chain of three is accepted, a fourth level is refused from above and from below", async ({ api }) => {
    const { id: big } = await createGoal(api.ctx, api.accessToken, goalPayload("Run a marathon"));
    const { id: medium } = await createGoal(api.ctx, api.accessToken, goalPayload("Run 10 km", big));
    const { id: small } = await createGoal(api.ctx, api.accessToken, goalPayload("Run 3x a week", medium));

    const rows = await fetchGoals(api.ctx, api.accessToken);
    expect(rows.find((g) => g.id === medium)?.parentId).toBe(big);
    expect(rows.find((g) => g.id === small)?.parentId).toBe(medium);
    expect(rows.find((g) => g.id === big)?.parentId).toBeNull();

    await test.step("a fourth level under the leaf is refused", async () => {
      const refused = await postGoal(api.ctx, api.accessToken, goalPayload("Lace up", small));
      expect(refused.status()).toBe(400);
      expect(await errorKeyOf(refused)).toBe("GOAL_DEPTH_EXCEEDED");
    });

    await test.step("moving a goal that carries children under a goal that has a parent overflows too", async () => {
      // `other` has one child, so it is two levels tall. Under `medium` (level 2) the chain
      // would be big > medium > other > otherChild: four.
      const { id: other } = await createGoal(api.ctx, api.accessToken, goalPayload("Learn French"));
      await createGoal(api.ctx, api.accessToken, goalPayload("Finish A1", other));

      const refused = await moveGoalUnder(api.ctx, api.accessToken, other, medium);
      expect(refused.status()).toBe(400);
      expect(await errorKeyOf(refused)).toBe("GOAL_DEPTH_EXCEEDED");

      // Under `big` (level 1) it fits: big > other > otherChild.
      const accepted = await moveGoalUnder(api.ctx, api.accessToken, other, big);
      expect(accepted.ok()).toBe(true);
    });
  });

  test("a goal cannot become a sub-goal of its own descendant", async ({ api }) => {
    const { id: root } = await createGoal(api.ctx, api.accessToken, goalPayload("Read more"));
    const { id: child } = await createGoal(api.ctx, api.accessToken, goalPayload("Read 12 books", root));

    const self = await moveGoalUnder(api.ctx, api.accessToken, root, root);
    expect(self.status()).toBe(400);
    expect(await errorKeyOf(self)).toBe("GOAL_PARENT_CYCLE");

    const underChild = await moveGoalUnder(api.ctx, api.accessToken, root, child);
    expect(underChild.status()).toBe(400);
    expect(await errorKeyOf(underChild)).toBe("GOAL_PARENT_CYCLE");
  });

  test("a parent from another account is refused as not owned", async ({ api }) => {
    // A second, unrelated account: its goal id is real, just not ours.
    const stranger = makeUser();
    const strangerCtx = await newApiContext();
    try {
      await registerUser(strangerCtx, stranger);
      const { accessToken: strangerToken } = await loginUser(strangerCtx, {
        email: stranger.email,
        password: stranger.password,
      });
      const { id: foreign } = await createGoal(strangerCtx, strangerToken, goalPayload("Not yours"));

      const refused = await postGoal(api.ctx, api.accessToken, goalPayload("Sneaky", foreign));
      expect(refused.status()).toBe(400);
      expect(await errorKeyOf(refused)).toBe("GOAL_NOT_OWNED");
    } finally {
      await strangerCtx.dispose();
    }
  });

  test("deleting a parent promotes its children instead of deleting them", async ({ api }) => {
    const { id: parent } = await createGoal(api.ctx, api.accessToken, goalPayload("Get fit"));
    const { id: a } = await createGoal(api.ctx, api.accessToken, goalPayload("Gym twice a week", parent));
    const { id: b } = await createGoal(api.ctx, api.accessToken, goalPayload("Walk daily", parent));

    await deleteGoal(api.ctx, api.accessToken, parent);

    const rows = await fetchGoals(api.ctx, api.accessToken);
    expect(rows.find((g) => g.id === parent)).toBeUndefined();
    expect(rows.find((g) => g.id === a)?.parentId).toBeNull();
    expect(rows.find((g) => g.id === b)?.parentId).toBeNull();
  });

  test("progress in a sub-goal starts its parent, and XP still pays once per goal", async ({ api, testUser }) => {
    const credentials = { email: testUser.email, password: testUser.password };
    const { id: parent } = await createGoal(api.ctx, api.accessToken, goalPayload("Ship the app"));
    const { id: child } = await createGoal(api.ctx, api.accessToken, goalPayload("Write the docs", parent));

    await test.step("the first increment on the child moves the parent out of NOT_STARTED", async () => {
      await increaseGoal(api.ctx, api.accessToken, child, 3);
      const rows = await fetchGoals(api.ctx, api.accessToken);
      expect(rows.find((g) => g.id === parent)?.status).toBe("IN_PROGRESS");
      // The parent's own progress is untouched: the child's numbers are the child's.
      expect(rows.find((g) => g.id === parent)?.currentValue).toBe(0);
    });

    await test.step("completing the child pays the child, not the parent", async () => {
      const before = await fetchUserSnapshot(api.ctx, credentials);
      await increaseGoal(api.ctx, api.accessToken, child, 7);
      const refresh = await completeGoal(api.ctx, api.accessToken, child);
      expect(refresh.refreshUser.xp).toBeGreaterThan(before.xp);

      const rows = await fetchGoals(api.ctx, api.accessToken);
      expect(rows.find((g) => g.id === child)?.complete).toBe(true);
      expect(rows.find((g) => g.id === parent)?.complete).toBe(false);
    });
  });

  /**
   * The one browser step: the form has to SEND the parent. An API spec cannot see a
   * select that renders and is never read on submit, and that is the failure mode a
   * refactor of the form is most likely to produce.
   */
  test("the goals page creates a sub-goal through the form and folds it under its parent", async ({
    authedPage,
    api,
  }) => {
    const { id: parent } = await createGoal(api.ctx, api.accessToken, goalPayload("Learn the guitar"));

    await authedPage.goto("/goals");
    await authedPage.getByTestId("create-goal").click();
    const form = authedPage.locator("form:visible");
    await form.locator("#goal-title").fill("Practice 20 minutes a day");
    await form.locator('input[name="icon-small"]').fill("music");
    await form.getByRole("button", { name: /music/i }).first().click();
    await form.getByLabel("Target").fill("30");
    await form.getByLabel("Unit").fill("days");
    await form.getByLabel("Start date").fill(iso(new Date()));
    const end = new Date();
    end.setDate(end.getDate() + 30);
    await form.getByLabel("End date").fill(iso(end));
    await form.getByTestId("goal-parent").selectOption(parent);
    // Wait for the create to land before reading the API: without this the read raced
    // the POST and lost on a slow runner (three retries in a row on the frontend's E2E
    // job, while the same spec passed elsewhere).
    await Promise.all([
      authedPage.waitForResponse((r) => r.url().endsWith("/goal") && r.request().method() === "POST" && r.ok()),
      form.getByRole("button", { name: "Save goal", exact: true }).click(),
    ]);

    // The server got the parent: the card of the main goal now counts one sub-goal.
    const rows = await fetchGoals(api.ctx, api.accessToken);
    const child = rows.find((g) => g.name === "Practice 20 minutes a day");
    expect(child?.parentId).toBe(parent);

    const parentCard = authedPage.locator(`#goal-${parent}`);
    await expect(parentCard.getByText("0/1 sub-goals")).toBeVisible();
    // Grouped by default: the sub-goal is not a card of its own on the page.
    await expect(authedPage.locator(`#goal-${child!.id}`)).toHaveCount(0);
  });
});
