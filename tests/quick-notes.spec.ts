import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import { makeUser } from "../support/testData";
import {
  archiveQuickNote,
  convertQuickNoteToTask,
  createQuickNote,
  deleteQuickNote,
  editQuickNote,
  exportUserData,
  fetchArchivedQuickNotes,
  fetchQuickNotes,
  fetchTasks,
  loginUser,
  postQuickNote,
  registerUser,
  restoreQuickNote,
  saveQuickNoteLayout,
  tidyQuickNotes,
} from "../support/apiClient";

/**
 * The Ideas board: quick notes on a free board, and turning one into a task.
 *
 * Why this file exists: where a note lands, how the board tidies, who may touch a note and the
 * once-only conversion into a task are server rules that two apps and the chat agent all lean
 * on. A client that placed notes itself, or converted by creating a task and archiving in two
 * calls, would drift from the others without any unit test noticing.
 */

/** One grid cell: a 200x160 note plus a 24 gap on each axis. */
const CELL_X = 224;
const CELL_Y = 184;

async function stranger(ctx: APIRequestContext): Promise<string> {
  const user = makeUser();
  await registerUser(ctx, user);
  const { accessToken } = await loginUser(ctx, { email: user.email, password: user.password });
  return accessToken;
}

test.describe("ideas board API", () => {
  test("a note with no spot lands in the first free cell of the grid", async ({ api }) => {
    // Cell 1 is taken on purpose: the first free cell is 0, and the one after that is 2, which a
    // placement that only counted notes (instead of checking what each cell overlaps) gets wrong.
    await createQuickNote(api.ctx, api.accessToken, { text: "Taken", x: CELL_X, y: 0 });

    const first = await createQuickNote(api.ctx, api.accessToken, { text: "Buy a plant" });
    const second = await createQuickNote(api.ctx, api.accessToken, { text: "Learn the ukulele" });

    expect([first.x, first.y]).toEqual([0, 0]);
    expect([second.x, second.y]).toEqual([2 * CELL_X, 0]);
    expect(first.color).toBe("YELLOW");
    // Each new note goes in front of the ones already there.
    expect(second.z).toBeGreaterThan(first.z);
  });

  test("a layout save is all or nothing", async ({ api }) => {
    const mine = await createQuickNote(api.ctx, api.accessToken, { text: "Mine", x: 0, y: 0 });
    const strangerToken = await stranger(api.ctx);
    const theirs = await createQuickNote(api.ctx, strangerToken, { text: "Theirs", x: 0, y: 0 });

    const refused = await saveQuickNoteLayout(api.ctx, api.accessToken, [
      { id: mine.id, x: 500, y: 300, z: 9 },
      { id: theirs.id, x: 10, y: 10, z: 10 },
    ]);
    expect(refused.status()).toBe(404);
    expect((await refused.json()).errorKey).toBe("QUICK_NOTE_NOT_FOUND");
    const untouched = (await fetchQuickNotes(api.ctx, api.accessToken)).find((n) => n.id === mine.id)!;
    expect([untouched.x, untouched.y]).toEqual([0, 0]);

    const saved = await saveQuickNoteLayout(api.ctx, api.accessToken, [{ id: mine.id, x: 500, y: -300, z: 9 }]);
    expect(saved.ok()).toBe(true);
    const moved = (await fetchQuickNotes(api.ctx, api.accessToken)).find((n) => n.id === mine.id)!;
    expect([moved.x, moved.y, moved.z]).toEqual([500, -300, 9]);
  });

  test("tidy lines the board up by colour, then by age", async ({ api }) => {
    const pink = await createQuickNote(api.ctx, api.accessToken, { text: "Pink first", color: "PINK", x: 900, y: 40 });
    const yellow = await createQuickNote(api.ctx, api.accessToken, { text: "Yellow", color: "YELLOW", x: -300, y: 700 });
    const blue = await createQuickNote(api.ctx, api.accessToken, { text: "Blue", color: "BLUE", x: 50, y: 50 });
    const pinkLater = await createQuickNote(api.ctx, api.accessToken, { text: "Pink later", color: "PINK", x: 5, y: 5 });

    const board = await tidyQuickNotes(api.ctx, api.accessToken);
    const at = (id: string) => {
      const note = board.find((n) => n.id === id)!;
      return [note.x, note.y];
    };

    expect(at(yellow.id)).toEqual([0, 0]);
    expect(at(pink.id)).toEqual([CELL_X, 0]);
    expect(at(pinkLater.id)).toEqual([2 * CELL_X, 0]);
    expect(at(blue.id)).toEqual([3 * CELL_X, 0]);
  });

  test("converting makes exactly one task and archives the note", async ({ api }) => {
    const note = await createQuickNote(api.ctx, api.accessToken, { text: "Renew the passport\nbefore the trip" });

    const converted = await convertQuickNoteToTask(api.ctx, api.accessToken, note.id, {
      name: "Renew the passport",
      description: "before the trip",
      iconId: "lucide:leaf",
    });
    expect(converted.status()).toBe(201);
    const body = await converted.json();
    expect(body.note.archivedAt).not.toBeNull();
    expect(body.note.convertedTaskId).toBe(body.taskId);

    // A double submit must not make a second task.
    const again = await convertQuickNoteToTask(api.ctx, api.accessToken, note.id, {
      name: "Renew the passport",
      iconId: "lucide:leaf",
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).errorKey).toBe("QUICK_NOTE_ALREADY_CONVERTED");

    const tasks = await fetchTasks(api.ctx, api.accessToken);
    expect(tasks.filter((t) => t.name === "Renew the passport").map((t) => t.id)).toEqual([body.taskId]);
    expect((await fetchQuickNotes(api.ctx, api.accessToken)).map((n) => n.id)).not.toContain(note.id);
    const archived = await fetchArchivedQuickNotes(api.ctx, api.accessToken);
    expect(archived.find((n) => n.id === note.id)?.convertedTaskId).toBe(body.taskId);
  });

  test("a refused task leaves the note on the board", async ({ api }) => {
    const note = await createQuickNote(api.ctx, api.accessToken, { text: "x" });

    // One character is below the task's minimum name length.
    const refused = await convertQuickNoteToTask(api.ctx, api.accessToken, note.id, { name: "x", iconId: "lucide:leaf" });
    expect(refused.status()).toBe(400);

    const board = await fetchQuickNotes(api.ctx, api.accessToken);
    expect(board.find((n) => n.id === note.id)?.archivedAt).toBeNull();
  });

  /** Every route answers the same 404 for someone else's note, so none of them confirms it exists. */
  test("another account can neither see nor touch a note", async ({ api }) => {
    const note = await createQuickNote(api.ctx, api.accessToken, { text: "Private thought" });
    const strangerToken = await stranger(api.ctx);

    const attempts = [
      await editQuickNote(api.ctx, strangerToken, note.id, { text: "Hijacked", color: "PINK" }),
      await saveQuickNoteLayout(api.ctx, strangerToken, [{ id: note.id, x: 1, y: 1, z: 1 }]),
      await archiveQuickNote(api.ctx, strangerToken, note.id),
      await restoreQuickNote(api.ctx, strangerToken, note.id),
      await convertQuickNoteToTask(api.ctx, strangerToken, note.id, { name: "Hijacked", iconId: "lucide:leaf" }),
      await deleteQuickNote(api.ctx, strangerToken, note.id),
    ];
    for (const attempt of attempts) {
      expect(attempt.status()).toBe(404);
      expect((await attempt.json()).errorKey).toBe("QUICK_NOTE_NOT_FOUND");
    }

    expect(await fetchQuickNotes(api.ctx, strangerToken)).toEqual([]);
    const mine = await fetchQuickNotes(api.ctx, api.accessToken);
    expect(mine.map((n) => n.text)).toEqual(["Private thought"]);
  });

  test("the board holds 200 notes, and archived ones free a place", async ({ api }) => {
    test.slow();
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const made = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          createQuickNote(api.ctx, api.accessToken, { text: `Idea ${batch * 20 + i}`, x: 0, y: 0 }),
        ),
      );
      ids.push(...made.map((n) => n.id));
    }

    const full = await postQuickNote(api.ctx, api.accessToken, { text: "One too many" });
    expect(full.status()).toBe(409);
    expect((await full.json()).errorKey).toBe("QUICK_NOTE_LIMIT_REACHED");

    expect((await archiveQuickNote(api.ctx, api.accessToken, ids[0])).ok()).toBe(true);
    expect((await postQuickNote(api.ctx, api.accessToken, { text: "Now it fits" })).status()).toBe(201);

    // Full again, so the archived note cannot come back.
    const restore = await restoreQuickNote(api.ctx, api.accessToken, ids[0]);
    expect(restore.status()).toBe(409);
    expect((await restore.json()).errorKey).toBe("QUICK_NOTE_LIMIT_REACHED");
  });

  test("the account export carries every note, archived ones included", async ({ api }) => {
    const kept = await createQuickNote(api.ctx, api.accessToken, { text: "Keep this", color: "GREEN" });
    const gone = await createQuickNote(api.ctx, api.accessToken, { text: "Archive this" });
    await archiveQuickNote(api.ctx, api.accessToken, gone.id);

    const exported = await exportUserData(api.ctx, api.accessToken);
    const notes = exported.quickNotes as { id: string; text: string; color: string; archivedAt: string | null }[];

    expect(notes.map((n) => [n.text, n.color, n.archivedAt === null]).sort()).toEqual(
      [
        ["Archive this", "YELLOW", false],
        ["Keep this", "GREEN", true],
      ].sort(),
    );
    expect(notes.map((n) => n.id).sort()).toEqual([kept.id, gone.id].sort());
  });
});

test.describe("ideas board in the browser", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("an idea typed in the capture field sticks to the board and survives a reload", async ({ authedPage, api }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));

    await authedPage.goto("/ideas");
    await authedPage.getByTestId("ideas-capture-input").fill("Call grandma on Sunday");
    await authedPage.getByTestId("ideas-capture-input").press("Enter");

    await expect(authedPage.getByRole("group", { name: "Note: Call grandma on Sunday" })).toBeVisible();
    // The component sent no spot, so the server placed it: read back off the server.
    await expect
      .poll(async () => (await fetchQuickNotes(api.ctx, api.accessToken)).map((n) => [n.text, n.x, n.y]))
      .toEqual([["Call grandma on Sunday", 0, 0]]);

    await authedPage.reload();
    await expect(authedPage.getByRole("group", { name: "Note: Call grandma on Sunday" })).toBeVisible();
    await expect(authedPage.getByTestId("ideas-count")).toContainText("1");
    expect(errors).toEqual([]);
  });

  test("a dragged note stays where it was dropped and comes to the front", async ({ authedPage, api }) => {
    const behind = await createQuickNote(api.ctx, api.accessToken, { text: "Behind", x: 0, y: 0 });
    const other = await createQuickNote(api.ctx, api.accessToken, { text: "Other", x: 2 * CELL_X, y: 0 });

    await authedPage.goto("/ideas");
    const note = authedPage.locator(`[data-testid="quick-note"][data-note-id="${behind.id}"]`);
    await expect(note).toBeVisible();
    const box = (await note.boundingBox())!;

    await authedPage.mouse.move(box.x + box.width / 2, box.y + 20);
    await authedPage.mouse.down();
    await authedPage.mouse.move(box.x + box.width / 2 + 60, box.y + 80, { steps: 8 });
    await authedPage.mouse.move(box.x + box.width / 2 + 120, box.y + 160, { steps: 8 });
    await authedPage.mouse.up();

    await expect
      .poll(async () => {
        const moved = (await fetchQuickNotes(api.ctx, api.accessToken)).find((n) => n.id === behind.id)!;
        return moved.x > 0 && moved.y > 0 && moved.z > other.z;
      })
      .toBe(true);

    const saved = (await fetchQuickNotes(api.ctx, api.accessToken)).find((n) => n.id === behind.id)!;
    await authedPage.reload();
    await expect(note).toBeVisible();
    const after = (await fetchQuickNotes(api.ctx, api.accessToken)).find((n) => n.id === behind.id)!;
    expect([after.x, after.y]).toEqual([saved.x, saved.y]);
  });

  test("making a note a task creates the task and moves the note to Archived", async ({ authedPage, api }) => {
    const note = await createQuickNote(api.ctx, api.accessToken, { text: "Renew the passport\nbefore the trip" });

    await authedPage.goto("/ideas");
    const card = authedPage.getByRole("group", { name: /^Note: Renew the passport/ });
    await card.click();
    await card.getByRole("button", { name: "Make it a task" }).click();

    const dialog = authedPage.getByRole("dialog", { name: "Task from a note" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox").first()).toHaveValue("Renew the passport");
    await dialog.locator('input[name="icon-small"]').fill("leaf");
    await dialog.getByRole("button", { name: /leaf/i }).first().click();
    await dialog.getByRole("button", { name: "Save task" }).click();

    await expect(authedPage.getByText("Task created. The note moved to Archived.")).toBeVisible();
    await expect(card).toHaveCount(0);

    await expect
      .poll(async () => (await fetchTasks(api.ctx, api.accessToken)).map((t) => t.name))
      .toContain("Renew the passport");
    const archived = await fetchArchivedQuickNotes(api.ctx, api.accessToken);
    expect(archived.find((n) => n.id === note.id)?.convertedTaskId).not.toBeNull();

    await authedPage.getByTestId("ideas-archived-toggle").click();
    await expect(authedPage.getByTestId("archived-note-became-task")).toBeVisible();
  });

  test("Alt+N saves an idea from any page", async ({ authedPage, api }) => {
    await authedPage.goto("/dashboard");
    // The shortcut lives in the signed-in shell, which mounts after the silent refresh.
    await expect(authedPage.getByRole("link", { name: "Ideas" }).first()).toBeVisible();
    await authedPage.keyboard.press("Alt+KeyN");

    const dialog = authedPage.getByRole("dialog", { name: "New idea" });
    await expect(dialog).toBeVisible();
    await authedPage.locator("#quick-capture-input").fill("Book the vet");
    await authedPage.locator("#quick-capture-input").press("Enter");

    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await fetchQuickNotes(api.ctx, api.accessToken)).map((n) => n.text))
      .toEqual(["Book the vet"]);
  });

  test("the board fits a phone screen", async ({ authedPage, api }) => {
    await authedPage.setViewportSize({ width: 390, height: 844 });
    await createQuickNote(api.ctx, api.accessToken, { text: "Small screens too" });

    await authedPage.goto("/ideas");
    await expect(authedPage.getByRole("group", { name: "Note: Small screens too" })).toBeVisible();
    const overflow = await authedPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
