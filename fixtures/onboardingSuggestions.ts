/**
 * Canned AI onboarding suggestion payloads, one per wizard step.
 *
 * The `POST /onboarding/suggestions` endpoint is the ONLY thing the AI
 * onboarding spec intercepts — every entity the wizard creates from these
 * suggestions goes through the real backend. Shapes mirror
 * `@beyou/types/onboarding/suggestions` (OnboardingSuggestions envelope).
 */

export const CATEGORY_FIXTURE = {
  categories: [
    { name: "Health", description: "Take care of body and mind", iconId: "lucide:heart-pulse" },
    { name: "Career", description: "Grow professionally", iconId: "lucide:briefcase" },
  ],
};

export const HABITS_TASKS_FIXTURE = {
  habits: [
    {
      name: "Morning run",
      description: "Run 20 minutes",
      motivationalPhrase: "Go!",
      iconId: "lucide:zap",
      categoryName: "Health",
      importance: 4,
      difficulty: 3,
    },
    {
      name: "Read 10 pages",
      description: "Daily reading",
      motivationalPhrase: "Grow",
      iconId: "lucide:book-open",
      categoryName: "Career",
      importance: 3,
      difficulty: 2,
    },
  ],
  tasks: [
    {
      name: "Buy running shoes",
      description: "One-time purchase",
      iconId: "lucide:star",
      categoryName: "Health",
      importance: 2,
      difficulty: 1,
    },
  ],
};

export const ROUTINE_FIXTURE = {
  routine: {
    name: "AI Starter Routine",
    iconId: "lucide:sun",
    scheduleDays: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    sections: [
      {
        name: "Morning",
        iconId: "lucide:sun",
        startTime: "07:00",
        endTime: "09:00",
        habits: [{ name: "Morning run", startTime: "07:00", endTime: "07:30" }],
        tasks: [{ name: "Buy running shoes", startTime: "08:00", endTime: "08:15" }],
      },
      {
        name: "Evening",
        iconId: "lucide:moon",
        startTime: "19:00",
        endTime: "22:00",
        habits: [{ name: "Read 10 pages", startTime: "20:00", endTime: "20:30" }],
        tasks: [],
      },
    ],
  },
};

export const GOALS_FIXTURE = {
  goals: [
    {
      name: "Run a 10k",
      description: "Build up distance",
      iconId: "lucide:zap",
      categoryName: "Health",
      targetValue: 10,
      unit: "km",
      motivation: "Feel strong",
      term: "MEDIUM_TERM",
      durationDays: 90,
    },
  ],
};

/** Map the request's `step` discriminator to its canned suggestions envelope. */
export function fixtureFor(step: string): Record<string, unknown> {
  switch (step) {
    case "CATEGORIES":
      return CATEGORY_FIXTURE;
    case "HABITS_TASKS":
      return HABITS_TASKS_FIXTURE;
    case "ROUTINE":
      return ROUTINE_FIXTURE;
    case "GOALS":
      return GOALS_FIXTURE;
    default:
      throw new Error(`unknown step ${step}`);
  }
}
