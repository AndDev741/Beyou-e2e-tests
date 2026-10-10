import { test, expect } from "../fixtures/auth";
import {
  addFocusMicroTask,
  addNotebookNode,
  createCategory,
  createGoal,
  createHabit,
  createNotebookCard,
  createNotebookTopic,
  createRoutine,
  exportUserData,
  fetchDailyBriefing,
  fetchListItemGroupIds,
  GoalPayload,
  recordFocusCycle,
} from "../support/apiClient";

/**
 * The data export, read off the real endpoint for an account that has used the features
 * added after the export was last made whole.
 *
 * The export promises that anything it leaves out is named under `notIncluded`. Focus mode,
 * the goal tree, LIST routines, the briefing and most of the notebook all shipped without a
 * line in it, so a person who downloaded the file and then deleted the account lost them
 * without being told. The backend's completeness test reads the schema to catch the next
 * one; this spec locks in the wire shape the file actually has, through the HTTP layer and
 * its JSON writer, which a service-level test never touches.
 *
 * API-only on purpose. The download button hands this object to the browser untouched, so
 * there is nothing on the screen to drive that the response does not already show.
 */

type Row = Record<string, unknown>;

const iso = (d: Date) => d.toISOString().slice(0, 10);

function goalPayload(name: string, parentId: string | null): GoalPayload {
  const today = new Date();
  const out = new Date(today);
  out.setDate(today.getDate() + 30);
  return {
    name,
    iconId: "icon:fa-flag",
    targetValue: 10,
    unit: "chapters",
    currentValue: 0,
    categoriesId: [],
    startDate: iso(today),
    endDate: iso(out),
    status: "NOT_STARTED",
    term: "MEDIUM_TERM",
    parentId,
  };
}

test.describe("Data export", () => {
  test("carries the goal tree, the routine shape, focus, the briefing and the notebook board", async ({
    api,
  }) => {
    const { ctx, accessToken } = api;

    const { id: parentGoal } = await createGoal(ctx, accessToken, goalPayload("Speak Spanish", null));
    const { id: childGoal } = await createGoal(ctx, accessToken, goalPayload("Finish the A1 book", parentGoal));

    const { id: categoryId } = await createCategory(ctx, accessToken, {
      name: "Languages",
      icon: "icon:fa-book",
      description: "seeded for the export",
      experience: "BEGINNER",
    });
    const { id: habitId } = await createHabit(ctx, accessToken, {
      name: "Read ten pages",
      iconId: "lucide:book",
      importance: 3,
      dificulty: 2,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    const routine = await createRoutine(ctx, accessToken, {
      name: "Evenings",
      iconId: "lucide:moon",
      type: "LIST",
      items: [{ habitId }],
    });
    const [itemGroupId] = await fetchListItemGroupIds(ctx, accessToken, routine.id);

    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 25 * 60 * 1000);
    const cycle = await recordFocusCycle(ctx, accessToken, {
      itemGroupId,
      kind: "POMODORO",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      minutes: 25,
    });
    expect(cycle.status(), await cycle.text()).toBe(201);
    await addFocusMicroTask(ctx, accessToken, { itemGroupId, name: "find the bookmark" });

    const topic = await createNotebookTopic(ctx, accessToken, "Spanish");
    const node = await addNotebookNode(ctx, accessToken, topic.id, "Verbs");
    const card = await createNotebookCard(ctx, accessToken, node.pageId!, "ser", "to be");

    // Opening the briefing is what writes its row for the day.
    await fetchDailyBriefing(ctx, accessToken);

    const exported = await exportUserData(ctx, accessToken);

    await test.step("the goal tree survives as a tree", async () => {
      const goals = exported.goals as Row[];
      expect(goals.find((g) => g.id === childGoal)?.parentId).toBe(parentGoal);
      expect(goals.find((g) => g.id === parentGoal)?.parentId).toBeNull();
    });

    await test.step("a LIST routine says it is one, and its items keep their order", async () => {
      const routines = exported.routines as Row[];
      const list = routines.find((r) => r.id === routine.id)!;
      expect(list.type, "this read DiaryRoutine for every routine before").toBe("LIST");
      const section = (list.sections as Row[])[0];
      expect((section.habits as Row[])[0].orderIndex).toBe(0);
    });

    await test.step("focus mode has a section of its own", async () => {
      const focus = exported.focus as { cycles: Row[]; microTasks: Row[] };
      expect(focus.cycles).toHaveLength(1);
      expect(focus.cycles[0]).toMatchObject({ kind: "POMODORO", minutes: 25, itemGroupId });
      expect(focus.microTasks).toHaveLength(1);
      expect(focus.microTasks[0]).toMatchObject({ name: "find the bookmark", itemGroupId });
    });

    await test.step("the notebook carries its board and the card ids its reviews point at", async () => {
      const notebook = exported.notebook as {
        board: { nodes: Row[]; edges: Row[] };
        flashcards: Row[];
        flashcardReviews: Row[];
        studyOutputs: Row[];
      };
      expect(notebook.board.nodes).toContainEqual(
        expect.objectContaining({ id: node.id, boardPageId: topic.id, pageId: node.pageId }),
      );
      expect(Array.isArray(notebook.board.edges)).toBe(true);
      expect(notebook.flashcards).toContainEqual(expect.objectContaining({ id: card.id }));
      expect(notebook.flashcardReviews).toEqual([]);
      expect(notebook.studyOutputs).toEqual([]);
    });

    await test.step("the briefing, sign-ins and nudge mails are listed, even when empty", async () => {
      const briefings = exported.dailyBriefings as Row[];
      expect(briefings).toHaveLength(1);
      expect(briefings[0]).toHaveProperty("todayLines");
      const profile = exported.profile as Row;
      expect(profile.linkedSignIns).toEqual([]);
      expect(exported.engagementEmailsSent).toEqual([]);
    });

    await test.step("what stays out says so", async () => {
      expect(Object.keys(exported.notIncluded as Row)).toEqual(
        expect.arrayContaining([
          "routineSnapshots",
          "notebookSourceText",
          "xpHistory",
          "dailyBriefingFacts",
          "credentials",
        ]),
      );
    });
  });
});
