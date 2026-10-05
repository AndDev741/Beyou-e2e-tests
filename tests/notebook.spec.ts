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

  /** 85vw of content inside a padded panel is wider than the panel on a phone. */
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
