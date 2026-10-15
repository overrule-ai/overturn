const api = await import("../../../apps/api/dist/test/global-setup.js");

export default async function setup(): Promise<void> {
  const url = (process.env.TEST_DATABASE_URL ?? api.DEFAULT_TEST_DATABASE_URL).replace(
    /\/([^/]+)$/,
    "/$1_cli",
  );
  process.env.TEST_DATABASE_URL = url;
  await api.prepareTestDatabase(url);
}
