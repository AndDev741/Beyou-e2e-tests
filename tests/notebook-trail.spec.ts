import { test, expect } from "../fixtures/auth";
import type { APIRequestContext } from "@playwright/test";
import { apiUrl, createNotebookTopic, fetchNotebookPage } from "../support/apiClient";

/**
 * A roadmap edited from the phone. The phone does not draw the board, so it sends a node with no
 * coordinates and names the node it follows; the server picks the grid cell, draws the link and
 * gives the page the block that shows its board on the web. A reorder sends every page node in
 * the order the path should take, and the board becomes that one path.
 */

type Api = { ctx: APIRequestContext; accessToken: string };
type Node = { id: string; x: number; y: number; title: string };
type Board = { nodes: Node[]; edges: { source: string; target: string }[] };

const headers = (api: Api) => ({ Authorization: `Bearer ${api.accessToken}` });

async function addNode(api: Api, boardPageId: string, data: Record<string, unknown>) {
  return api.ctx.post(`${apiUrl()}/notebook/pages/${boardPageId}/board/nodes`, { headers: headers(api), data });
}

async function added(api: Api, boardPageId: string, data: Record<string, unknown>): Promise<Node> {
  const response = await addNode(api, boardPageId, data);
  expect(response.status()).toBe(201);
  return (await response.json()).node;
}

async function board(api: Api, boardPageId: string): Promise<Board> {
  return (await api.ctx.get(`${apiUrl()}/notebook/pages/${boardPageId}/board`, { headers: headers(api) })).json();
}

test.describe("a roadmap edited from the phone", () => {
  test("a node with no coordinates goes on the next free cell, after the node named, and the page shows its board", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");

    const physical = await added(api, topic.id, { title: "Physical" });
    const link = await added(api, topic.id, { title: "Link", after: physical.id });

    expect([physical.x, physical.y]).toEqual([40, 0]);
    expect([link.x, link.y]).toEqual([280, 0]);
    expect((await board(api, topic.id)).edges).toEqual([
      expect.objectContaining({ source: physical.id, target: link.id }),
    ]);
    const page = await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json();
    expect(page.content).toContain('"roadmapBoard"');
  });

  test("coordinates come in pairs, and a node can only follow a page node of the same board", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");
    const other = await createNotebookTopic(api.ctx, api.accessToken, "Algorithms");
    const elsewhere = await added(api, other.id, { title: "Graphs" });

    const half = await addNode(api, topic.id, { title: "Physical", x: 40 });
    expect(half.status()).toBe(400);
    expect((await half.json()).errorKey).toBe("INVALID_REQUEST");

    const stranger = await addNode(api, topic.id, { title: "Physical", after: elsewhere.id });
    expect(stranger.status()).toBe(400);
    expect((await stranger.json()).errorKey).toBe("NOTEBOOK_EDGE_INVALID");
    expect((await board(api, topic.id)).nodes).toEqual([]);
  });

  test("an order makes the board one path through every node, and one that leaves a node out is refused", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");
    const physical = await added(api, topic.id, { title: "Physical" });
    const link = await added(api, topic.id, { title: "Link", after: physical.id });
    const network = await added(api, topic.id, { title: "Network", after: physical.id });

    const partial = await api.ctx.put(`${apiUrl()}/notebook/pages/${topic.id}/board/order`, {
      headers: headers(api),
      data: { order: [network.id, physical.id] },
    });
    expect(partial.status()).toBe(400);
    expect((await partial.json()).errorKey).toBe("INVALID_REQUEST");

    const response = await api.ctx.put(`${apiUrl()}/notebook/pages/${topic.id}/board/order`, {
      headers: headers(api),
      data: { order: [network.id, physical.id, link.id] },
    });
    expect(response.status()).toBe(200);
    const after: Board = await response.json();
    // A branch (Physical before both Link and Network) is now a line, in the order sent.
    expect(after.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(
      [`${network.id}>${physical.id}`, `${physical.id}>${link.id}`].sort(),
    );
    const cells = Object.fromEntries(after.nodes.map((n) => [n.id, [n.x, n.y]]));
    expect(cells[network.id]).toEqual([40, 0]);
    expect(cells[physical.id]).toEqual([280, 0]);
    expect(cells[link.id]).toEqual([520, 0]);
  });
});
