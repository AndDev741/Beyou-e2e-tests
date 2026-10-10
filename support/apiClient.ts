import { APIRequestContext, APIResponse, request } from "@playwright/test";

/**
 * Thin backend client used by fixtures and tests to set up state without
 * driving the UI. Everything that is not under test (auth, seed data) goes
 * through here. UI walks stay focused on the actual user flow under test.
 *
 * All methods accept an APIRequestContext so the same client can be reused
 * across browser contexts (each test starts in a clean state).
 */

const DEFAULT_API_URL = "http://localhost:8099/api/v1";

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  /**
   * Optional IANA zone, mirroring the real clients: both send the device's
   * detected zone so an account is not created on the UTC calendar. Omitting it
   * is also a real case (an older client), and the backend must still register.
   */
  timezone?: string;
  /**
   * Optional language the client's screen is showing (`en`, `pt`, or a regional tag
   * such as `pt-BR`). Both real clients send it so a new account's AI text and mail
   * start in the right language; omitting it is the older-client case.
   */
  language?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface CategoryPayload {
  name: string;
  icon: string;
  description?: string;
  experience: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
}

export function apiUrl(): string {
  return process.env.API_URL ?? DEFAULT_API_URL;
}

/**
 * Build a full URL against the configured API. We can't rely on Playwright's
 * baseURL resolution because Spring's context-path means our base ends in
 * `/api/v1`, and absolute-path inputs like `/auth/register` would resolve
 * against the host root instead.
 */
function joinUrl(path: string): string {
  const base = apiUrl().replace(/\/$/, "");
  const tail = path.replace(/^\//, "");
  return `${base}/${tail}`;
}

/**
 * Create an APIRequestContext bound to the backend. Caller is responsible for
 * disposing it (await ctx.dispose()) when done.
 */
export async function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: apiUrl() });
}

/**
 * Register a new user. In the `e2e` Spring profile the backend marks the
 * account as already verified, so login works immediately.
 */
export async function registerUser(
  ctx: APIRequestContext,
  payload: RegisterPayload,
): Promise<void> {
  const response = await ctx.post(joinUrl("auth/register"), { data: payload });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `register failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

/**
 * Registers an account that has NOT been auto-verified, and hands back its
 * verification token.
 *
 * The `e2e` profile normally marks every new account verified so specs can register
 * and log in in one breath, which means the whole verification flow — and the resend
 * endpoint that rescues it — is invisible to the suite. `X-E2E-Skip-Auto-Verify` opts
 * one registration out, and `e2e.expose-verification-token` puts the token in the
 * response because nothing in this stack reads a mailbox. Both are e2e-only and
 * `SecurityConfigValidator` refuses to boot prod with the flag on.
 */
export async function registerUnverifiedUser(
  ctx: APIRequestContext,
  payload: RegisterPayload,
): Promise<{ verificationToken: string }> {
  const response = await ctx.post(joinUrl("auth/register"), {
    data: payload,
    headers: { "X-E2E-Skip-Auto-Verify": "true" },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `register (unverified) failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  const body = await response.json();
  if (!body.verificationToken) {
    throw new Error(
      "the e2e profile must hand the verification token back (e2e.expose-verification-token), " +
        "or the verification flow cannot be tested",
    );
  }
  return { verificationToken: body.verificationToken };
}

/**
 * Asks for another verification mail. Returns the whole body, because what matters
 * about this endpoint is that the body looks the SAME for an address that exists, one
 * that does not, and one still inside its cooldown.
 */
export async function resendVerification(
  ctx: APIRequestContext,
  email: string,
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await ctx.post(joinUrl("auth/resend-verification"), {
    data: { email },
  });
  return { status: response.status(), body: await response.json() };
}

/**
 * Log in and return the JWT plus the cookies (incl. httpOnly refreshToken).
 * The cookies are what we feed into a browser context so the SPA boots
 * authenticated.
 */
export async function loginUser(
  ctx: APIRequestContext,
  payload: LoginPayload,
): Promise<{ accessToken: string }> {
  const response = await ctx.post(joinUrl("auth/login"), { data: payload });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `login failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const headers = response.headers();
  const accessToken = headers["x-access-token"];
  if (!accessToken) {
    throw new Error(
      "login response missing X-Access-Token header — backend changed?",
    );
  }
  return { accessToken };
}

export interface UserSnapshot {
  xp: number;
  level: number;
  constance: number;
  maxConstance: number;
}

/**
 * Re-login the user and return a snapshot of their gamification state. Useful
 * for asserting XP / constance changes after an action driven through the UI,
 * since there is no dedicated `GET /user/me` endpoint.
 */
export async function fetchUserSnapshot(
  ctx: APIRequestContext,
  credentials: LoginPayload,
): Promise<UserSnapshot> {
  const response = await ctx.post(joinUrl("auth/login"), { data: credentials });
  if (!response.ok()) {
    throw new Error(`fetchUserSnapshot login failed: ${response.status()}`);
  }
  const body = (await response.json()) as {
    success: {
      xp: number;
      level: number;
      constance: number;
      maxConstance: number;
    };
  };
  return {
    xp: body.success.xp,
    level: body.success.level,
    constance: body.success.constance,
    maxConstance: body.success.maxConstance,
  };
}

/**
 * Create a category for the authenticated user. Habits require at least one
 * category, so tests that exercise habit flows usually seed a category first.
 *
 * The backend's POST /category response just confirms creation, so we follow
 * up with GET /category to look up the new row by name and return its id.
 */
export async function createCategory(
  ctx: APIRequestContext,
  accessToken: string,
  payload: CategoryPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("category"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createCategory failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const categories = await listCategories(ctx, accessToken);
  const match = categories.find((c) => c.name === payload.name);
  if (!match) {
    throw new Error(
      `createCategory: category named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

interface CategoryRow {
  id: string;
  name: string;
  iconId: string;
}

async function listCategories(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<CategoryRow[]> {
  const response = await ctx.get(joinUrl("category"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`listCategories failed: ${response.status()}`);
  }
  return (await response.json()) as CategoryRow[];
}

export interface HabitPayload {
  name: string;
  description?: string;
  motivationalPhrase?: string;
  iconId: string;
  importance: 1 | 2 | 3 | 4 | 5;
  dificulty: 1 | 2 | 3 | 4 | 5;
  categoriesId: string[];
  experience: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
}

interface HabitRow {
  id: string;
  name: string;
}

/**
 * Create a habit and return its id. As with categories, the POST response is
 * opaque so we GET /habit to recover the id.
 */
export async function createHabit(
  ctx: APIRequestContext,
  accessToken: string,
  payload: HabitPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("habit"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createHabit failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const habits = await ctx.get(joinUrl("habit"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!habits.ok()) {
    throw new Error(`listHabits failed: ${habits.status()}`);
  }
  const rows = (await habits.json()) as HabitRow[];
  const match = rows.find((h) => h.name === payload.name);
  if (!match) {
    throw new Error(
      `createHabit: habit named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

export type WeekDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface RoutineHabitGroup {
  habitId: string;
  startTime: string;
  endTime: string;
}

export interface RoutineSection {
  name: string;
  iconId: string;
  startTime: string;
  endTime: string;
  habitGroup?: RoutineHabitGroup[];
  taskGroup?: never[];
  favorite?: boolean;
}

/** One entry of a LIST routine: exactly one of habitId / taskId, and no times. */
export interface RoutineListItem {
  habitId?: string;
  taskId?: string;
}

export interface RoutinePayload {
  name: string;
  iconId: string;
  /** Absent means DAILY, which is what every caller predating the List type sends. */
  type?: "DAILY" | "LIST";
  /** DAILY only. The backend rejects a body that carries these alongside `items`. */
  routineSections?: RoutineSection[];
  /** LIST only. Order is position in this array. */
  items?: RoutineListItem[];
}

interface RoutineResponse {
  id: string;
  name: string;
}

/**
 * Create a daily routine with at least one section. Returns the routine id so
 * callers can attach a schedule.
 */
export async function createRoutine(
  ctx: APIRequestContext,
  accessToken: string,
  payload: RoutinePayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("routine"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createRoutine failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  const body = (await response.json()) as RoutineResponse;
  return { id: body.id };
}

/**
 * Attach a schedule to a routine. `days` controls which weekdays the routine
 * fires on; pass `currentWeekDay()` to make sure today is included.
 */
export async function createSchedule(
  ctx: APIRequestContext,
  accessToken: string,
  payload: { days: WeekDay[]; routineId: string },
): Promise<void> {
  const response = await ctx.post(joinUrl("schedule"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createSchedule failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

/**
 * Edit the authenticated user's profile. Mirrors the frontend's PUT /user
 * (the `editUser` service). Used to seed server-side preferences — theme,
 * tutorial-completed flag, language — before driving the UI, so a test can
 * assert how those preferences survive (or fail to survive) a page reload.
 *
 * Payload keys match UserEditDTO: theme, isTutorialCompleted, language, etc.
 */
export async function editUser(
  ctx: APIRequestContext,
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await ctx.put(joinUrl("user"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `editUser failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

/**
 * The authenticated user's profile, as `GET /user` answers it.
 *
 * Separate from `fetchUserSnapshot`, which re-logs-in: this is the ONLY response
 * that carries the signed profile-photo URL. Login does not mint one (it maps the
 * user without a photo version), so a test about that URL has to come through here.
 *
 * The timezone pair is named rather than left to the index signature, because it is
 * also the real wire check for `timezoneSource`: the OpenAPI snapshot in
 * `packages/contracts` was hand-edited for that field, so this is what actually
 * proves the backend emits it.
 */
export async function fetchProfile(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<{
  photo: string | null;
  timezone: string;
  timezoneSource: "DEFAULT" | "DETECTED" | "EXPLICIT";
  languageInUse: string | null;
  [key: string]: unknown;
}> {
  const response = await ctx.get(joinUrl("user"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `fetchProfile failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  return response.json();
}

/**
 * Upload a profile photo. Multipart rather than JSON, so it cannot go through the
 * usual `data:` path — Playwright's `multipart` builds the body natively.
 */
export async function uploadUserPhoto(
  ctx: APIRequestContext,
  accessToken: string,
  jpeg: Buffer,
): Promise<void> {
  const response = await ctx.post(joinUrl("user/photo"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    multipart: {
      file: { name: "photo.jpg", mimeType: "image/jpeg", buffer: jpeg },
    },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `uploadUserPhoto failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

export interface GoalPayload {
  name: string;
  description?: string;
  iconId?: string;
  targetValue: number;
  unit: string;
  currentValue: number;
  categoriesId: string[];
  motivation?: string;
  /** ISO date string YYYY-MM-DD. */
  startDate: string;
  /** ISO date string YYYY-MM-DD. */
  endDate: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  term: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM";
  /** Parent goal id for a sub-goal; omit or null for a top-level goal. */
  parentId?: string | null;
}

export interface GoalRow {
  id: string;
  name: string;
  currentValue: number;
  complete: boolean;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  parentId: string | null;
  /** When the goal was archived; null while active. Archiving leaves `status` alone. */
  archivedAt?: string | null;
  xpReward?: number;
}

/** The raw create call, for specs that assert a refusal (status + errorKey) rather than a row. */
export async function postGoal(
  ctx: APIRequestContext,
  accessToken: string,
  payload: GoalPayload,
): Promise<APIResponse> {
  return ctx.post(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
}

export async function fetchGoals(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<GoalRow[]> {
  const list = await ctx.get(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok()) {
    throw new Error(`listGoals failed: ${list.status()}`);
  }
  return (await list.json()) as GoalRow[];
}

/**
 * Re-parent through PUT /goal, the way the forms do. Every field is sent back as the row
 * has it, so the only thing that changes is `parentId` (null detaches to the top level).
 */
export async function moveGoalUnder(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
  parentId: string | null,
): Promise<APIResponse> {
  const list = await ctx.get(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = (await list.json()) as Array<Record<string, unknown>>;
  const row = rows.find((g) => g.id === goalId);
  if (!row) throw new Error(`moveGoalUnder: goal ${goalId} not found`);
  return ctx.put(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {
      goalId,
      name: row.name,
      iconId: row.iconId,
      description: row.description,
      targetValue: row.targetValue,
      unit: row.unit,
      currentValue: row.currentValue,
      complete: row.complete,
      categoriesId: Object.keys((row.categories as Record<string, unknown>) ?? {}),
      motivation: row.motivation,
      startDate: row.startDate,
      endDate: row.endDate,
      status: row.status,
      term: row.term,
      parentId,
    },
  });
}

/**
 * `PUT /goal/archive`: archive (or restore) a goal and, with it, its sub-goals. Raw response,
 * so a spec can read the changed rows or assert a refusal.
 */
export async function archiveGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
  archived: boolean,
): Promise<APIResponse> {
  return ctx.put(joinUrl("goal/archive"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { goalId, archived },
  });
}

export async function deleteGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
): Promise<void> {
  const response = await ctx.delete(joinUrl(`goal/${goalId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`deleteGoal failed: ${response.status()}`);
  }
}

export async function createGoal(
  ctx: APIRequestContext,
  accessToken: string,
  payload: GoalPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createGoal failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  const list = await ctx.get(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok()) {
    throw new Error(`listGoals failed: ${list.status()}`);
  }
  const rows = (await list.json()) as GoalRow[];
  const match = rows.find((g) => g.name === payload.name);
  if (!match) {
    throw new Error(
      `createGoal: goal named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

export async function increaseGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
  value = 1,
): Promise<GoalRow> {
  const response = await ctx.put(joinUrl("goal/increase"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    // `UpdateGoalValueDTO`: the id plus how much to move by. `value` is optional
    // on the wire and defaults to 1 server-side, which is what the card's +
    // sends.
    data: { goalId, value },
  });
  if (!response.ok()) {
    // The body, not just the status: a bare "403" says nothing, and this helper
    // was one of two dropping it.
    const body = await response.text();
    throw new Error(
      `increaseGoal failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  return (await response.json()) as GoalRow;
}

export async function decreaseGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
  value = 1,
): Promise<GoalRow> {
  const response = await ctx.put(joinUrl("goal/decrease"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    data: { goalId, value },
  });
  if (!response.ok()) {
    throw new Error(
      `decreaseGoal failed: ${response.status()} ${response.statusText()}`,
    );
  }
  return (await response.json()) as GoalRow;
}

export async function completeGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
): Promise<{
  refreshUser: { xp: number; level: number; constance: number };
}> {
  const response = await ctx.put(joinUrl("goal/complete"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    data: JSON.stringify(goalId),
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `completeGoal failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  return (await response.json()) as {
    refreshUser: { xp: number; level: number; constance: number };
  };
}

/** The current local weekday in the form the backend's WeekDay enum expects. */
export function currentWeekDay(): WeekDay {
  const names: WeekDay[] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return names[new Date().getDay()];
}

/* -------------------------------------------------------------------------- */
/* Check history + streak scalars                                             */
/* -------------------------------------------------------------------------- */

/** One habit as `GET /habit` returns it, including the check scalars. */
export interface HabitSnapshot {
  id: string;
  name: string;
  /** Canonical icon id (`lucide:<kebab>` / `emoji:<short_name>`) as stored. */
  iconId: string;
  xp: number;
  level: number;
  currentStreak: number;
  bestStreak: number;
  totalCheckIns: number;
  firstCheckInDate: string | null;
  streakDormant: boolean;
}

export type CheckDayOutcome =
  | "DONE"
  | "SKIPPED"
  | "MISSED"
  | "NOT_SCHEDULED"
  | "NOT_IN_ROUTINE"
  | "UNKNOWN";

export interface CheckHistory {
  ownerType: string;
  ownerId: string;
  /** The EFFECTIVE range, which a wide request comes back clamped to. */
  from: string;
  to: string;
  days: Array<{ day: string; outcome: CheckDayOutcome }>;
}

/** Every habit with its streak scalars, so a test can read the numbers the card shows. */
export async function fetchHabits(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<HabitSnapshot[]> {
  const response = await ctx.get(joinUrl("habit"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchHabits failed: ${response.status()}`);
  }
  return (await response.json()) as HabitSnapshot[];
}

/** One habit by name. Throws rather than returning undefined so a typo fails loudly. */
export async function fetchHabit(
  ctx: APIRequestContext,
  accessToken: string,
  name: string,
): Promise<HabitSnapshot> {
  const rows = await fetchHabits(ctx, accessToken);
  const match = rows.find((row) => row.name === name);
  if (!match) {
    throw new Error(`fetchHabit: no habit named "${name}"`);
  }
  return match;
}

/**
 * `GET /check-history`. Omitting the range gets the endpoint's default of the
 * last 28 days ending on the OWNER's today — which is what the widget asks for,
 * so a test that wants the same window should also pass no dates.
 *
 * Returns the raw response too: several of the guarantees here are about status
 * codes and error keys, not about the body.
 */
export async function fetchCheckHistoryResponse(
  ctx: APIRequestContext,
  accessToken: string,
  query: Record<string, string>,
) {
  return ctx.get(joinUrl("check-history"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: query,
  });
}

export async function fetchCheckHistory(
  ctx: APIRequestContext,
  accessToken: string,
  query: Record<string, string>,
): Promise<CheckHistory> {
  const response = await fetchCheckHistoryResponse(ctx, accessToken, query);
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`fetchCheckHistory failed: ${response.status()} — ${body}`);
  }
  return (await response.json()) as CheckHistory;
}

/** The outcome stored for one day, or UNKNOWN when the range carries no such day. */
export function outcomeOn(history: CheckHistory, day: string): CheckDayOutcome {
  return history.days.find((entry) => entry.day === day)?.outcome ?? "UNKNOWN";
}

export async function deleteHabit(
  ctx: APIRequestContext,
  accessToken: string,
  habitId: string,
): Promise<void> {
  const response = await ctx.delete(joinUrl(`habit/${habitId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`deleteHabit failed: ${response.status()}`);
  }
}

export async function deleteRoutine(
  ctx: APIRequestContext,
  accessToken: string,
  routineId: string,
): Promise<void> {
  const response = await ctx.delete(joinUrl(`routine/${routineId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`deleteRoutine failed: ${response.status()}`);
  }
}

/**
 * Today as `yyyy-MM-dd` in the runner's local zone.
 *
 * The backend stores a check under the USER's zone, and a test user is created
 * with whatever zone the backend defaults to — so this only lines up while the
 * two agree. It does in CI (both UTC) and on a dev machine (the profile is
 * seeded from the browser). A test that needs to survive a mismatch should read
 * the day back out of the response instead of computing it.
 */
export function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A routine as `GET /routine` returns it, down to the group ids a check needs. */
export interface RoutineSnapshot {
  id: string;
  name: string;
  routineSections: Array<{
    id: string;
    name: string;
    iconId: string;
    startTime: string;
    endTime: string;
    favorite?: boolean;
    habitGroup?: Array<{ id: string; habitId: string; startTime: string; endTime?: string }>;
    taskGroup?: Array<{ id: string; taskId: string; startTime: string; endTime?: string }>;
  }>;
}

export async function fetchRoutines(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<RoutineSnapshot[]> {
  const response = await ctx.get(joinUrl("routine"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchRoutines failed: ${response.status()}`);
  }
  return (await response.json()) as RoutineSnapshot[];
}

/**
 * Check today's instance of a habit, the way the dashboard does.
 *
 * `POST /routine/check` wants the habit GROUP — the habit's placement inside a
 * routine section — not the habit, so this walks the routines to find it. Returns
 * the `RefreshUiDTO`, which is where the post-check streak scalars live.
 */
export async function checkHabitToday(
  ctx: APIRequestContext,
  accessToken: string,
  habitId: string,
): Promise<{
  refreshHabit?: {
    id: string;
    xp: number;
    level: number;
    currentStreak: number;
    bestStreak: number;
    totalCheckIns: number;
  };
  refreshUser?: { currentConstance: number; maxConstance: number; xp: number };
}> {
  const routines = await fetchRoutines(ctx, accessToken);
  for (const routine of routines) {
    for (const section of routine.routineSections ?? []) {
      const group = (section.habitGroup ?? []).find((entry) => entry.habitId === habitId);
      if (!group) continue;

      const response = await ctx.post(joinUrl("routine/check"), {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: {
          routineId: routine.id,
          habitGroupDTO: { habitGroupId: group.id, startTime: group.startTime },
        },
      });
      if (!response.ok()) {
        const body = await response.text();
        throw new Error(`checkHabitToday failed: ${response.status()} — ${body}`);
      }
      return await response.json();
    }
  }
  throw new Error(`checkHabitToday: habit ${habitId} sits in no routine section`);
}

/** `PUT /routine/{id}`. The id rides the path; the body is the create payload plus ids. */
export async function editRoutine(
  ctx: APIRequestContext,
  accessToken: string,
  routineId: string,
  payload: RoutinePayload,
): Promise<void> {
  const response = await ctx.put(joinUrl(`routine/${routineId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`editRoutine failed: ${response.status()} — ${body}`);
  }
}

/**
 * Check a habit on a specific day, the way the routine UI does with a back-date.
 *
 * `POST /routine/check` takes the habit GROUP plus an optional `localDate`; omitting
 * the date means the owner's today.
 */
export async function checkHabitOn(
  ctx: APIRequestContext,
  accessToken: string,
  habitId: string,
  localDate: string,
): Promise<void> {
  const placement = await findHabitPlacement(ctx, accessToken, habitId);
  const response = await ctx.post(joinUrl("routine/check"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {
      routineId: placement.routineId,
      localDate,
      habitGroupDTO: { habitGroupId: placement.groupId, startTime: placement.startTime },
    },
  });
  if (!response.ok()) {
    throw new Error(`checkHabitOn failed: ${response.status()} — ${await response.text()}`);
  }
}

/**
 * `PUT /routine/skip` with `skip: false` on a given day.
 *
 * Unskipping a day nobody skipped is the path that used to overwrite a stored check
 * with a miss, so it is worth being able to drive from a test.
 */
export async function unskipHabitOn(
  ctx: APIRequestContext,
  accessToken: string,
  routineId: string,
  habitId: string,
  localDate: string,
): Promise<void> {
  const placement = await findHabitPlacement(ctx, accessToken, habitId);
  const response = await ctx.put(joinUrl("routine/skip"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {
      routineId,
      localDate,
      skip: false,
      habitGroupDTO: { habitGroupId: placement.groupId, startTime: placement.startTime },
    },
  });
  if (!response.ok()) {
    throw new Error(`unskipHabitOn failed: ${response.status()} — ${await response.text()}`);
  }
}

/** Where a habit sits: which routine, which group, at what time. */
async function findHabitPlacement(
  ctx: APIRequestContext,
  accessToken: string,
  habitId: string,
): Promise<{ routineId: string; groupId: string; startTime: string }> {
  const routines = await fetchRoutines(ctx, accessToken);
  for (const routine of routines) {
    for (const section of routine.routineSections ?? []) {
      const group = (section.habitGroup ?? []).find((entry) => entry.habitId === habitId);
      if (group) {
        return { routineId: routine.id, groupId: group.id, startTime: group.startTime };
      }
    }
  }
  throw new Error(`findHabitPlacement: habit ${habitId} sits in no routine section`);
}

/** `iso` shifted by `days`, which may be negative. Anchored at UTC noon, so DST cannot slip a day. */
export function addDaysIso(iso: string, days: number): string {
  const anchor = new Date(`${iso}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

export interface DeletionCodeResponse {
  success: boolean;
  /** Present only under the `e2e` Spring profile, where there is no inbox to read. */
  code?: string;
}

/**
 * Step one of deleting an account. Under the e2e profile the backend hands the
 * code back in the response (`e2e.expose-deletion-code`), which is the only way a
 * test can carry the flow to its end without a mailbox.
 */
export async function requestAccountDeletionCode(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<DeletionCodeResponse> {
  const response = await ctx.post(joinUrl("user/deletion/code"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `requestAccountDeletionCode failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  return (await response.json()) as DeletionCodeResponse;
}

/** Step two: spend the code. Returns the raw response so a test can assert a refusal. */
export async function confirmAccountDeletion(
  ctx: APIRequestContext,
  accessToken: string,
  code: string,
) {
  return ctx.post(joinUrl("user/deletion/confirm"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    data: { code },
  });
}

/**
 * Remove the account's own profile photo. Returns the raw response so a spec can
 * assert the status rather than only the effect.
 */
export async function deleteUserPhoto(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<APIResponse> {
  return ctx.delete(joinUrl("user/photo"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Everything the account holds, as one JSON object. */
export async function exportUserData(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await ctx.get(joinUrl("user/export"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`exportUserData failed: ${response.status()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Focus Mode (F6): completed cycles and per-item micro-tasks.
// ---------------------------------------------------------------------------

export interface FocusMicroTask {
  id: string;
  date: string;
  itemGroupId: string;
  name: string;
  pinned: boolean;
  doneAt: string | null;
}

export interface FocusCycle {
  id: string;
  date: string;
  itemGroupId: string | null;
  kind: "POMODORO" | "SHORT_BREAK" | "LONG_BREAK";
  startedAt: string;
  endedAt: string;
  minutes: number;
}

/**
 * The item-group ids of a LIST routine, in list order. A list item is checked, skipped and
 * focused on by its ItemGroup id, the same id `POST /routine/check` takes, which is also
 * what a micro-task hangs off.
 */
export async function fetchListItemGroupIds(
  ctx: APIRequestContext,
  accessToken: string,
  routineId: string,
): Promise<string[]> {
  const response = await ctx.get(joinUrl("routine"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchListItemGroupIds failed: ${response.status()}`);
  }
  const routines = (await response.json()) as Array<{
    id: string;
    items?: Array<{ id: string; orderIndex: number }>;
  }>;
  const routine = routines.find((entry) => entry.id === routineId);
  if (!routine?.items) {
    throw new Error(`fetchListItemGroupIds: routine ${routineId} is not a LIST or was not found`);
  }
  return [...routine.items].sort((a, b) => a.orderIndex - b.orderIndex).map((item) => item.id);
}

/** `GET /focus/micro-tasks?itemGroupId=`. Note this read MATERIALISES pinned names on the item. */
export async function fetchFocusMicroTasks(
  ctx: APIRequestContext,
  accessToken: string,
  itemGroupId: string,
): Promise<FocusMicroTask[]> {
  const response = await ctx.get(joinUrl(`focus/micro-tasks?itemGroupId=${itemGroupId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchFocusMicroTasks failed: ${response.status()}`);
  }
  return (await response.json()) as FocusMicroTask[];
}

/** `POST /focus/micro-tasks`: one step under a routine item, the way the focus screen adds it. */
export async function addFocusMicroTask(
  ctx: APIRequestContext,
  accessToken: string,
  payload: { itemGroupId: string; name: string; pinned?: boolean },
): Promise<FocusMicroTask> {
  const response = await ctx.post(joinUrl("focus/micro-tasks"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { pinned: false, ...payload },
  });
  if (!response.ok()) {
    throw new Error(`addFocusMicroTask failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as FocusMicroTask;
}

/** `POST /focus/cycles`. Returns the raw response so a spec can assert on a refusal too. */
export async function recordFocusCycle(
  ctx: APIRequestContext,
  accessToken: string,
  payload: {
    itemGroupId: string | null;
    kind: FocusCycle["kind"];
    startedAt: string;
    endedAt: string;
    minutes: number;
  },
) {
  return ctx.post(joinUrl("focus/cycles"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
}

/** `GET /focus/day?date=`. Read-only: materialises nothing. */
export async function fetchFocusDay(
  ctx: APIRequestContext,
  accessToken: string,
  date: string,
): Promise<{ date: string; cycles: FocusCycle[]; microTasks: FocusMicroTask[] }> {
  const response = await ctx.get(joinUrl(`focus/day?date=${date}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchFocusDay failed: ${response.status()}`);
  }
  return (await response.json()) as {
    date: string;
    cycles: FocusCycle[];
    microTasks: FocusMicroTask[];
  };
}

// ---------------------------------------------------------------------------
// Tasks. Importance and difficulty are OPTIONAL (null on the wire, counted as 1
// for XP); the forms hold "unset" as 0 and the api layer sends null.
// ---------------------------------------------------------------------------

export interface TaskPayload {
  name: string;
  description?: string;
  iconId: string;
  importance?: number | null;
  difficulty?: number | null;
  categoriesId?: string[];
  oneTimeTask?: boolean;
}

export interface TaskRow {
  id: string;
  name: string;
  importance: number | null;
  difficulty: number | null;
  oneTimeTask: boolean;
}

/** The raw create call, for specs that assert the status as much as the row. */
export async function postTask(
  ctx: APIRequestContext,
  accessToken: string,
  payload: TaskPayload,
): Promise<APIResponse> {
  return ctx.post(joinUrl("task"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
}

/** `PUT /task` as the forms send it: every field, the id inside the body. */
export async function putTask(
  ctx: APIRequestContext,
  accessToken: string,
  payload: TaskPayload & { taskId: string },
): Promise<APIResponse> {
  return ctx.put(joinUrl("task"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
}

export async function fetchTasks(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<TaskRow[]> {
  const list = await ctx.get(joinUrl("task"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok()) {
    throw new Error(`listTasks failed: ${list.status()}`);
  }
  return (await list.json()) as TaskRow[];
}

/** One day of the diary, as `GET /mood` returns it. */
export interface MoodEntryRow {
  id: string;
  date: string;
  mood: number;
  note: string | null;
  updatedAt: string;
}

/**
 * Sets a day's level and leaves any note alone. The PATCH the widget uses.
 *
 * Returns the raw response so a test can assert on a refusal (a future date, a level outside
 * the scale) rather than only on the happy path.
 */
export async function setMoodLevel(
  ctx: APIRequestContext,
  accessToken: string,
  date: string,
  mood: number,
): Promise<APIResponse> {
  return ctx.patch(joinUrl(`mood/${date}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { mood },
  });
}

/** Replaces a day's entry, note included. The PUT the diary page's Save button uses. */
export async function saveMoodEntry(
  ctx: APIRequestContext,
  accessToken: string,
  date: string,
  entry: { mood: number; note: string | null },
): Promise<APIResponse> {
  return ctx.put(joinUrl(`mood/${date}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: entry,
  });
}

export async function fetchMoodEntriesResponse(
  ctx: APIRequestContext,
  accessToken: string,
  query: Record<string, string> = {},
): Promise<APIResponse> {
  return ctx.get(joinUrl("mood"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: query,
  });
}

export async function fetchMoodEntries(
  ctx: APIRequestContext,
  accessToken: string,
  query: Record<string, string> = {},
): Promise<MoodEntryRow[]> {
  const response = await fetchMoodEntriesResponse(ctx, accessToken, query);
  if (!response.ok()) {
    throw new Error(`fetchMoodEntries failed: ${response.status()} — ${await response.text()}`);
  }
  return (await response.json()) as MoodEntryRow[];
}

export async function deleteMoodEntry(
  ctx: APIRequestContext,
  accessToken: string,
  date: string,
): Promise<APIResponse> {
  return ctx.delete(joinUrl(`mood/${date}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Daily Briefing
// ---------------------------------------------------------------------------

export interface BriefingOpenItemRow {
  snapshotId: string;
  snapshotCheckId: string;
  date: string;
  routineId: string | null;
  routineName: string;
  itemType: "HABIT" | "TASK";
  itemName: string;
  itemIconId: string | null;
  sectionName: string;
  xpIfCheckedNow: number;
}

/** One goal in the briefing's goal lists, pace included. */
export interface BriefingGoalRow {
  id: string;
  name: string;
  iconId: string | null;
  currentValue: number;
  targetValue: number;
  unit: string;
  endDate: string;
  daysRemaining: number;
  percentComplete: number;
  remainingValue: number;
  requiredPerDay: number | null;
  expectedPercent: number;
  pace: "ON_TRACK" | "BEHIND" | "OVERDUE" | "REACHED";
}

export interface BriefingNarrativeRow {
  status: "PENDING" | "READY" | "UNAVAILABLE";
  todayLines: string[];
  yesterdayLines: string[];
}

export interface DailyBriefingRow {
  date: string;
  yesterday: {
    date: string;
    hadRoutine: boolean;
    complete: boolean;
    doneCount: number;
    skippedCount: number;
    xpEarned: number;
    openItems: BriefingOpenItemRow[];
    focusCycles: number;
    moodLevel: number | null;
  };
  today: {
    scheduledItemCount: number;
    scheduledToday: boolean;
    currentStreak: number;
    bestStreak: number;
    /** Ending within two weeks. Kept for the app builds already installed. */
    goalsApproaching: BriefingGoalRow[];
    recovery: { oldestOpenDay: string; daysUntilExpiry: number } | null;
    /** The open goals closest to their date on either side, no horizon. What clients render. */
    goalsAhead: BriefingGoalRow[];
  };
  narrative: BriefingNarrativeRow;
  seenAt: string | null;
}

export async function fetchDailyBriefing(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<DailyBriefingRow> {
  const response = await ctx.get(joinUrl("daily-briefing"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchDailyBriefing failed: ${response.status()} — ${await response.text()}`);
  }
  return (await response.json()) as DailyBriefingRow;
}

/** The prose alone: the read the dialog polls after GET /daily-briefing answers PENDING. */
export async function fetchBriefingNarrative(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<BriefingNarrativeRow> {
  const response = await ctx.get(joinUrl("daily-briefing/narrative"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`fetchBriefingNarrative failed: ${response.status()} — ${await response.text()}`);
  }
  return (await response.json()) as BriefingNarrativeRow;
}

export async function markDailyBriefingSeen(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<APIResponse> {
  return ctx.post(joinUrl("daily-briefing/seen"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------- study notebook

export interface NotebookPageRow {
  id: string;
  kind: "TOPIC" | "PAGE";
  topicId: string | null;
  parentId: string | null;
  title: string;
  status: "TO_STUDY" | "STUDYING" | "DONE";
  statusManual: boolean;
  hasBoard: boolean;
  progress: { done: number; total: number };
  content: string | null;
  cardsTotal: number;
  cardsDue: number;
}

export interface BoardNodeRow {
  id: string;
  kind: "PAGE" | "SECTION";
  pageId: string | null;
  title: string;
  status: "TO_STUDY" | "STUDYING" | "DONE";
  linked: boolean;
}

const bearer = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

async function okJson<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${what} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function createNotebookTopic(
  ctx: APIRequestContext,
  accessToken: string,
  title: string,
): Promise<NotebookPageRow> {
  return okJson(await ctx.post(joinUrl("notebook/topics"), { headers: bearer(accessToken), data: { title } }),
    "createNotebookTopic");
}

/** A new child page shown as a node on `boardPageId`'s board. */
export async function addNotebookNode(
  ctx: APIRequestContext,
  accessToken: string,
  boardPageId: string,
  title: string,
  x = 40,
): Promise<BoardNodeRow> {
  const change = await okJson<{ node: BoardNodeRow }>(
    await ctx.post(joinUrl(`notebook/pages/${boardPageId}/board/nodes`), {
      headers: bearer(accessToken),
      data: { title, x, y: 80 },
    }),
    "addNotebookNode",
  );
  return change.node;
}

export async function linkNotebookNode(
  ctx: APIRequestContext,
  accessToken: string,
  boardPageId: string,
  linkPageId: string,
): Promise<APIResponse> {
  return ctx.post(joinUrl(`notebook/pages/${boardPageId}/board/nodes`), {
    headers: bearer(accessToken),
    data: { linkPageId, x: 40, y: 80 },
  });
}

export async function setNotebookStatus(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  status: "TO_STUDY" | "STUDYING" | "DONE" | "AUTO",
): Promise<{ status: string; xpEarned: number; changed: { pageId: string; status: string }[] }> {
  return okJson(await ctx.put(joinUrl(`notebook/pages/${pageId}/status`), {
    headers: bearer(accessToken),
    data: { status },
  }), "setNotebookStatus");
}

export interface NotebookDraftRow {
  id: string;
  title: string;
  status: "DRAFTING" | "READY" | "FAILED";
}

/** "New topic with AI": stores a draft and answers 202 at once, DRAFTING. */
export async function startNotebookDraft(
  ctx: APIRequestContext,
  accessToken: string,
  title: string,
): Promise<APIResponse> {
  return ctx.post(joinUrl("notebook/ai/drafts"), { headers: bearer(accessToken), data: { title } });
}

export async function fetchNotebookDraft(
  ctx: APIRequestContext,
  accessToken: string,
  draftId: string,
): Promise<APIResponse> {
  return ctx.get(joinUrl(`notebook/drafts/${draftId}`), { headers: bearer(accessToken) });
}

export async function fetchNotebookDrafts(ctx: APIRequestContext, accessToken: string): Promise<NotebookDraftRow[]> {
  return okJson(await ctx.get(joinUrl("notebook/drafts"), { headers: bearer(accessToken) }), "fetchNotebookDrafts");
}

/** The study room as the server keeps it: setup, sources and the rest. */
export async function fetchStudyRoom(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
): Promise<{
  setup: { goal: string | null; scope: string; configuredAt: string | null };
  sources: { kind: string; url: string | null }[];
}> {
  return okJson(await ctx.get(joinUrl(`notebook/pages/${pageId}/study`), { headers: bearer(accessToken) }), "fetchStudyRoom");
}

/** A board's nodes with where they sit, to compare layouts. */
export async function fetchNotebookBoard(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
): Promise<{ nodes: (BoardNodeRow & { x: number; y: number })[] }> {
  return okJson(
    await ctx.get(joinUrl(`notebook/pages/${pageId}/board`), { headers: bearer(accessToken) }),
    "fetchNotebookBoard",
  );
}

export async function fetchNotebookPage(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
): Promise<APIResponse> {
  return ctx.get(joinUrl(`notebook/pages/${pageId}`), { headers: bearer(accessToken) });
}

export async function saveNotebookContent(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  paragraphs: string[],
): Promise<void> {
  const content = JSON.stringify(paragraphs.map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text, styles: {} }],
  })));
  await okJson(await ctx.put(joinUrl(`notebook/pages/${pageId}/content`), {
    headers: bearer(accessToken),
    data: { content },
  }), "saveNotebookContent");
}

/** A page's document from raw blocks: a topic made through the API has none, so no board block either. */
export async function saveNotebookBlocks(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  blocks: object[],
): Promise<void> {
  await okJson(await ctx.put(joinUrl(`notebook/pages/${pageId}/content`), {
    headers: bearer(accessToken),
    data: { content: JSON.stringify(blocks) },
  }), "saveNotebookBlocks");
}

/** A new title for a page, as the assistant's editStudyNode renames a node's page. */
export async function renameNotebookPage(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  title: string,
): Promise<void> {
  await okJson(await ctx.patch(joinUrl(`notebook/pages/${pageId}`), {
    headers: bearer(accessToken),
    data: { title },
  }), "renameNotebookPage");
}

/** Markdown at the end of a page, as the assistant's addStudyNotes writes it. */
export async function appendNotebookNotes(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  markdown: string,
): Promise<void> {
  await okJson(await ctx.post(joinUrl(`notebook/pages/${pageId}/append`), {
    headers: bearer(accessToken),
    data: { markdown },
  }), "appendNotebookNotes");
}

export async function createNotebookCard(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  front: string,
  back: string,
): Promise<{ id: string }> {
  return okJson(await ctx.post(joinUrl(`notebook/pages/${pageId}/cards`), {
    headers: bearer(accessToken),
    data: { front, back },
  }), "createNotebookCard");
}

export async function fetchDueCards(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<{ total: number; streak: number }> {
  return okJson(await ctx.get(joinUrl("notebook/cards/due"), { headers: bearer(accessToken) }), "fetchDueCards");
}

export async function addNotebookTextSource(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  title: string,
  text: string,
): Promise<APIResponse> {
  return ctx.post(joinUrl(`notebook/pages/${pageId}/sources/text`), {
    headers: bearer(accessToken),
    data: { title, text },
  });
}

export async function addNotebookLinkSource(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
  url: string,
): Promise<APIResponse> {
  return ctx.post(joinUrl(`notebook/pages/${pageId}/sources/link`), {
    headers: bearer(accessToken),
    data: { url },
  });
}

export async function fetchNotebookSources(
  ctx: APIRequestContext,
  accessToken: string,
  pageId: string,
): Promise<{ id: string; status: string; inherited: boolean; charCount: number | null }[]> {
  return okJson(await ctx.get(joinUrl(`notebook/pages/${pageId}/sources`), { headers: bearer(accessToken) }),
    "fetchNotebookSources");
}
