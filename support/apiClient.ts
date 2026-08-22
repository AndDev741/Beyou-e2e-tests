import { APIRequestContext, request } from "@playwright/test";

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

export interface RoutinePayload {
  name: string;
  iconId: string;
  routineSections: RoutineSection[];
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
}

interface GoalRow {
  id: string;
  name: string;
  currentValue: number;
  complete: boolean;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
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
