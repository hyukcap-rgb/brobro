import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// On Replit, the built frontend is served by Replit's own multi-service router
// (BASE_PATH-based). Outside Replit (e.g. Railway) there is no such router, so
// this server serves the frontend's built static files itself when present,
// falling back to index.html for client-side routes (SPA).
const webDistDir = path.resolve(
  import.meta.dirname,
  "../../bid-attachment-search/dist/public",
);
if (existsSync(webDistDir)) {
  app.use(express.static(webDistDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}

export default app;
