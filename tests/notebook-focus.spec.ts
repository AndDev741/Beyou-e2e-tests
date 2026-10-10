import { test, expect } from "../fixtures/auth";
import { addNotebookNode, createNotebookTopic } from "../support/apiClient";

/**
 * "Focus 25" on a notebook page starts the app's one pomodoro, and it must never replace a cycle
 * already running. On web it did: the button on another page stayed enabled, a click there threw
 * the running cycle away, and the minutes already spent on the first page were never reported.
 * Mobile refused from the start; the rule now lives in @beyou/state for both.
 */
test.describe("notebook focus", () => {
  test("a running cycle on one page keeps Focus 25 off on every other page", async ({ authedPage: page, api }) => {
    // Three loads of the notebook page, which carries the editor.
    test.setTimeout(90_000);
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Algorithms");
    const sorting = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Sorting");
    const graphs = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Graphs", 260);

    await test.step("start a cycle on the first page", async () => {
      await page.goto(`/notebook/${sorting.pageId}`);
      await expect(page.getByTestId("page-title")).toHaveValue("Sorting");
      await page.getByTestId("page-focus").click();
      await expect(page.getByTestId("page-focus")).toBeDisabled();
      await expect(page.getByTestId("page-focus")).toHaveText(/Focusing|Em foco/);
    });

    await test.step("another page refuses to start a second one, and says why", async () => {
      await page.goto(`/notebook/${graphs.pageId}`);
      await expect(page.getByTestId("page-title")).toHaveValue("Graphs");
      const button = page.getByTestId("page-focus");
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("title", /already running|em andamento/);
    });

    await test.step("the first page still owns the running cycle", async () => {
      await page.goto(`/notebook/${sorting.pageId}`);
      await expect(page.getByTestId("page-title")).toHaveValue("Sorting");
      await expect(page.getByTestId("page-focus")).toHaveText(/Focusing|Em foco/);
    });
  });
});
