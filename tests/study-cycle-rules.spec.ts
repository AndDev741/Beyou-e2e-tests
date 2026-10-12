import { test, expect } from "../fixtures/auth";
import type { APIRequestContext } from "@playwright/test";
import {
  addNotebookNode,
  archiveStudyCycle,
  createNotebookTopic,
  createStudyCycle,
  createStudyCycleRaw,
  deleteStudySession,
  everyDay,
  fetchStudyCycle,
  fetchStudyCycleRaw,
  fetchStudyHistory,
  fetchStudyToday,
  loginUser,
  logStudySessionRaw,
  newApiContext,
  planStudyCycle,
  recordFocusCycle,
  registerUser,
  replaceStudyBlocks,
  setNotebookStatus,
  type StudyCycleConfig,
} from "../support/apiClient";
import { makeUser } from "../support/testData";

/**
 * The study cycle's rules, on the wire.
 *
 * A cycle is a queue of blocks: minutes on a topic fill that topic's first open block, a block's
 * goal is either its minutes or a page understood, and when every block is closed the lap starts
 * again. These specs drive the real backend with only the API, so they lock in what both clients
 * show without depending on either screen.
 */

type Api = { ctx: APIRequestContext; accessToken: string };

const config = (topics: string[], over: Partial<StudyCycleConfig> = {}): StudyCycleConfig => ({
  name: "Concurso",
  defaultMode: "TIME",
  maxBlockMinutes: 90,
  days: everyDay(180),
  topics: topics.map((topicId) => ({ topicId, importance: 3, mastery: 3, minutesOverride: null })),
  ...over,
});

const timeBlock = (topicId: string, plannedMinutes: number, id: string | null = null) => ({
  id, topicId, mode: "TIME" as const, plannedMinutes, goalSource: null, pageId: null, requireQuiz: false, note: null,
});
const goalBlock = (topicId: string, plannedMinutes: number) => ({
  id: null, topicId, mode: "GOAL" as const, plannedMinutes, goalSource: "NEXT" as const, pageId: null, requireQuiz: false, note: null,
});

/** One finished pomodoro of `minutes` on a notebook page, ending now. */
async function pomodoro(api: Api, pageId: string, minutes: number) {
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - minutes * 60_000);
  const response = await recordFocusCycle(api.ctx, api.accessToken, {
    itemGroupId: null, kind: "POMODORO", startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
    minutes, notebookPageId: pageId,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function stranger(): Promise<Api> {
  const user = makeUser();
  const ctx = await newApiContext();
  await registerUser(ctx, user);
  const { accessToken } = await loginUser(ctx, { email: user.email, password: user.password });
  return { ctx, accessToken };
}

test.describe("study cycle rules", () => {
  test("a topic sits in one active cycle until that cycle is archived", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Português");
    const first = await createStudyCycle(api.ctx, api.accessToken, config([topic.id], { name: "Concurso" }));

    const taken = await createStudyCycleRaw(api.ctx, api.accessToken, config([topic.id], { name: "Faculdade" }));
    expect(taken.status()).toBe(400);
    expect((await taken.json()).errorKey).toBe("STUDY_CYCLE_TOPIC_TAKEN");

    expect((await archiveStudyCycle(api.ctx, api.accessToken, first.id)).ok()).toBe(true);
    const second = await createStudyCycleRaw(api.ctx, api.accessToken, config([topic.id], { name: "Faculdade" }));
    expect(second.ok(), await second.text()).toBe(true);
  });

  /** The calculator both clients and the assistant share; the numbers are the canvas example. */
  test("the planner splits the week by weight and interleaves the blocks", async ({ api }) => {
    const titles = ["Const", "Port", "Adm", "RL", "Trab", "Info"];
    const ids: string[] = [];
    for (const title of titles) ids.push((await createNotebookTopic(api.ctx, api.accessToken, title)).id);
    const weights: [number, number][] = [[5, 2], [5, 3], [4, 2], [3, 2], [4, 3], [2, 4]];
    const minutes = [180, 180, 180, 180, 120, 240, 0];

    const plan = await planStudyCycle(api.ctx, api.accessToken, {
      days: everyDay(0).map((day, i) => ({ ...day, minutes: minutes[i] })),
      maxBlockMinutes: 90,
      topics: ids.map((topicId, i) => ({ topicId, importance: weights[i][0], mastery: weights[i][1], minutesOverride: null })),
    });

    expect(plan.weekMinutes).toBe(1080);
    expect(plan.topics.map((t) => t.minutes)).toEqual([275, 205, 220, 165, 165, 55]);
    expect(plan.plannedMinutes).toBe(1085);
    expect(plan.lapDays).toBe(7);
    const name = (topicId: string) => titles[ids.indexOf(topicId)];
    expect(plan.blocks.map((b) => `${name(b.topicId)} ${b.plannedMinutes}`)).toEqual([
      "Const 70", "Adm 75", "Port 70", "RL 85", "Trab 85", "Info 55",
      "Const 70", "Adm 75", "Port 70", "RL 80", "Trab 80",
      "Const 70", "Adm 70", "Port 65",
      "Const 65",
    ]);
  });

  test("a pomodoro fills its topic's first open block, spills into the next, and closes the lap", async ({ api }) => {
    const a = await createNotebookTopic(api.ctx, api.accessToken, "Algorithms");
    const sorting = await addNotebookNode(api.ctx, api.accessToken, a.id, "Sorting");
    const b = await createNotebookTopic(api.ctx, api.accessToken, "Biology");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([a.id, b.id]));
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [timeBlock(a.id, 25), timeBlock(b.id, 25), timeBlock(a.id, 25)]);

    // 40 minutes on a page of the topic: 25 close its first block, 15 go to its next one.
    await pomodoro(api, sorting.pageId!, 40);
    let read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks.map((x) => [x.progress.minutes, x.progress.state])).toEqual([[25, "DONE"], [0, "OPEN"], [15, "OPEN"]]);

    // 30 more: 10 close the second block, and what is left stays on the topic's last block.
    await pomodoro(api, sorting.pageId!, 30);
    read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks.map((x) => [x.progress.minutes, x.progress.state])).toEqual([[25, "DONE"], [0, "OPEN"], [45, "DONE"]]);
    expect(read.lap.number).toBe(1);

    // Closing the last open block closes the lap, and the next one starts empty.
    const today = (await fetchStudyToday(api.ctx, api.accessToken)).date;
    const logged = await logStudySessionRaw(api.ctx, api.accessToken, { topicId: b.id, pageId: null, minutes: 25, studiedOn: today, note: null });
    expect(logged.ok(), await logged.text()).toBe(true);
    read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.lap.number).toBe(2);
    expect(read.previousLaps[0]).toMatchObject({ number: 1, minutes: 95, blocks: 3 });
    expect(read.blocks.every((x) => x.progress.state === "OPEN" && x.progress.minutes === 0)).toBe(true);
  });

  /**
   * A concept block closes when its page is done, however long that took. When its estimate runs
   * out first, the cycle moves on and the topic's next block takes the same concept up.
   */
  test("a concept carries to the topic's next block, which closes as understood when the page is done", async ({ api }) => {
    const c = await createNotebookTopic(api.ctx, api.accessToken, "Constitutional Law");
    const control = await addNotebookNode(api.ctx, api.accessToken, c.id, "Judicial review", 40);
    await addNotebookNode(api.ctx, api.accessToken, c.id, "Amendments", 320);
    const d = await createNotebookTopic(api.ctx, api.accessToken, "Labour Law");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([c.id, d.id], { defaultMode: "GOAL" }));
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [goalBlock(c.id, 20), timeBlock(d.id, 20), goalBlock(c.id, 20)]);

    let read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks[0].progress.target?.id).toBe(control.pageId);
    expect(read.blocks[0].progress.targetPreview).toBe(false);

    // The estimate runs out with the page not done: the turn is used, the concept comes back.
    await pomodoro(api, control.pageId!, 20);
    read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks[0].progress.state).toBe("TURN_USED");
    expect(read.blocks[2].progress.target?.id).toBe(control.pageId);

    // Understood on the page screen, no timer: the block that holds the concept closes.
    await setNotebookStatus(api.ctx, api.accessToken, control.pageId!, "DONE");
    read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks[2].progress.state).toBe("UNDERSTOOD");
    expect(read.blocks[0].progress.state).toBe("TURN_USED");
    expect(read.lap.understood).toBe(1);
  });

  test("a logged session is credited now, and deleting it reopens the block", async ({ api }) => {
    const e = await createNotebookTopic(api.ctx, api.accessToken, "Economics");
    const f = await createNotebookTopic(api.ctx, api.accessToken, "French");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([e.id, f.id]));
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [timeBlock(e.id, 30), timeBlock(f.id, 30)]);
    const today = (await fetchStudyToday(api.ctx, api.accessToken)).date;

    const logged = await logStudySessionRaw(api.ctx, api.accessToken, { topicId: e.id, pageId: null, minutes: 30, studiedOn: today, note: "Recorded class" });
    expect(logged.ok(), await logged.text()).toBe(true);
    const session = await logged.json();
    expect(session.credited).toMatchObject({ cycleId: cycle.id, position: 1, minutesBefore: 0, minutesAfter: 30, state: "DONE" });

    expect((await deleteStudySession(api.ctx, api.accessToken, session.id)).ok()).toBe(true);
    const read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks[0].progress).toMatchObject({ minutes: 0, state: "OPEN" });

    const future = new Date(`${today}T12:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 2);
    const refused = await logStudySessionRaw(api.ctx, api.accessToken, {
      topicId: e.id, pageId: null, minutes: 30, studiedOn: future.toISOString().slice(0, 10), note: null,
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).errorKey).toBe("STUDY_SESSION_DATE");
  });

  test("today's slice fits the day's minutes and follows its start time", async ({ api }) => {
    const g = await createNotebookTopic(api.ctx, api.accessToken, "Geography");
    const h = await createNotebookTopic(api.ctx, api.accessToken, "History");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([g.id, h.id], { days: everyDay(60, "19:00") }));
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [timeBlock(g.id, 40), timeBlock(h.id, 40)]);

    let today = await fetchStudyToday(api.ctx, api.accessToken);
    expect(today.plannedMinutes).toBe(60);
    expect(today.cycles).toHaveLength(1);
    expect(today.cycles[0].entries.map((x) => [x.topic.title, x.minutesToday, x.start, x.end])).toEqual([
      ["Geography", 40, "19:00", "19:40"],
      ["History", 20, "19:40", "20:00"],
    ]);

    // Ten minutes studied today move the clock and shrink what is left of the day.
    const logged = await logStudySessionRaw(api.ctx, api.accessToken, { topicId: g.id, pageId: null, minutes: 10, studiedOn: today.date, note: null });
    expect(logged.ok()).toBe(true);
    today = await fetchStudyToday(api.ctx, api.accessToken);
    expect(today.studiedMinutes).toBe(10);
    expect(today.cycles[0].entries.map((x) => [x.topic.title, x.minutesToday, x.start, x.end])).toEqual([
      ["Geography", 30, "19:10", "19:40"],
      ["History", 20, "19:40", "20:00"],
    ]);

    const history = await fetchStudyHistory(api.ctx, api.accessToken, cycle.id, today.date, today.date);
    expect(history.days[0]).toMatchObject({ date: today.date, plannedMinutes: 60, minutes: 10 });
    expect(history.days[0].entries.map((x) => x.kind)).toEqual(["MANUAL"]);
  });

  /**
   * A cycle rotates between areas, and the areas live inside a topic. A page under a root is a
   * subject of its own, and a pomodoro anywhere below it credits that subject's block, and only it.
   */
  test("a page inside a topic is a subject, and a pomodoro below it credits its block", async ({ api }) => {
    const root = await createNotebookTopic(api.ctx, api.accessToken, "Software Engineering");
    const implementation = await addNotebookNode(api.ctx, api.accessToken, root.id, "Implementation", 40);
    const product = await addNotebookNode(api.ctx, api.accessToken, root.id, "Product", 320);
    const architecture = await addNotebookNode(api.ctx, api.accessToken, root.id, "Architecture", 600);
    const testing = await addNotebookNode(api.ctx, api.accessToken, implementation.pageId!, "Testing");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([implementation.pageId!, product.pageId!]));
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [timeBlock(implementation.pageId!, 25), timeBlock(product.pageId!, 25)]);

    let read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks[0].topic).toMatchObject({ title: "Implementation", rootTitle: "Software Engineering" });

    // A grandchild page credits the area it lives in.
    await pomodoro(api, testing.pageId!, 25);
    // A page of the same root outside every subject credits nothing.
    await pomodoro(api, architecture.pageId!, 25);
    read = await fetchStudyCycle(api.ctx, api.accessToken, cycle.id);
    expect(read.blocks.map((x) => [x.topic.title, x.progress.minutes, x.progress.state])).toEqual([
      ["Implementation", 25, "DONE"],
      ["Product", 0, "OPEN"],
    ]);
  });

  /** Overlapping subjects would make one pomodoro credit two blocks, so they are refused. */
  test("subjects never overlap, within a cycle or across cycles", async ({ api }) => {
    const root = await createNotebookTopic(api.ctx, api.accessToken, "Software Engineering");
    const child = await addNotebookNode(api.ctx, api.accessToken, root.id, "Implementation");
    await createStudyCycle(api.ctx, api.accessToken, config([child.pageId!], { name: "Areas" }));

    const ancestor = await createStudyCycleRaw(api.ctx, api.accessToken, config([root.id], { name: "Whole topic" }));
    expect(ancestor.status()).toBe(400);
    expect((await ancestor.json()).errorKey).toBe("STUDY_CYCLE_TOPIC_TAKEN");

    const other = await createNotebookTopic(api.ctx, api.accessToken, "Spanish");
    const otherChild = await addNotebookNode(api.ctx, api.accessToken, other.id, "Grammar");
    const both = await createStudyCycleRaw(api.ctx, api.accessToken, config([other.id, otherChild.pageId!], { name: "Spanish" }));
    expect(both.status()).toBe(400);
    expect((await both.json()).errorKey).toBe("STUDY_CYCLE_TOPIC_OVERLAP");
  });

  test("somebody else's cycle answers STUDY_CYCLE_NOT_OWNED, and their topics cannot join yours", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Private study");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, config([topic.id]));
    const other = await stranger();

    const read = await fetchStudyCycleRaw(other.ctx, other.accessToken, cycle.id);
    expect(read.status()).toBe(400);
    expect((await read.json()).errorKey).toBe("STUDY_CYCLE_NOT_OWNED");

    const borrowed = await createStudyCycleRaw(other.ctx, other.accessToken, config([topic.id]));
    expect(borrowed.status()).toBe(400);
    expect((await borrowed.json()).errorKey).toBe("NOTEBOOK_PAGE_NOT_OWNED");
    await other.ctx.dispose();
  });
});
