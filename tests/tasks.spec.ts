import { test, expect } from "../fixtures/auth";
import { fetchTasks, postTask, putTask } from "../support/apiClient";

/**
 * Importance and difficulty are optional on a task. The column was always nullable and
 * the XP path always fell back to 1; only the request DTO's `@NotNull` stood in the way,
 * and both clients seeded their forms with "unset" — so a task could not be saved without
 * picking both (the kanban card "Tarefas no mobile obrigam escolher dificuldade e
 * importância"). This locks the contract at the wire: a task without either is created,
 * read back as null, and an edit that drops them clears them. A value that IS sent still
 * has to sit in 1..5.
 *
 * API-only: the rule lives at the endpoint, and the forms' own tests cover that they
 * send null for "unset".
 */
test.describe("Task priority is optional", () => {
  test("a task is created and edited without importance or difficulty", async ({ api }) => {
    const name = `Water the plants ${Date.now()}`;

    const created = await postTask(api.ctx, api.accessToken, {
      name,
      description: "",
      iconId: "lucide:leaf",
      categoriesId: [],
      oneTimeTask: false,
    });
    expect(created.status(), await created.text()).toBe(200);

    let row = (await fetchTasks(api.ctx, api.accessToken)).find((t) => t.name === name);
    expect(row).toBeDefined();
    expect(row!.importance).toBeNull();
    expect(row!.difficulty).toBeNull();

    const withPriority = await putTask(api.ctx, api.accessToken, {
      taskId: row!.id,
      name,
      description: "",
      iconId: "lucide:leaf",
      importance: 3,
      difficulty: 2,
      categoriesId: [],
      oneTimeTask: false,
    });
    expect(withPriority.status(), await withPriority.text()).toBe(200);
    row = (await fetchTasks(api.ctx, api.accessToken)).find((t) => t.id === row!.id);
    expect(row!.importance).toBe(3);
    expect(row!.difficulty).toBe(2);

    // The edit overwrites every scalar it carries: dropping them clears them.
    const cleared = await putTask(api.ctx, api.accessToken, {
      taskId: row!.id,
      name,
      description: "",
      iconId: "lucide:leaf",
      importance: null,
      difficulty: null,
      categoriesId: [],
      oneTimeTask: false,
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
    row = (await fetchTasks(api.ctx, api.accessToken)).find((t) => t.id === row!.id);
    expect(row!.importance).toBeNull();
    expect(row!.difficulty).toBeNull();
  });

  test("optional does not mean unbounded: 6 is still refused", async ({ api }) => {
    const refused = await postTask(api.ctx, api.accessToken, {
      name: `Too important ${Date.now()}`,
      description: "",
      iconId: "lucide:leaf",
      importance: 6,
      difficulty: 1,
      categoriesId: [],
      oneTimeTask: false,
    });
    expect(refused.status()).toBe(400);
    const body = (await refused.json()) as { details?: Record<string, unknown> };
    expect(body.details).toHaveProperty("importance");
  });
});
