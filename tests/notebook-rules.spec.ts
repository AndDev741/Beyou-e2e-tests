import { test, expect } from "../fixtures/auth";
import {
  addNotebookLinkSource,
  addNotebookNode,
  addNotebookTextSource,
  createNotebookTopic,
  fetchNotebookPage,
  fetchNotebookSources,
  linkNotebookNode,
  loginUser,
  newApiContext,
  registerUser,
  setNotebookStatus,
} from "../support/apiClient";
import { makeUser } from "../support/testData";

/**
 * The study notebook's rules, on the wire.
 *
 * These are the ones that would be expensive to get wrong later: an ownership boundary on the
 * most personal writing in the product, an XP payment that must not be farmable, a link that
 * must not make a page its own ancestor, and a server that fetches URLs and must never be a
 * proxy into its own network. The unit and integration tests prove the services; this proves
 * the routes, the filters and the error keys the clients translate.
 */
test.describe("study notebook rules", () => {
  test("somebody else's page answers NOTEBOOK_PAGE_NOT_OWNED", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Private study");
    const stranger = makeUser();
    const ctx = await newApiContext();
    await registerUser(ctx, stranger);
    const { accessToken } = await loginUser(ctx, { email: stranger.email, password: stranger.password });

    const response = await fetchNotebookPage(ctx, accessToken, topic.id);

    expect(response.status()).toBe(400);
    expect((await response.json()).errorKey).toBe("NOTEBOOK_PAGE_NOT_OWNED");
    await ctx.dispose();
  });

  /** Done, undone, done again: the second "done" pays nothing, or the status is an XP button. */
  test("finishing a page pays XP once", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "English C1");
    const lesson = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Phrasal verbs", 40);
    await addNotebookNode(api.ctx, api.accessToken, topic.id, "Idioms", 280);

    const first = await setNotebookStatus(api.ctx, api.accessToken, lesson.pageId!, "DONE");
    await setNotebookStatus(api.ctx, api.accessToken, lesson.pageId!, "TO_STUDY");
    const again = await setNotebookStatus(api.ctx, api.accessToken, lesson.pageId!, "DONE");

    expect(first.xpEarned).toBe(15);
    expect(again.xpEarned).toBe(0);
  });

  test("the last node done finishes the page that holds the board", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Data Structures");
    const arrays = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Arrays", 40);
    const trees = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Trees", 280);

    await setNotebookStatus(api.ctx, api.accessToken, arrays.pageId!, "DONE");
    const last = await setNotebookStatus(api.ctx, api.accessToken, trees.pageId!, "DONE");

    expect(last.changed).toEqual(expect.arrayContaining([{ pageId: topic.id, status: "DONE" }]));
    const page = await (await fetchNotebookPage(api.ctx, api.accessToken, topic.id)).json();
    expect(page.progress).toEqual({ done: 2, total: 2 });
  });

  test("a link that would put a page on its own board is refused", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Software Engineering");
    const structures = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Data Structures");

    const response = await linkNotebookNode(api.ctx, api.accessToken, structures.pageId!, topic.id);

    expect(response.status()).toBe(400);
    expect((await response.json()).errorKey).toBe("NOTEBOOK_BOARD_CYCLE");
  });

  /** The server fetches what users type; it must never fetch its own management port. */
  test("a source link into the private network is refused before it is stored", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Networks");

    const response = await addNotebookLinkSource(api.ctx, api.accessToken, topic.id, "http://127.0.0.1:9091/actuator/prometheus");

    expect(response.status()).toBe(400);
    expect((await response.json()).errorKey).toBe("NOTEBOOK_SOURCE_URL_REFUSED");
    expect(await fetchNotebookSources(api.ctx, api.accessToken, topic.id)).toEqual([]);
  });

  /** Read in the background after the request commits, then visible from the pages below. */
  test("pasted text is read and reaches the pages under it", async ({ api }) => {
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Algorithms");
    const sorting = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Sorting");

    const added = await addNotebookTextSource(api.ctx, api.accessToken, topic.id, "Lecture notes",
      "Merge sort splits the list in half, sorts each half and merges them in linear time.");
    expect(added.status()).toBe(202);

    await expect
      .poll(async () => (await fetchNotebookSources(api.ctx, api.accessToken, topic.id))[0]?.status, { timeout: 15_000 })
      .toBe("READY");
    const fromChild = await fetchNotebookSources(api.ctx, api.accessToken, sorting.pageId!);
    expect(fromChild).toHaveLength(1);
    expect(fromChild[0].inherited).toBe(true);
  });
});
