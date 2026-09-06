import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, adminUsersTable } from "@workspace/db";
import { logger } from "./logger";

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin!23";

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
