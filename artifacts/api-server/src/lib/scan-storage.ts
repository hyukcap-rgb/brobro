import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

// Same pattern as JOB_ROOT in bid-processing.ts: prefer the Railway-mounted
// persistent volume so downloaded keyword-matched attachments survive
// restarts/redeploys, falling back to the OS temp dir for local dev.
export const SCAN_ROOT = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || tmpdir(),
  "daily-scan-matches",
);

// Resolves a previously-stored matched attachment for download, guarding
// against path traversal via the stored relative path.
export async function resolveMatchAttachmentPath(relativePath: string): Promise<string> {
  const target = path.resolve(SCAN_ROOT, relativePath);
  const rootWithSep = `${path.resolve(SCAN_ROOT)}${path.sep}`;
  if (target !== path.resolve(SCAN_ROOT) && !target.startsWith(rootWithSep)) {
    throw new Error("잘못된 파일 경로입니다.");
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error("파일을 찾을 수 없습니다.");
  return target;
}
