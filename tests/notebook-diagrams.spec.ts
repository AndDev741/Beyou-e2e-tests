import { test, expect } from "../fixtures/auth";
import type { APIRequestContext } from "@playwright/test";
import {
  addNotebookNode,
  createNotebookTopic,
  fetchNotebookPage,
  saveNotebookBlocks,
  saveNotebookContent,
} from "../support/apiClient";

/**
 * Diagrams in the notebook.
 *
 * The AI fills a small spec (kind, nodes, links), the server cleans it, and the app draws it; a
 * saved diagram is a block inside the page. The API cases run against the real backend: the
 * append path, the server's cleaning, and the block's words reaching the page text that the AI
 * context and the data export read. The UI cases stub ONLY the model routes and the agent
 * stream; inserting, editing and saving go through the real editor and the real backend.
 */

type Api = { ctx: APIRequestContext; accessToken: string };

const API_URL = (process.env.API_URL ?? "http://localhost:8099/api/v1").replace(/\/$/, "");
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const DIAGRAM = {
  v: 1,
  kind: "FLOW",
  title: "Transaction lifecycle",
  nodes: [
    { id: "a", label: "Active", detail: "reading and writing", tone: "ACCENT" },
    { id: "p", label: "Partially committed", detail: null, tone: "NEUTRAL" },
    { id: "c", label: "Committed", detail: null, tone: "SUCCESS" },
    { id: "f", label: "Failed", detail: null, tone: "DANGER" },
  ],
  links: [
    { from: "a", to: "p", label: null, dashed: false },
    { from: "p", to: "c", label: null, dashed: false },
    { from: "a", to: "f", label: "error", dashed: false },
  ],
};

type Block = { type: string; props?: { spec?: string } };

async function pageBlocks(api: Api, pageId: string): Promise<Block[]> {
  const page = await (await fetchNotebookPage(api.ctx, api.accessToken, pageId)).json();
  return page.content ? (JSON.parse(page.content) as Block[]) : [];
}

async function diagramsOn(api: Api, pageId: string) {
  return (await pageBlocks(api, pageId))
    .filter((block) => block.type === "diagram")
    .map((block) => JSON.parse(block.props!.spec!));
}

async function append(api: Api, pageId: string, body: object) {
  return api.ctx.post(`${API_URL}/notebook/pages/${pageId}/append`, { headers: bearer(api.accessToken), data: body });
}

test.describe("notebook diagrams", () => {
  test("an appended diagram is cleaned, stored as a block, and its words reach the page text", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Databases");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Transactions");

    const response = await append(api, node.pageId!, {
      diagram: {
        ...DIAGRAM,
        nodes: [...DIAGRAM.nodes, { id: "blank", label: "   ", detail: null, tone: "NEUTRAL" }, { id: "z", label: "Quarantined", detail: null, tone: "PURPLE" }],
        links: [...DIAGRAM.links, { from: "a", to: "ghost", label: null, dashed: false }, { from: "c", to: "c", label: null, dashed: false }],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);

    const [stored] = await diagramsOn(api, node.pageId!);
    expect(stored.nodes.map((n: { label: string }) => n.label)).toEqual(["Active", "Partially committed", "Committed", "Failed", "Quarantined"]);
    expect(stored.nodes[4].tone).toBe("NEUTRAL");
    expect(stored.links).toHaveLength(3);

    // The diagram's words are page text now, the text the AI context reads. The data export
    // carries that text and never the editor's JSON, so a label in it came from the block.
    const exported = await api.ctx.get(`${API_URL}/user/export`, { headers: bearer(api.accessToken) });
    expect(exported.ok(), await exported.text()).toBe(true);
    const pages = ((await exported.json()).notebook?.pages ?? []) as { id: string; text: string | null }[];
    expect(pages.find((p) => p.id === node.pageId)?.text ?? "").toContain("Quarantined");
  });

  test("an append with nothing to add, or a diagram that cannot be drawn, is refused", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Databases");

    const empty = await append(api, topic.id, {});
    expect(empty.status()).toBe(400);
    expect((await empty.json()).errorKey).toBe("INVALID_REQUEST");

    const lonely = await append(api, topic.id, { diagram: { ...DIAGRAM, nodes: [DIAGRAM.nodes[0]], links: [] } });
    expect(lonely.status()).toBe(400);
    expect(await diagramsOn(api, topic.id)).toEqual([]);
  });

  test("a saved diagram draws on its page, and Edit saves a renamed box", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Databases");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Transactions");
    await saveNotebookBlocks(api.ctx, api.accessToken, node.pageId!, [
      { type: "paragraph", content: [{ type: "text", text: "Every transaction starts active.", styles: {} }] },
      { type: "diagram", props: { spec: JSON.stringify(DIAGRAM) } },
      { type: "paragraph", content: [] },
    ]);

    await page.goto(`/notebook/${node.pageId}`);
    const block = page.getByTestId("diagram-block");
    await expect(block.getByRole("img")).toBeVisible();
    await expect(block.getByTestId("diagram-view")).toContainText("Partially committed");

    await block.hover();
    await block.getByTestId("diagram-edit").click();
    const editor = page.getByTestId("diagram-editor");
    await expect(editor).toBeVisible();
    await editor.getByTestId("diagram-box-label-2").fill("Durably committed");
    await editor.getByTestId("diagram-save").click();
    await expect(editor).toBeHidden();
    await expect(block.getByTestId("diagram-view")).toContainText("Durably committed");

    await expect
      .poll(async () => (await diagramsOn(api, node.pageId!))[0]?.nodes?.[2]?.label)
      .toBe("Durably committed");
  });

  test("/diagram draws with the AI, shows a preview, and inserts the block", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Databases");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Transactions");
    await saveNotebookContent(api.ctx, api.accessToken, node.pageId!, ["A transaction is all or nothing."]);

    const asked: { prompt: string; kind: string | null; grounded: boolean }[] = [];
    await page.route("**/notebook/ai/pages/*/diagram", async (route) => {
      asked.push(route.request().postDataJSON());
      await route.fulfill({ json: { diagram: DIAGRAM, fromNotes: true } });
    });

    await page.goto(`/notebook/${node.pageId}`);
    await page.getByText("A transaction is all or nothing.").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/diagram");
    await page.getByRole("option", { name: /Diagram/ }).first().click();

    const dialog = page.getByTestId("diagram-generator");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("diagram-prompt").fill("How a transaction moves from start to commit");
    await dialog.getByTestId("diagram-generate").click();
    await expect(dialog.getByTestId("diagram-view")).toContainText("Committed");
    await dialog.getByTestId("diagram-insert").click();
    await expect(dialog).toBeHidden();

    expect(asked).toEqual([{ prompt: "How a transaction moves from start to commit", kind: null, grounded: true, base: null }]);
    await expect(page.getByTestId("diagram-block").getByTestId("diagram-view")).toContainText("Active");
    await expect.poll(async () => (await diagramsOn(api, node.pageId!)).length).toBe(1);
  });

  test("a study-room answer with a diagram saves it to the page, beside the open notes too", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Databases");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Transactions");
    await saveNotebookContent(api.ctx, api.accessToken, node.pageId!, ["A transaction is all or nothing."]);

    await page.route("**/notebook/ai/pages/*/chat", (route) =>
      route.fulfill({
        json: {
          question: { id: "q1", role: "USER", content: "Draw the lifecycle", citations: [], createdAt: "2026-10-17T10:00:00Z" },
          answer: {
            id: "a1",
            role: "ASSISTANT",
            content: "It starts active and ends committed or aborted [1].",
            citations: [{ n: 1, kind: "PAGE", sourceId: null, chunkId: null, pageId: node.pageId, title: 'Your page "Transactions"',
              pageNumber: null, excerpt: "A transaction is all or nothing." }],
            createdAt: "2026-10-17T10:00:01Z",
            diagram: DIAGRAM,
          },
        },
      }),
    );

    await page.goto(`/notebook/${node.pageId}/study`);
    await page.getByTestId("setup-start").click();
    await page.getByTestId("study-chat-input").fill("Draw the lifecycle");
    await page.getByTestId("study-chat-send").click();

    const card = page.getByTestId("study-answer").last().getByTestId("study-diagram-card");
    await expect(card.getByTestId("diagram-view")).toContainText("Partially committed");
    await expect(card.getByTestId("study-diagram-source")).toContainText("From your notes");

    await test.step("saved from the room alone, through the server", async () => {
      await card.getByTestId("study-diagram-save").click();
      await expect.poll(async () => (await diagramsOn(api, node.pageId!)).length).toBe(1);
    });

    await test.step("saved with the notes open beside the chat, into the live editor", async () => {
      const refused: number[] = [];
      page.on("response", (response) => {
        if (response.url().endsWith("/content") && response.request().method() === "PUT" && !response.ok()) refused.push(response.status());
      });
      await page.getByRole("button", { name: /Side by side/ }).click();
      await expect(page.getByTestId("notebook-editor").getByTestId("diagram-block")).toHaveCount(1);
      await card.getByTestId("study-diagram-save").click();
      await expect(page.getByTestId("notebook-editor").getByTestId("diagram-block")).toHaveCount(2);
      await expect.poll(async () => (await diagramsOn(api, node.pageId!)).length).toBe(2);
      expect(refused).toEqual([]);
    });
  });

  test("the assistant shows a diagram and saves it to a page the person picks", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");
    const node = await addNotebookNode(api.ctx, api.accessToken, topic.id, "TCP handshake");
    const sequence = {
      v: 1, kind: "SEQUENCE", title: "TCP handshake",
      nodes: [
        { id: "c", label: "Client", detail: null, tone: "ACCENT" },
        { id: "s", label: "Server", detail: null, tone: "NEUTRAL" },
      ],
      links: [
        { from: "c", to: "s", label: "SYN", dashed: false },
        { from: "s", to: "c", label: "SYN-ACK", dashed: true },
        { from: "c", to: "s", label: "ACK", dashed: false },
      ],
    };
    const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    await page.route("**/ai/agent/chats/*/stream", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          event("tool", { tool: "showDiagram", status: "started" }),
          event("tool", { tool: "showDiagram", status: "finished", domains: [], diagram: sequence }),
          event("token", { text: "Three messages before the first byte." }),
          event("done", {
            segments: [
              { type: "tool", tool: "showDiagram", domains: [], diagram: sequence },
              { type: "text", text: "Three messages before the first byte." },
            ],
          }),
        ].join(""),
      });
    });

    await page.goto("/notebook");
    await page.getByRole("button", { name: "Open assistant" }).click();
    await page.getByPlaceholder("Message your assistant...").fill("show me the TCP handshake");
    await page.getByRole("button", { name: "Send message" }).click();

    const card = page.getByTestId("agent-diagram-card");
    await expect(card.getByTestId("diagram-view")).toContainText("SYN-ACK");
    await card.getByTestId("agent-diagram-save").click();
    const picker = page.getByTestId("diagram-page-picker");
    await picker.getByTestId("diagram-page-search").fill("TCP handshake");
    await picker.getByTestId("diagram-page-option").filter({ hasText: "TCP handshake" }).first().click();

    await expect.poll(async () => (await diagramsOn(api, node.pageId!)).map((d) => d.kind)).toEqual(["SEQUENCE"]);
  });
});
