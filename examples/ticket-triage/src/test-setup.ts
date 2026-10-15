/** Vitest global setup: a dedicated test database so this package can run in parallel with the API tests. */
const api = await import("../../../apps/api/dist/test/global-setup.js");

export default async function setup(): Promise<void> {
  const url =
    process.env.EXAMPLE_TEST_DATABASE_URL ??
    (process.env.TEST_DATABASE_URL ?? api.DEFAULT_TEST_DATABASE_URL).replace(/\/([^/]+)$/, "/$1_example");
  process.env.TEST_DATABASE_URL = url;
  await api.prepareTestDatabase(url);
}
