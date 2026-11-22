import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import { makeUser } from "../support/testData";
import {
  clearAllAgentChats,
  createCategory,
  createHabit,
  deleteHabit,
  deleteSecondBrainNote,
  exportUserData,
  fetchSecondBrain,
  loginUser,
  postSecondBrainAnswer,
  putSecondBrainNote,
  refillSecondBrainQuestions,
  registerUser,
  type SecondBrainAnswerResult,
  type SecondBrainMemorySubjectRow,
  type SecondBrainPage,
} from "../support/apiClient";

/**
 * Second Brain memory: notes tied to the habit, goal, routine or category they are about,
 * which the person reads, corrects and deletes on the page.
 *
 * Why this file exists: the notes are data about a person that the assistant and the page
 * write for them, so who may change them, where they go when their thing is deleted, and
 * that "clear all conversations" no longer erases them are rules worth pinning on the wire.
 * The suite runs with no model, which is the path where an answer to a new-thing question is
 * kept as written, as one note on that thing. What the model files out of an answer is the
 * backend's own tests' job.
 */

type Api = { ctx: APIRequestContext; accessToken: string };

async function stranger(ctx: APIRequestContext): Promise<string> {
  const user = makeUser();
  await registerUser(ctx, user);
  const { accessToken } = await loginUser(ctx, { email: user.email, password: user.password });
  return accessToken;
}

async function category(api: Api, name: string): Promise<string> {
  const { id } = await createCategory(api.ctx, api.accessToken, {
    name,
    icon: "icon:fa-heart-pulse",
    description: "Seeded for E2E",
    experience: "BEGINNER",
  });
  return id;
}

async function habit(api: Api, name: string, categoryId: string): Promise<string> {
  const { id } = await createHabit(api.ctx, api.accessToken, {
    name,
    iconId: "icon:fa-dumbbell",
    importance: 3,
    dificulty: 3,
    categoriesId: [categoryId],
    experience: "BEGINNER",
  });
  return id;
}

function subjects(page: SecondBrainPage): SecondBrainMemorySubjectRow[] {
  return page.memory.flatMap((group) => group.subjects);
}

/**
 * The F1 flow up to its first note: the account has opened Second Brain, then starts a gym
 * habit, gets asked about it, and answers.
 */
async function gymNote(api: Api) {
  const healthId = await category(api, "Health");
  await refillSecondBrainQuestions(api.ctx, api.accessToken);
  const habitId = await habit(api, "Gym", healthId);
  const asked = (await refillSecondBrainQuestions(api.ctx, api.accessToken)).filter(
    (question) => question.kind === "NEW_THING",
  );
  expect(asked).toHaveLength(1);
  const response = await postSecondBrainAnswer(
    api.ctx,
    api.accessToken,
    asked[0].id,
    "I want more energy for work. Rain is what usually stops me.",
  );
  expect(response.status()).toBe(200);
  const result = (await response.json()) as SecondBrainAnswerResult;
  return { healthId, habitId, question: asked[0], result };
}

test.describe("second brain memory API", () => {
  test("a habit created after the first visit is asked about once, and the answer becomes its note", async ({ api }) => {
    const healthId = await category(api, "Health");
    // Before the page was ever opened: nothing is asked about it.
    await habit(api, "Walk the dog", healthId);
    const firstVisit = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    expect(firstVisit.filter((question) => question.kind === "NEW_THING")).toEqual([]);

    await habit(api, "Gym", healthId);
    const asked = (await refillSecondBrainQuestions(api.ctx, api.accessToken)).filter(
      (question) => question.kind === "NEW_THING",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0].text).toContain('"Gym"');
    // Asking again writes nothing new.
    const again = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    expect(again.filter((question) => question.kind === "NEW_THING").map((question) => question.id)).toEqual([
      asked[0].id,
    ]);

    const answer = "I want more energy for work. Rain is what usually stops me.";
    const response = await postSecondBrainAnswer(api.ctx, api.accessToken, asked[0].id, answer);
    expect(response.status()).toBe(200);
    const result = (await response.json()) as SecondBrainAnswerResult;
    expect(result.notes.map((note) => [note.subjectName, note.text, note.origin])).toEqual([["Gym", answer, "ANSWER"]]);

    const page = await fetchSecondBrain(api.ctx, api.accessToken);
    expect(page.memory.map((group) => group.categoryName)).toEqual(["Health"]);
    expect(page.memory[0].categoryId).toBe(healthId);
    const [gym] = page.memory[0].subjects;
    expect(gym.type).toBe("HABIT");
    expect(gym.name).toBe("Gym");
    expect(gym.formerType).toBeNull();
    expect(gym.notes.map((note) => note.text)).toEqual([answer]);
    // No hidden note was ever written for this account, so there is nothing to review.
    expect(page.oldNote).toEqual([]);
  });

  test("only the owner corrects or deletes a note", async ({ api }) => {
    const { result } = await gymNote(api);
    const [note] = result.notes;
    const other = await stranger(api.ctx);

    expect((await putSecondBrainNote(api.ctx, other, note.id, "Not yours")).status()).toBe(404);
    expect((await deleteSecondBrainNote(api.ctx, other, note.id)).status()).toBe(404);

    const edited = await putSecondBrainNote(api.ctx, api.accessToken, note.id, "Energy for work. Rain stops me.");
    expect(edited.status()).toBe(200);
    // Editing keeps where the note came from, as editing a profile line does.
    expect(await edited.json()).toMatchObject({ id: note.id, text: "Energy for work. Rain stops me.", origin: "ANSWER" });
    expect((await putSecondBrainNote(api.ctx, api.accessToken, note.id, "x".repeat(501))).status()).toBe(400);

    expect((await deleteSecondBrainNote(api.ctx, api.accessToken, note.id)).status()).toBe(204);
    expect((await fetchSecondBrain(api.ctx, api.accessToken)).memory).toEqual([]);
    expect((await deleteSecondBrainNote(api.ctx, api.accessToken, note.id)).status()).toBe(404);
  });

  test("deleting the habit hands its notes to its category, name kept", async ({ api }) => {
    const { healthId, habitId, result } = await gymNote(api);
    const swimId = await habit(api, "Swim", healthId);
    const open = (await refillSecondBrainQuestions(api.ctx, api.accessToken)).filter(
      (question) => question.kind === "NEW_THING",
    );
    expect(open.map((question) => question.text).join(" ")).toContain('"Swim"');

    await deleteHabit(api.ctx, api.accessToken, habitId);
    await deleteHabit(api.ctx, api.accessToken, swimId);

    const page = await fetchSecondBrain(api.ctx, api.accessToken);
    expect(page.memory.map((group) => group.categoryId)).toEqual([healthId]);
    const moved = subjects(page);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ type: "CATEGORY", id: healthId, name: "Gym", formerType: "HABIT" });
    expect(moved[0].notes.map((note) => note.text)).toEqual([result.notes[0].text]);
    // A question about a thing that is gone has nothing left to ask about.
    expect(page.questions.filter((question) => question.kind === "NEW_THING")).toEqual([]);
  });

  test("clearing every conversation leaves the notes, and the export carries them", async ({ api }) => {
    const { result } = await gymNote(api);

    expect((await clearAllAgentChats(api.ctx, api.accessToken)).ok()).toBe(true);
    expect(subjects(await fetchSecondBrain(api.ctx, api.accessToken)).flatMap((s) => s.notes.map((n) => n.id))).toEqual([
      result.notes[0].id,
    ]);

    const exported = (await exportUserData(api.ctx, api.accessToken)).secondBrain as {
      notes: { subjectType: string; subjectName: string; text: string; origin: string }[];
    };
    expect(exported.notes).toEqual([
      expect.objectContaining({ subjectType: "HABIT", subjectName: "Gym", text: result.notes[0].text, origin: "ANSWER" }),
    ]);
  });
});

test.describe("second brain memory page", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a note shows under its category and can be corrected and deleted on the page", async ({ authedPage, api }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));
    const { result } = await gymNote(api);

    await authedPage.goto("/second-brain");
    const memory = authedPage.getByTestId("second-brain-memory");
    const group = memory.getByTestId("second-brain-memory-group");
    await expect(group).toHaveCount(1);
    await expect(group).toContainText("Health");
    await expect(group.getByTestId("second-brain-memory-subject")).toContainText("Gym");
    const note = group.getByTestId("second-brain-note");
    await expect(note).toContainText(result.notes[0].text);

    await note.hover();
    await note.getByRole("button", { name: /edit|editar/i }).click();
    await authedPage.getByTestId("second-brain-note-input").fill("Energy for work");
    await authedPage.getByTestId("second-brain-note-input").press("Enter");
    await expect(note).toContainText("Energy for work");
    await expect
      .poll(async () => subjects(await fetchSecondBrain(api.ctx, api.accessToken))[0]?.notes.map((n) => [n.text, n.origin]))
      .toEqual([["Energy for work", "ANSWER"]]);

    await note.hover();
    await note.getByRole("button", { name: /delete|excluir|deletar/i }).click();
    await expect(memory.getByTestId("second-brain-note")).toHaveCount(0);
    await expect.poll(async () => (await fetchSecondBrain(api.ctx, api.accessToken)).memory).toEqual([]);

    await authedPage.reload();
    await expect(authedPage.getByTestId("second-brain-memory").getByTestId("second-brain-note")).toHaveCount(0);
    // No hidden note for a new account: the review block stays away.
    await expect(authedPage.getByTestId("second-brain-old-note")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
