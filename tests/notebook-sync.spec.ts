import { test, expect } from "../fixtures/auth";
import type { Page } from "@playwright/test";
import { apiUrl, appendNotebookNotes, createNotebookTopic, fetchNotebookPage, saveNotebookBlocks } from "../support/apiClient";

/**
 * One page, two writers. The server keeps a revision per page and refuses a save from an older
 * one; the editor that was refused reads the page again and merges block by block. Until this,
 * the later save simply won: notes the assistant or the study room appended to an open page were
 * gone the moment the person typed a letter there.
 */

const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
  content: [{ type: "text", text, styles: {} }],
  children: [],
});

async function stored(api: { ctx: import("@playwright/test").APIRequestContext; accessToken: string }, pageId: string) {
  return (await fetchNotebookPage(api.ctx, api.accessToken, pageId)).json();
}

/** Types at the end of the paragraph that reads `text`. */
async function typeAfter(page: Page, text: string, typed: string) {
  await page.getByTestId("notebook-editor").getByText(text, { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(typed);
}

test.describe("a page written from two places", () => {
  test("the content endpoint refuses a save from an older revision", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Revisions");
    const read = (await stored(api, topic.id)).contentRevision as number;

    const first = await api.ctx.put(`${apiUrl()}/notebook/pages/${topic.id}/content`, {
      headers: { Authorization: `Bearer ${api.accessToken}` },
      data: { content: JSON.stringify([para("a", "First")]), baseRevision: read },
    });
    expect(first.ok()).toBe(true);
    expect((await first.json()).contentRevision).toBe(read + 1);

    const stale = await api.ctx.put(`${apiUrl()}/notebook/pages/${topic.id}/content`, {
      headers: { Authorization: `Bearer ${api.accessToken}` },
      data: { content: JSON.stringify([para("a", "Stale")]), baseRevision: read },
    });
    expect(stale.status()).toBe(400);
    expect((await stale.json()).errorKey).toBe("NOTEBOOK_CONTENT_CONFLICT");
    expect((await stored(api, topic.id)).content).toContain("First");
  });

  test("notes appended to an open page survive the next edit there, and show up in it", async ({ authedPage: page, api }) => {
    test.setTimeout(60_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Operating Systems");
    await saveNotebookBlocks(api.ctx, api.accessToken, topic.id, [para("p1", "Virtual memory")]);
    await page.goto(`/notebook/${topic.id}`);
    await expect(page.getByTestId("notebook-editor")).toContainText("Virtual memory");

    // What the assistant or the study room's "save to page" does while the page is open.
    await appendNotebookNotes(api.ctx, api.accessToken, topic.id, "The TLB caches recent translations.");
    await typeAfter(page, "Virtual memory", " and paging");

    await expect.poll(async () => (await stored(api, topic.id)).content, { timeout: 15_000 })
      .toContain("Virtual memory and paging");
    const content = (await stored(api, topic.id)).content;
    expect(content).toContain("The TLB caches recent translations.");
    await expect(page.getByTestId("notebook-editor")).toContainText("The TLB caches recent translations.");
  });

  test("two tabs editing different paragraphs both keep their text, with no question", async ({ authedPage: first, api }) => {
    test.setTimeout(60_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");
    await saveNotebookBlocks(api.ctx, api.accessToken, topic.id, [para("p1", "TCP"), para("p2", "UDP")]);
    await first.goto(`/notebook/${topic.id}`);
    await expect(first.getByTestId("notebook-editor")).toContainText("UDP");
    const second = await first.context().newPage();
    await second.goto(`/notebook/${topic.id}`);
    await expect(second.getByTestId("notebook-editor")).toContainText("UDP");

    await typeAfter(first, "TCP", " opens with a handshake");
    await expect(first.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
    await typeAfter(second, "UDP", " just sends");

    await expect.poll(async () => (await stored(api, topic.id)).content, { timeout: 15_000 })
      .toContain("UDP just sends");
    expect((await stored(api, topic.id)).content).toContain("TCP opens with a handshake");
    await expect(second.getByTestId("conflict-dialog")).toHaveCount(0);
    await expect(second.getByTestId("notebook-editor")).toContainText("TCP opens with a handshake");
  });

  test("the same paragraph edited in two tabs asks, and keeping both keeps both", async ({ authedPage: first, api }) => {
    test.setTimeout(60_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Caches");
    await saveNotebookBlocks(api.ctx, api.accessToken, topic.id, [para("p1", "A cache line")]);
    await first.goto(`/notebook/${topic.id}`);
    await expect(first.getByTestId("notebook-editor")).toContainText("A cache line");
    const second = await first.context().newPage();
    await second.goto(`/notebook/${topic.id}`);
    await expect(second.getByTestId("notebook-editor")).toContainText("A cache line");

    await typeAfter(first, "A cache line", " is 64 bytes");
    await expect(first.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
    await typeAfter(second, "A cache line", " holds a block");

    await expect(second.getByTestId("conflict-dialog")).toBeVisible({ timeout: 15_000 });
    await expect(second.getByTestId("conflict-mine")).toHaveText("A cache line holds a block");
    await expect(second.getByTestId("conflict-theirs")).toHaveText("A cache line is 64 bytes");
    await second.getByTestId("conflict-apply").click();

    await expect.poll(async () => (await stored(api, topic.id)).content, { timeout: 15_000 })
      .toContain("A cache line holds a block");
    expect((await stored(api, topic.id)).content).toContain("A cache line is 64 bytes");
  });
});
