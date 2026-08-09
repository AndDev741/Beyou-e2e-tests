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
   * The form opens in a modal (create and edit reuse the same one), so only one
   * `<form>` is visible at a time. `:visible` is the discriminator.
   */
  readonly form = (): Locator => this.page.locator("form:visible");

  // Ids of the redesigned form (`habit-name`, `habit-description`,
  // `habit-motivation`); they used to be CamelCase `name` attributes.
  readonly nameInput = (): Locator => this.form().locator("#habit-name");
  readonly descriptionInput = (): Locator =>
    this.form().locator("#habit-description");
  readonly motivationalInput = (): Locator =>
    this.form().locator("#habit-motivation");
  readonly iconSearchInput = (): Locator =>
    this.form().locator('input[name="icon-small"]');

  // Create and edit share the same submit label in the new design.
  readonly createButton = (): Locator =>
    this.form().getByRole("button", { name: "Save habit", exact: true });
  readonly editButton = (): Locator => this.createButton();

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

  /**
   * Importance and difficulty became a `SegmentedControl`: a labelled
   * `role=radiogroup` with `role=radio` inside. They used to be sibling
   * input+label pairs.
   */
  private radio(group: string, level: string): Locator {
    return this.form()
      .getByRole("radiogroup", { name: group })
      .getByRole("radio", { name: level, exact: true });
  }

  async pickImportance(level: HabitFormInput["importance"]): Promise<void> {
    await this.radio("Importance", level).click();
  }

  async pickDifficulty(level: HabitFormInput["difficulty"]): Promise<void> {
    await this.radio("Difficulty", level).click();
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

  /** The form became a modal: it opens through the page header's button. */
  async openCreateForm(): Promise<void> {
    await this.page.getByTestId("create-habit").click();
    await this.expectCreateFormVisible();
  }

  async expectEditFormVisible(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Edit Habit" }),
    ).toBeVisible();
  }
}
