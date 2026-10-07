import { test, expect } from "../fixtures/auth";
import { addNotebookNode, createNotebookTopic, fetchNotebookPage } from "../support/apiClient";

/**
 * The study notebook through the UI: topic, board, node page, notes, status.
 *
 * Every step drives the screen and then checks the server, because the point is that the
 * screens send the right thing: the board's node is a real child page, the editor's autosave
 * reaches the page's text, and a status set on the page moves the topic above it.
 */
test.describe("study notebook", () => {
  test("a topic gets a board, a node becomes a page, and notes survive a reload", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);

    await test.step("create a topic from the notebook home", async () => {
      await page.goto("/notebook");
      await page.getByTestId("notebook-new-topic").click();
      await page.getByTestId("new-topic-title").fill("Software Engineering");
      await page.getByTestId("new-topic-submit").click();
      await expect(page.getByTestId("page-title")).toHaveValue("Software Engineering");
    });

    await test.step("start the page with a roadmap board and add a node", async () => {
      await page.getByTestId("start-board").click();
      await expect(page.getByTestId("board-block")).toBeVisible();
      await page.getByTestId("board-add-node").click();
      await page.getByTestId("board-node-title").fill("Data Structures");
      await page.getByTestId("board-node-submit").click();
      await expect(page.getByTestId("board-node").filter({ hasText: "Data Structures" })).toBeVisible();
      // The node is a page in the tree too.
      await expect(page.getByTestId("tree-item").filter({ hasText: "Data Structures" })).toBeVisible();
    });

    await test.step("open the node's page and write notes", async () => {
      await page.getByTestId("board-node").filter({ hasText: "Data Structures" }).dblclick();
      await expect(page.getByTestId("page-title")).toHaveValue("Data Structures");
      const editor = page.locator('[data-testid="notebook-editor"] [contenteditable="true"]').first();
      await editor.click();
      await page.keyboard.type("A heap keeps the smallest key at the root.");
      await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
    });

    await test.step("the notes are on the server and back after a reload", async () => {
      const pageId = page.url().split("/notebook/")[1];
      const stored = await (await fetchNotebookPage(api.ctx, api.accessToken, pageId)).json();
      expect(stored.content).toContain("A heap keeps the smallest key at the root.");
      await page.reload();
      await expect(page.getByTestId("notebook-editor")).toContainText("A heap keeps the smallest key at the root.");
    });

    await test.step("marking the node done finishes the topic above it", async () => {
      await page.getByTestId("status-DONE").click();
      // 30, not 15: the node was the topic's only one, so the topic finishes with it and both pay.
      await expect(page.getByText("+30 XP for finishing it")).toBeVisible();
      await page.getByRole("link", { name: "Software Engineering" }).first().click();
      await expect(page.getByTestId("page-progress")).toContainText("100%");
      await expect(page.getByTestId("board-node").filter({ hasText: "Data Structures" })).toHaveAttribute("data-status", "DONE");
    });
  });

  test("the focus board adds a node and the inspector marks it done", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Operating Systems");
    await addNotebookNode(api.ctx, api.accessToken, topic.id, "Processes", 40);

    await page.goto(`/notebook/${topic.id}/board`);
    await expect(page.getByTestId("board-focus-screen")).toBeVisible();

    await page.getByTestId("tool-add-node").click();
    await page.getByTestId("focus-draft-input").fill("Scheduling");
    await page.getByTestId("focus-draft-input").press("Enter");
    // A new node is selected, so the inspector opens on it.
    await expect(page.getByTestId("node-inspector")).toContainText("Scheduling");

    await page.getByTestId("status-DONE").click();
    await expect(page.getByTestId("board-node").filter({ hasText: "Scheduling" })).toHaveAttribute("data-status", "DONE");

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/notebook/${topic.id}$`));
  });

  /**
   * Reported in local testing: after deleting a page the app moved to its parent, and the delete
   * dialog was still open, now naming the parent. One more click on Delete would have taken the
   * parent and everything under it.
   */
  test("deleting a page lands on its parent with no delete dialog left open", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Spanish C1");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Baseline and immersion");

    await page.goto(`/notebook/${node.pageId}`);
    await expect(page.getByTestId("page-title")).toHaveValue("Baseline and immersion");
    await page.getByRole("button", { name: /more actions|mais ações/i }).first().click();
    await page.getByTestId("page-delete").click();
    await expect(page.getByRole("dialog")).toContainText("Baseline and immersion");
    await page.getByTestId("page-delete-confirm").click();

    await expect(page).toHaveURL(new RegExp(`/notebook/${topic.id}$`));
    await expect(page.getByTestId("page-title")).toHaveValue("Spanish C1");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).status()).toBe(200);
    expect((await fetchNotebookPage(api.ctx, api.accessToken, node.pageId!)).status()).toBe(400);
  });

  /** The header's icon opens the app's icon picker; the pick is stored and can be cleared. */
  test("a page gets an icon from its header, and can go back to the default", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Spanish C1");

    await page.goto(`/notebook/${topic.id}`);
    await page.getByTestId("page-icon").click();
    const picker = page.getByTestId("page-icon-picker");
    await picker.getByRole("button", { name: /^Icon: /i }).first().click();
    await expect(picker).toHaveCount(0);
    await expect.poll(async () => (await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json()).icon).not.toBeNull();

    await page.getByTestId("page-icon").click();
    await page.getByTestId("page-icon-clear").click();
    await expect.poll(async () => (await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json()).icon).toBeNull();
  });

  /**
   * Reported in testing: a notebook page ended about 160px above the bottom of the screen. The
   * page reserves its own bottom space on desktop and turns the shell's spacer off; every other
   * page keeps it, for the floating assistant button.
   */
  test("on desktop a notebook page drops the shell's bottom spacer, other pages keep it", async ({ authedPage: page, api }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Spanish C1");

    await page.goto(`/notebook/${topic.id}`);
    await expect(page.getByTestId("page-title")).toHaveValue("Spanish C1");
    await expect(page.getByTestId("bottom-nav-spacer")).toBeHidden();

    await page.goto("/dashboard");
    await expect(page.getByTestId("bottom-nav-spacer")).toBeVisible();
  });

  /** 85vw of content inside a padded panel is wider than the panel on a phone. */
  // Reported from prod: on a page that started empty, the "Add cards" starter stayed on screen while
  // the person wrote, and clicking it replaced everything written with one cards block.
  test("a page's starters go the moment something is written, so they never replace notes", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Algorithms");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Graphs");

    await page.goto(`/notebook/${node.pageId}`);
    await expect(page.getByTestId("page-starters")).toBeVisible();

    await page.locator('[data-testid="notebook-editor"] [contenteditable="true"]').first().click();
    await page.keyboard.type("Dijkstra does not take negative weights.");
    await expect(page.getByTestId("page-starters")).toHaveCount(0);
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

    const stored = await (await fetchNotebookPage(api.ctx, api.accessToken, node.pageId)).json();
    expect(stored.content).toContain("Dijkstra does not take negative weights.");
  });

  test("Add cards puts the deck on the page, and a card's answer opens on a click", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "TCP");

    await page.goto(`/notebook/${node.pageId}`);
    await page.getByTestId("start-cards").click();
    await expect(page.getByTestId("flashcards-block")).toBeVisible();
    await expect(page.getByTestId("page-starters")).toHaveCount(0);
    // The cursor waits under the deck.
    await page.keyboard.type("Three-way handshake.");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

    const stored = await (await fetchNotebookPage(api.ctx, api.accessToken, node.pageId)).json();
    expect(stored.content).toContain('"flashcards"');
    expect(stored.content).toContain("Three-way handshake.");

    await page.getByTestId("cards-write").click();
    await page.getByTestId("card-front").fill("What opens a TCP connection?");
    await page.getByTestId("card-back").fill("SYN, SYN-ACK, ACK.");
    await page.getByTestId("card-save").click();
    await expect(page.getByTestId("card-row")).toContainText("What opens a TCP connection?");
    await expect(page.getByTestId("card-answer")).toHaveCount(0);
    await page.getByTestId("card-question").click();
    await expect(page.getByTestId("card-answer")).toHaveText("SYN, SYN-ACK, ACK.");
  });

  test("a code block's language is picked from a list and saved, and an unknown one falls back to text", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Languages");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Snippets");
    await page.goto(`/notebook/${node.pageId}`);
    const editor = page.locator('[data-testid="notebook-editor"] [contenteditable="true"]').first();

    await editor.click();
    await page.keyboard.type("```py ");
    const picker = page.locator('[data-content-type="codeBlock"] select').first();
    await expect(picker).toHaveValue("python");
    await page.keyboard.type("print(1)");
    await picker.selectOption("java");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

    const stored = await (await fetchNotebookPage(api.ctx, api.accessToken, node.pageId)).json();
    expect(stored.content).toContain('"language":"java"');

    // A name the list does not have used to take the editor down; it now becomes plain text.
    // Back into the code (the picker had the focus), then out of the block onto a new line.
    await page.getByTestId("notebook-editor").getByText("print(1)").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("```cobolish ");
    await expect(page.locator('[data-content-type="codeBlock"] select').nth(1)).toHaveValue("text");
    await expect(page.getByTestId("notebook-editor")).toContainText("print(1)");
  });

  test("the new-topic dialog fits a phone screen without scrolling sideways", async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/notebook");
    await page.getByTestId("notebook-new-topic").click();

    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("new-topic-title")).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  });

  test("the home lists topics with their progress", async ({ authedPage: page, api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Fundamentals of CS");
    await addNotebookNode(api.ctx, api.accessToken, topic.id, "Discrete Math", 40);
    await addNotebookNode(api.ctx, api.accessToken, topic.id, "Theory of Computation", 280);

    await page.goto("/notebook");

    const card = page.getByTestId("topic-card").filter({ hasText: "Fundamentals of CS" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("0/2");
    await card.click();
    await expect(page.getByTestId("page-title")).toHaveValue("Fundamentals of CS");
  });
});
