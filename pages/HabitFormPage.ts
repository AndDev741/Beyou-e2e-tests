import { expect, Locator, Page } from "@playwright/test";

/**
 * Page Object for the habit form (create + edit). Lives inside Beyou's habits
 * screen, not a route of its own. Selectors lean on form `name=` attributes,
 * labels, and accessible button names so they survive UI tweaks.
 */
export interface HabitFormInput {
  name: string;
  description: string;
  motivationalPhrase?: string;
  /** Searchable substring; the first matching icon button is clicked. */
  iconSearch: string;
  /** "Low" | "Medium" | "High" | "Max" — English labels. */
  importance: "Low" | "Medium" | "High" | "Max";
  /** "Easy" | "Normal" | "Hard" | "Terrible" — English labels. */
  difficulty: "Easy" | "Normal" | "Hard" | "Terrible";
  /** Visible category names to select. */
  categoryNames: string[];
}

export class HabitFormPage {
  constructor(private readonly page: Page) {}

  /**
   * Both CreateHabit and EditHabit forms are mounted simultaneously on the
   * page (toggled with `display: hidden`). Anchoring on the visible form
   * keeps every locator unambiguous regardless of which mode is active.
   *
   * `:visible` is a Playwright engine selector that filters by computed
   * visibility — exactly the discriminator we need here.
   */
  readonly form = (): Locator => this.page.locator("form:visible");

  readonly nameInput = (): Locator => this.form().locator('input[name="Name"]');
  readonly descriptionInput = (): Locator =>
    this.form().locator('textarea[id="description"]');
  readonly motivationalInput = (): Locator =>
    this.form().locator('input[name="MotivationPhrase"]');
  readonly iconSearchInput = (): Locator =>
    this.form().locator('input[name="icon"]');

  readonly createButton = (): Locator =>
    this.form().getByRole("button", { name: "Create" });
  readonly editButton = (): Locator =>
    this.form().getByRole("button", { name: "Edit", exact: true });

  /**
   * Selects the first icon matching `query`. Relies on the icon picker
   * search box to narrow the grid down, then clicks the first icon button
   * by its accessible role.
   */
  async pickIcon(query: string): Promise<void> {
    await this.iconSearchInput().fill(query);
    // Pick the first icon button whose accessible name contains the query.
    // The picker also renders category filter buttons (All, Icons, …) above
    // the grid; scoping by name-match skips those.
    const queryRegex = new RegExp(query, "i");
    const firstIcon = this.form()
      .getByRole("button", { name: queryRegex })
      .first();
    await firstIcon.click();
  }

  async pickImportance(level: HabitFormInput["importance"]): Promise<void> {
    // ChooseInput renders <input type="radio" name="importance" id={levelLabel}>
    // with a sibling <label htmlFor={levelLabel}>; clicking the label flips
    // the radio. Importance and difficulty share the level labels (Easy/Hard
    // collide with nothing, but Medium/Normal are unique), so scoping to the
    // importance radio group keeps it unambiguous.
    await this.form()
      .locator(`input[name="importance"][id="${level}"]`)
      .locator("xpath=following-sibling::label")
      .click();
  }

  async pickDifficulty(level: HabitFormInput["difficulty"]): Promise<void> {
    await this.form()
      .locator(`input[name="difficulty"][id="${level}"]`)
      .locator("xpath=following-sibling::label")
      .click();
  }

  /**
   * Selects a category by visible name. Each tile is a `<label>` wrapping a
   * checkbox whose `name` attribute is the category name, so we can target
   * the input directly via its accessible role.
   */
  async pickCategory(name: string): Promise<void> {
    const checkbox = this.form().getByRole("checkbox", { name });
    await checkbox.check();
  }

  async fill(input: HabitFormInput): Promise<void> {
    await this.nameInput().fill(input.name);
    await this.descriptionInput().fill(input.description);
    if (input.motivationalPhrase) {
      await this.motivationalInput().fill(input.motivationalPhrase);
    }
    await this.pickIcon(input.iconSearch);
    await this.pickImportance(input.importance);
    await this.pickDifficulty(input.difficulty);
    for (const name of input.categoryNames) {
      await this.pickCategory(name);
    }
  }

  async submitCreate(): Promise<void> {
    await this.createButton().click();
  }

  async submitEdit(): Promise<void> {
    await this.editButton().click();
  }

  async expectCreateFormVisible(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Create Habit" }),
    ).toBeVisible();
  }

  async expectEditFormVisible(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Edit Habit" }),
    ).toBeVisible();
  }
}
