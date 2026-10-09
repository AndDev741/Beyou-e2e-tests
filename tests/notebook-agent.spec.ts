import { test, expect } from "../fixtures/auth";
import {
  addNotebookNode,
  appendNotebookNotes,
  createNotebookTopic,
  fetchNotebookPage,
  renameNotebookPage,
  saveNotebookBlocks,
} from "../support/apiClient";

/**
 * The assistant changes a notebook page while the person has it open.
 *
 * There is no model in the e2e stack, so the turn is played back: the stream is intercepted, the
 * changes the board tools make are written through the same REST endpoints while the "turn" runs,
 * and the stream answers with the tool event the backend would send. What is under test is the
 * client side of the contract: a tool that reports the notebook domain makes the screen re-read
 * the page, its board and its tree, and the open editor picks up the notes instead of saving over
 * them on its next autosave.
 */

/** One assistant turn as the backend streams it: a notebook tool, then the answer. */
function playedTurn(tool: string, answer: string): string {
  const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event("tool", { tool, status: "started" }),
    event("tool", { tool, status: "finished", domains: ["notebook"] }),
    event("token", { text: answer }),
    event("done", {
      segments: [
        { type: "tool", tool, domains: ["notebook"] },
        { type: "text", text: answer },
      ],
    }),
  ].join("");
}

const editor = '[data-testid="notebook-editor"] [contenteditable="true"]';

test.describe("the assistant and an open notebook page", () => {
  test("an open page shows the assistant's changes, and the editor keeps the notes it added", async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Fundamentos");
    await saveNotebookBlocks(api.ctx, api.accessToken, topic.id, [{ type: "roadmapBoard" }, { type: "paragraph" }]);
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Redes");

    await page.goto(`/notebook/${topic.id}`);
    await expect(page.getByTestId("board-node").filter({ hasText: "Redes" })).toBeVisible();

    await page.route("**/ai/agent/chats/*/stream", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // What editStudyNode and addStudyNotes write on the server while the turn runs.
      await renameNotebookPage(api.ctx, api.accessToken, node.pageId, "Redes de Computadores");
      await renameNotebookPage(api.ctx, api.accessToken, topic.id, "Fundamentos da Computação");
      await appendNotebookNotes(api.ctx, api.accessToken, topic.id, "## Camadas do modelo OSI\n\n- Física\n- Enlace");
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: playedTurn("editStudyNode", "Pronto."),
      });
    });

    await test.step("ask the assistant", async () => {
      await page.getByRole("button", { name: "Open assistant" }).click();
      await page.getByPlaceholder("Message your assistant...").fill("rename Redes and add notes about OSI");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText("Node updated")).toBeVisible();
    });

    await test.step("the board, the tree, the title and the editor show the change without a reload", async () => {
      await expect(page.getByTestId("board-node").filter({ hasText: "Redes de Computadores" })).toBeVisible();
      await expect(page.getByTestId("tree-item").filter({ hasText: "Redes de Computadores" })).toBeVisible();
      await expect(page.getByTestId("page-title")).toHaveValue("Fundamentos da Computação");
      await expect(page.getByTestId("notebook-editor")).toContainText("Camadas do modelo OSI");
    });

    await test.step("typing afterwards keeps the assistant's notes on the server", async () => {
      await page.getByRole("button", { name: "Close assistant" }).click();
      // Into the last line the assistant wrote: the top of the document is the board's canvas.
      await page.getByTestId("notebook-editor").getByText("Enlace").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Revisar amanhã.");

      // "Saved" can already be on screen: the merge brought the page level with the server. What
      // counts is what the server holds once the typing is saved.
      await expect.poll(async () => (await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json()).content,
        { timeout: 15_000 }).toContain("Revisar amanhã.");
      const stored = await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json();
      expect(stored.content).toContain("Camadas do modelo OSI");
    });
  });

  test("notes written on a page are there when you come back to it inside the app", async ({ authedPage: page, api }) => {
    test.setTimeout(60_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Algoritmos");
    await saveNotebookBlocks(api.ctx, api.accessToken, topic.id, [{ type: "roadmapBoard" }, { type: "paragraph" }]);
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Grafos");

    await page.goto(`/notebook/${node.pageId}`);
    await page.locator(editor).first().click();
    await page.keyboard.type("Dijkstra não aceita pesos negativos.");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

    // Away and back inside the app: the screen stays mounted and the page comes from the store.
    await page.getByRole("link", { name: "Algoritmos" }).first().click();
    await expect(page.getByTestId("page-title")).toHaveValue("Algoritmos");
    await page.getByTestId("tree-item").filter({ hasText: "Grafos" }).click();
    await expect(page.getByTestId("page-title")).toHaveValue("Grafos");

    await expect(page.getByTestId("notebook-editor")).toContainText("Dijkstra não aceita pesos negativos.");
  });
});
