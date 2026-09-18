import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, adminUsersTable } from "@workspace/db";
import { logger } from "./logger";

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin!23";

// 요구사항(2026-09-18 사용자 요청: "admin id 말고 msjbro / msjbro1 로 새로운
// 아이디 하나 만들어줘"): 기존 admin 계정은 그대로 두고, 별도의 관리자 계정을
// 하나 더 만든다 — 아래 ensureExtraAdminSeeded()가 서버 시작마다 확인해서
// 없으면 한 번만 만든다(이미 있으면 아무 일도 하지 않는다). 비밀번호는 위
// DEFAULT_ADMIN_PASSWORD처럼 소스에 그대로 적어두지 않는다 — 이 저장소는
// GitHub에 커밋되므로 소스에 적힌 비밀번호는 커밋 기록에 영원히 남아 노출된다.
// 대신 Railway 환경변수 EXTRA_ADMIN_PASSWORD(SESSION_SECRET·MAIL_APP_PASSWORD와
// 같은 방식)로 값을 전달한다 — 변수가 설정되어 있지 않으면 계정을 만들지 않고
// 경고만 남긴다(값 없이 임의 비밀번호로 만들면 로그인할 수 없는 계정이 된다).
const EXTRA_ADMIN_USERNAME = "msjbro";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
  }
}

// Ensures the single hardcoded admin account exists. Extra accounts
// ("슈퍼admin") are added later only by hand (direct DB insert on request),
// never through a public signup flow.
export async function ensureAdminSeeded(): Promise<void> {
  const [existing] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.username, DEFAULT_ADMIN_USERNAME))
    .limit(1);
  if (existing) return;
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);
  await db
    .insert(adminUsersTable)
    .values({ username: DEFAULT_ADMIN_USERNAME, passwordHash, isSuperAdmin: "true" })
    .onConflictDoNothing();
  logger.info({ username: DEFAULT_ADMIN_USERNAME }, "Seeded default admin account");
}

// 요구사항(2026-09-18 사용자 요청: "admin id 말고 msjbro / msjbro1 로 새로운
// 아이디 하나 만들어줘"): 위 ensureAdminSeeded()와 같은 패턴 — 이미 있으면
// 건드리지 않고, 없을 때만 한 번 만든다. index.ts에서 ensureAdminSeeded() 뒤에
// 이어서 호출한다.
export async function ensureExtraAdminSeeded(): Promise<void> {
  const [existing] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.username, EXTRA_ADMIN_USERNAME))
    .limit(1);
  if (existing) return;
  const password = process.env["EXTRA_ADMIN_PASSWORD"];
  if (!password) {
    logger.warn(
      { username: EXTRA_ADMIN_USERNAME },
      "EXTRA_ADMIN_PASSWORD 환경변수가 설정되지 않아 추가 관리자 계정을 만들지 않았습니다.",
    );
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await db
    .insert(adminUsersTable)
    .values({ username: EXTRA_ADMIN_USERNAME, passwordHash, isSuperAdmin: "true" })
    .onConflictDoNothing();
  logger.info({ username: EXTRA_ADMIN_USERNAME }, "Seeded extra admin account");
}

export async function verifyCredentials(
  username: string,
  password: string,
): Promise<{ id: number; username: string } | null> {
  const [user] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.username, username.trim()))
    .limit(1);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;
  return { id: user.id, username: user.username };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.userId) {
    next();
    return;
  }
  res.status(401).json({ error: "로그인이 필요합니다." });
}
