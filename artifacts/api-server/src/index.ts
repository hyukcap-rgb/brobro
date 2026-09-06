import app from "./app";
import { logger } from "./lib/logger";
import { ensureAdminSeeded } from "./lib/auth";
import { startDailyScanScheduler } from "./lib/scheduler";
import { ensureSchema } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

ensureSchema()
  .then(() => ensureAdminSeeded())
  .then(() => startDailyScanScheduler())
  .catch((err: unknown) => {
    logger.error({ err }, "Could not initialize database schema/admin account");
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
