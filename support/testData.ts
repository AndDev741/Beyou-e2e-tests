/**
 * Test data factories. Each test should call these to get unique data so tests
 * never collide on the database, even running in parallel.
 *
 * The randomness uses crypto-grade entropy via global crypto.randomUUID() so
 * collisions are effectively impossible.
 */

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Generate a unique test user with a random email and a password that
 * satisfies the backend's policy (min 12 chars, 2 character classes).
 */
export function makeUser(overrides: Partial<TestUser> = {}): TestUser {
  const id = crypto.randomUUID().slice(0, 8);
  return {
    name: `E2E User ${id}`,
    email: `e2e-${id}@beyou.local`,
    password: "E2E-Test-Password-1",
    ...overrides,
  };
}
