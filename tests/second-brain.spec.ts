import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import { makeUser } from "../support/testData";
import {
  createSecondBrainFact,
  deleteSecondBrainFact,
  exportUserData,
  fetchSecondBrain,
  loginUser,
  postSecondBrainAnswer,
  postSecondBrainFact,
  putSecondBrainFact,
  refillSecondBrainQuestions,
  registerUser,
  setSecondBrainSource,
} from "../support/apiClient";

/**
 * Second Brain: the page that says whether a person is on course or drifting, asks them
 * questions, and keeps the short profile every assistant chat reads.
 *
 * Why this file exists: the profile rides on every assistant message, so who may write it and
 * how large it may grow are server rules worth pinning on the wire. The starter questions, the
 * source switches and "a starter answer becomes a profile line" hold with no model in the
 * stack, which is how this suite runs, so they are checked here against the real endpoints.
 * What the model writes (the overview, the follow-ups) is covered by the backend's own tests.
 */

/** The server's caps, mirrored from `@beyou/types/secondBrain`. */
const FACT_LIMIT = 20;
const FACT_TEXT_MAX = 200;

async function stranger(ctx: APIRequestContext): Promise<string> {
  const user = makeUser();
  await registerUser(ctx, user);
  const { accessToken } = await loginUser(ctx, { email: user.email, password: user.password });
  return accessToken;
}

test.describe("second brain API", () => {
  test("a new account reads the whole page in one call, with the documented shape and defaults", async ({ api }) => {
    const page = await fetchSecondBrain(api.ctx, api.accessToken);

    // The contract snapshot in the frontend was edited by hand for these routes. This is the
    // assertion that reads the fields off the real endpoint.
    expect(Object.keys(page).sort()).toEqual(
      ["aiAvailable", "areas", "facts", "goalsAhead", "insight", "memory", "oldNote", "questions", "routine", "sources"].sort(),
    );
    expect(page.insight).toEqual({ text: null, verdict: null, generatedAt: null, stale: true });
    expect(page.facts).toEqual([]);
    expect(page.questions).toEqual([]);
    // Readable memory (second-brain-memory.spec.ts): nothing kept yet, and no old hidden note.
    expect(page.memory).toEqual([]);
    expect(page.oldNote).toEqual([]);
    expect(typeof page.aiAvailable).toBe("boolean");
    // What a person has not chosen yet: their own activity is read, their writing is not.
    expect(page.sources).toEqual([
      { source: "ROUTINES", enabled: true },
      { source: "GOALS", enabled: true },
      { source: "MOOD", enabled: true },
      { source: "CALENDAR", enabled: false },
      { source: "NOTEBOOK", enabled: false },
      { source: "IDEAS", enabled: false },
    ]);
  });

  test("an empty profile is asked the three starter questions once, however often the page asks", async ({ api }) => {
    const first = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    const starters = first.filter((question) => question.kind.startsWith("PROFILE_")).map((question) => question.kind);
    expect(starters.sort()).toEqual(["PROFILE_ABOUT", "PROFILE_LIKES", "PROFILE_OBJECTIVES"]);

    // The page asks on every visit. A second ask must not seed them again.
    const second = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    expect(second.filter((question) => question.kind.startsWith("PROFILE_"))).toHaveLength(3);
    expect(second.length).toBeLessThanOrEqual(5);
  });

  test("a starter answer becomes a profile line, and the question cannot be answered twice", async ({ api }) => {
    const questions = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    const objectives = questions.find((question) => question.kind === "PROFILE_OBJECTIVES")!;

    const answered = await postSecondBrainAnswer(api.ctx, api.accessToken, objectives.id, "Run a half marathon by June");
    expect(answered.status()).toBe(200);
    const result = await answered.json();
    expect(result.question.status).toBe("ANSWERED");
    // With no model the answer itself is the line. With one it is split, still into objectives.
    expect(result.learned.length).toBeGreaterThanOrEqual(1);
    for (const fact of result.learned) {
      expect(fact.kind).toBe("OBJECTIVE");
      expect(fact.origin).toBe("ANSWER");
    }

    const page = await fetchSecondBrain(api.ctx, api.accessToken);
    expect(page.facts.map((fact) => fact.id)).toEqual(result.learned.map((fact: { id: string }) => fact.id));
    expect(page.questions.map((question) => question.id)).not.toContain(objectives.id);

    const again = await postSecondBrainAnswer(api.ctx, api.accessToken, objectives.id, "Something else");
    expect(again.status()).toBe(409);
    expect((await again.json()).errorKey).toBe("SECOND_BRAIN_QUESTION_CLOSED");
  });

  test("nobody reads, edits, deletes or answers into someone else's profile", async ({ api }) => {
    const mine = await createSecondBrainFact(api.ctx, api.accessToken, { kind: "ABOUT", text: "Lives with two cats" });
    const [question] = await refillSecondBrainQuestions(api.ctx, api.accessToken);
    const other = await stranger(api.ctx);

    expect((await fetchSecondBrain(api.ctx, other)).facts).toEqual([]);

    // A fact that is not yours reads exactly like one that does not exist.
    const edit = await putSecondBrainFact(api.ctx, other, mine.id, { kind: "ABOUT", text: "Hijacked" });
    expect(edit.status()).toBe(404);
    expect((await edit.json()).errorKey).toBe("SECOND_BRAIN_FACT_NOT_FOUND");
    expect((await deleteSecondBrainFact(api.ctx, other, mine.id)).status()).toBe(404);

    const answer = await postSecondBrainAnswer(api.ctx, other, question.id, "Not mine to answer");
    expect(answer.status()).toBe(404);
    expect((await answer.json()).errorKey).toBe("SECOND_BRAIN_QUESTION_NOT_FOUND");

    expect((await fetchSecondBrain(api.ctx, api.accessToken)).facts.map((fact) => fact.text)).toEqual([
      "Lives with two cats",
    ]);
  });

  test("the profile stops at its limit, and a line stops at its length", async ({ api }) => {
    // Every line travels with every assistant message, so the caps are a cost ceiling.
    for (let i = 0; i < FACT_LIMIT; i++) {
      await createSecondBrainFact(api.ctx, api.accessToken, { kind: "LIKE", text: `Thing ${i}` });
    }
    const full = await postSecondBrainFact(api.ctx, api.accessToken, { kind: "LIKE", text: "One too many" });
    expect(full.status()).toBe(409);
    expect((await full.json()).errorKey).toBe("SECOND_BRAIN_FACT_LIMIT_REACHED");

    const other = await stranger(api.ctx);
    const long = await postSecondBrainFact(api.ctx, other, { kind: "ABOUT", text: "x".repeat(FACT_TEXT_MAX + 1) });
    expect(long.status()).toBe(400);
    const exact = await postSecondBrainFact(api.ctx, other, { kind: "ABOUT", text: "x".repeat(FACT_TEXT_MAX) });
    expect(exact.status()).toBe(201);
  });

  test("a source switched off stops feeding its blocks, and the export says what was allowed", async ({ api }) => {
    expect((await fetchSecondBrain(api.ctx, api.accessToken)).routine).not.toBeNull();

    expect((await setSecondBrainSource(api.ctx, api.accessToken, "ROUTINES", false)).status()).toBe(200);
    const off = await fetchSecondBrain(api.ctx, api.accessToken);
    expect(off.routine).toBeNull();
    expect(off.areas).toEqual([]);

    // There is no diary switch: the diary is never a source.
    const diary = await setSecondBrainSource(api.ctx, api.accessToken, "JOURNAL", true);
    expect(diary.status()).toBe(400);

    await createSecondBrainFact(api.ctx, api.accessToken, { kind: "OBJECTIVE", text: "Read twelve books" });
    const exported = (await exportUserData(api.ctx, api.accessToken)).secondBrain as {
      facts: { text: string }[];
      sources: { source: string; enabled: boolean }[];
    };
    expect(exported.facts.map((fact) => fact.text)).toEqual(["Read twelve books"]);
    expect(exported.sources.find((item) => item.source === "ROUTINES")).toEqual({ source: "ROUTINES", enabled: false });
  });
});

test.describe("second brain page", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("an answer typed on the page lands in the profile and survives a reload", async ({ authedPage, api }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));

    await authedPage.goto("/second-brain");
    // The page asks the server for questions on arrival. Nothing was seeded through the API.
    const input = authedPage.getByTestId("second-brain-answer-input");
    await expect(input).toBeVisible();
    await input.fill("Pass the visa interview");
    await authedPage.getByTestId("second-brain-answer-send").click();

    await expect(authedPage.getByTestId("second-brain-answer-result")).toBeVisible();
    await expect
      .poll(async () => (await fetchSecondBrain(api.ctx, api.accessToken)).facts.length)
      .toBeGreaterThanOrEqual(1);
    const [fact] = (await fetchSecondBrain(api.ctx, api.accessToken)).facts;
    await expect(authedPage.getByTestId("second-brain-profile").getByText(fact.text)).toBeVisible();

    await authedPage.reload();
    await expect(authedPage.getByTestId("second-brain-profile").getByText(fact.text)).toBeVisible();
    await expect(authedPage.getByTestId("second-brain-fact-count")).toHaveText(
      `${(await fetchSecondBrain(api.ctx, api.accessToken)).facts.length}/${FACT_LIMIT}`,
    );
    expect(errors).toEqual([]);
  });

  test("a line can be added, edited and removed by hand", async ({ authedPage, api }) => {
    await authedPage.goto("/second-brain");
    const about = authedPage.getByTestId("second-brain-facts-ABOUT");

    await authedPage.getByTestId("second-brain-fact-add-ABOUT").click();
    await authedPage.getByTestId("second-brain-fact-input").fill("Two kids");
    await authedPage.getByTestId("second-brain-fact-input").press("Enter");
    await expect(about.getByTestId("second-brain-fact")).toHaveText(/Two kids/);

    await about.getByTestId("second-brain-fact").hover();
    await about.getByRole("button", { name: /edit|editar/i }).click();
    await authedPage.getByTestId("second-brain-fact-input").fill("Two kids and a dog");
    await authedPage.getByTestId("second-brain-fact-input").press("Enter");
    await expect(about.getByTestId("second-brain-fact")).toHaveText(/Two kids and a dog/);
    await expect
      .poll(async () => (await fetchSecondBrain(api.ctx, api.accessToken)).facts.map((fact) => [fact.kind, fact.text, fact.origin]))
      .toEqual([["ABOUT", "Two kids and a dog", "USER"]]);

    await about.getByTestId("second-brain-fact").hover();
    await about.getByRole("button", { name: /delete|deletar/i }).click();
    await expect(about.getByTestId("second-brain-fact")).toHaveCount(0);
    await expect.poll(async () => (await fetchSecondBrain(api.ctx, api.accessToken)).facts).toEqual([]);
  });

  test("a switch flipped on the page is the server's switch, and stays flipped", async ({ authedPage, api }) => {
    await authedPage.goto("/second-brain");
    const calendar = authedPage.getByTestId("second-brain-source-CALENDAR");
    await expect(calendar).toHaveAttribute("aria-checked", "false");

    await calendar.click();
    await expect(calendar).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await fetchSecondBrain(api.ctx, api.accessToken)).sources.find((item) => item.source === "CALENDAR")?.enabled)
      .toBe(true);

    await authedPage.reload();
    await expect(authedPage.getByTestId("second-brain-source-CALENDAR")).toHaveAttribute("aria-checked", "true");
  });

  test("the page is reachable from the sidebar", async ({ authedPage }) => {
    await authedPage.goto("/dashboard");
    await authedPage.locator('aside a[href="/second-brain"]').click();
    await expect(authedPage).toHaveURL(/\/second-brain$/);
    await expect(authedPage.getByTestId("second-brain-page")).toBeVisible();
  });
});

test.describe("second brain page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the questions come second, right under the overview", async ({ authedPage }) => {
    await authedPage.goto("/second-brain");
    await expect(authedPage.getByTestId("second-brain-questions")).toBeVisible();

    const top = async (testId: string) => (await authedPage.getByTestId(testId).boundingBox())!.y;
    const overview = await top("second-brain-overview");
    const questions = await top("second-brain-questions");
    const goals = await top("second-brain-goals");
    // The block that needs the person must not sit fifth, under three blocks of reading.
    expect(overview).toBeLessThan(questions);
    expect(questions).toBeLessThan(goals);
  });
});
