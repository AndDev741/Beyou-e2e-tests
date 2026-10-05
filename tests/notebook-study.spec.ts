import { test, expect } from "../fixtures/auth";
import {
  addNotebookNode,
  createNotebookCard,
  createNotebookTopic,
  fetchDueCards,
  fetchNotebookBoard,
  fetchNotebookDrafts,
  fetchNotebookPage,
  saveNotebookContent,
} from "../support/apiClient";

/**
 * Reviewing cards, and the study AI with ONLY the model calls stubbed.
 *
 * Like the AI onboarding spec, the stub sits on the AI routes alone. Creating the drafted topic,
 * saving an answer to a page and every review run against the real backend, so a green run
 * proves the screens and the server agree, not just that the screens render a fixture.
 *
 * A roadmap draft is written by the model in the background, so there is no browser request to
 * stub for the model itself. The draft is stored, listed, deleted and turned into a topic by the
 * real backend; only reading it back is rewritten to carry DRAFTED, as if the model had answered.
 */

const DRAFTED = {
  totalHours: 36,
  nodes: [
    { title: "Discrete Math", why: "Proofs and counting.", subtopics: ["Logic", "Sets"], estimatedHours: 18,
      optional: false, existingPageId: null, existingTopicTitle: null, existingProgress: null },
    { title: "Computer Architecture", why: "How code becomes fast or slow.", subtopics: ["Caches"], estimatedHours: 18,
      optional: false, existingPageId: null, existingTopicTitle: null, existingProgress: null },
    { title: "Compilers", why: "Optional for a backend path.", subtopics: [], estimatedHours: 18,
      optional: true, existingPageId: null, existingTopicTitle: null, existingProgress: null },
  ],
};

/** Reads of a stored draft come back READY with DRAFTED; everything else reaches the backend. */
async function modelAnswersWithTheDraft(page: import("@playwright/test").Page) {
  await page.route("**/notebook/drafts/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const stored = await (await route.fetch()).json();
    await route.fulfill({ json: { ...stored, status: "READY", errorKey: null, result: DRAFTED } });
  });
}
test.describe("study notebook: review and AI", () => {
  test("a review session schedules every card and pays at the end", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Data Structures");
    const trees = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Trees");
    await createNotebookCard(api.ctx, api.accessToken, trees.pageId!, "Where is the smallest key in a min-heap?", "At the root.");
    await createNotebookCard(api.ctx, api.accessToken, trees.pageId!, "What replaces a deleted node with two children?", "Its in-order successor.");

    await page.goto("/notebook/review");
    for (let i = 0; i < 2; i++) {
      await page.getByTestId("review-show").click();
      await expect(page.getByTestId("review-answer")).toBeVisible();
      await page.getByTestId("review-rate-GOOD").click();
    }

    await expect(page.getByTestId("review-summary")).toContainText("+2 XP");
    expect((await fetchDueCards(api.ctx, api.accessToken)).total).toBe(0);
  });

  test("a drafted roadmap is reviewed in the dialog and created for real", async ({ authedPage: page, api }) => {
    await modelAnswersWithTheDraft(page);

    await page.goto("/notebook");
    await page.getByTestId("notebook-create-ai").click();
    // The dialog's content once set its own width, 2px wider than the bordered panel at
    // 1080px, and the panel showed a horizontal scrollbar for those 2px.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await page.getByTestId("ai-topic-what").fill("Fundamentals of Computer Science");
    await page.getByTestId("ai-topic-draft").click();
    // The stored draft answers DRAFTING at once; until the first read back, the panel says what
    // it is drafting and counts the time.
    await expect(page.getByTestId("ai-draft-waiting")).toContainText("Fundamentals of Computer Science");
    // Scoped to the dialog: the new draft's card on the home behind it has a timer too.
    await expect(page.getByTestId("ai-draft-waiting").getByTestId("ai-waiting-elapsed")).toHaveText(/^0:0\d$/);
    await expect(page.getByTestId("ai-draft-node")).toHaveCount(3);
    await expect(page.getByTestId("ai-draft-waiting")).toHaveCount(0);
    // The optional node starts left out, so two are created.
    await page.getByTestId("ai-topic-create").click();

    await expect(page.getByTestId("page-title")).toHaveValue("Fundamentals of Computer Science");
    await expect(page.getByTestId("board-node")).toHaveCount(2);
    // Creating the topic ended the draft on the server.
    expect(await fetchNotebookDrafts(api.ctx, api.accessToken)).toEqual([]);
    await expect(page.getByTestId("board-node").filter({ hasText: "Discrete Math" })).toBeVisible();

    // The server lays a draft out on the grid "Tidy up" uses, so tidying it moves nothing.
    const topicId = page.url().split("/notebook/")[1];
    const layout = async () =>
      (await fetchNotebookBoard(api.ctx, api.accessToken, topicId)).nodes.map((n) => `${n.title}@${n.x},${n.y}`);
    const drafted = await layout();
    const saved = page.waitForResponse((r) => r.url().endsWith("/board/layout") && r.request().method() === "PUT");
    await page.getByTestId("board-tidy").click();
    await saved;
    expect(await layout()).toEqual(drafted);

    // The drafted subtopics became the node's own board.
    await page.getByTestId("board-node").filter({ hasText: "Discrete Math" }).dblclick();
    await expect(page.getByTestId("board-node").filter({ hasText: "Logic" })).toBeVisible();
  });

  /**
   * Reported in local testing: a finished draft was lost to a click outside the dialog. The
   * draft is stored the moment "Draft" is clicked, waits on the home, opens back as it was, and
   * goes only when the person deletes it.
   */
  test("a draft closed by a click outside waits on the home, reopens as it was, and can be deleted", async ({ authedPage: page, api }) => {
    await modelAnswersWithTheDraft(page);
    await page.goto("/notebook");
    await page.getByTestId("notebook-create-ai").click();
    await page.getByTestId("ai-topic-what").fill("Spanish B1");
    await page.getByTestId("ai-topic-draft").click();
    await expect(page.getByTestId("ai-draft-waiting")).toBeVisible();

    // The click that used to throw the draft away.
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("ai-topic-dialog")).toHaveCount(0);

    const card = page.getByTestId("draft-card").filter({ hasText: "Spanish B1" });
    await expect(card).toBeVisible();
    await card.getByTestId("draft-open").click();
    await expect(page.getByTestId("ai-topic-what")).toHaveValue("Spanish B1");
    await expect(page.getByTestId("ai-draft-node")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-topic-dialog")).toHaveCount(0);

    await card.getByTestId("draft-delete").click();
    await page.getByTestId("draft-delete-confirm").click();
    await expect(page.getByTestId("draft-card")).toHaveCount(0);
    expect(await fetchNotebookDrafts(api.ctx, api.accessToken)).toEqual([]);
  });

  test("a study-room answer shows its citation and saves to the page", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Data Structures");
    const trees = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Trees");
    await saveNotebookContent(api.ctx, api.accessToken, trees.pageId!, ["Delete with two children: use the in-order successor."]);

    await page.route("**/notebook/ai/pages/*/chat", (route) =>
      route.fulfill({
        json: {
          question: { id: "q1", role: "USER", content: "Why the successor?", citations: [], createdAt: "2026-10-04T10:00:00Z" },
          answer: {
            id: "a1",
            role: "ASSISTANT",
            content: "It is the smallest key larger than the one removed [1].",
            citations: [{ n: 1, kind: "PAGE", sourceId: null, chunkId: null, pageId: trees.pageId, title: 'Your page "Trees"',
              pageNumber: null, excerpt: "Delete with two children: use the in-order successor." }],
            createdAt: "2026-10-04T10:00:01Z",
          },
        },
      }),
    );

    await page.goto(`/notebook/${trees.pageId}/study`);
    await expect(page.getByTestId("study-room")).toBeVisible();
    await page.getByTestId("study-chat-input").fill("Why the successor?");
    await page.getByTestId("study-chat-send").click();

    const answer = page.getByTestId("study-answer").last();
    await expect(answer).toContainText("smallest key larger");
    await answer.getByTestId("citation-1").click();
    await expect(page.getByTestId("citation-panel")).toContainText("Delete with two children");

    await answer.getByTestId("study-save-to-page").click();
    await expect
      .poll(async () => (await (await fetchNotebookPage(api.ctx, api.accessToken, trees.pageId!)).json()).content as string)
      .toContain("It is the smallest key larger than the one removed.");
  });
});
