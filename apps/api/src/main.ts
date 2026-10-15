import { startApp } from "./app";
import { loadConfig } from "./config";
import { loadDotEnv } from "./env";

loadDotEnv();

startApp(loadConfig()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
