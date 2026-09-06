import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
// Railway terminates TLS at its edge proxy and forwards plain HTTP, so
// Express needs to trust X-Forwarded-Proto for secure cookies to work.
app.set("trust proxy", 1);

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

const PgSessionStore = connectPgSimple(session);
if (!process.env.SESSION_SECRET) {
  logger.warn(
    "SESSION_SECRET이 설정되지 않아 임시 값을 사용합니다. 재배포 시 기존 로그인 세션이 끊깁니다.",
  );
}
app.use(
  session({
    store: new PgSessionStore({ pool, tableName: "session", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "brobro-dev-only-insecure-secret",
    resave: false,
    saveUninitialized: false,
    name: "brobro.sid",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

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
