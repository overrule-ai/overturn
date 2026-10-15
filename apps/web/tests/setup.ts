const api = await import("../../api/dist/test/global-setup.js");

export default async function setup(): Promise<void> {
  const url = (process.env.TEST_DATABASE_URL ?? api.DEFAULT_TEST_DATABASE_URL).replace(
    /\/([^/]+)$/,
    "/$1_web",
  );
  process.env.TEST_DATABASE_URL = url;
  await api.prepareTestDatabase(url);
}
