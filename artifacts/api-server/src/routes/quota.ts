import { Router, type IRouter } from "express";
import { getApiQuotaStatus } from "../lib/api-quota";

// GET /api/quota — narafile(brog2b-v2)이 읽는 공용 서비스키 사용 현황.
// 로그인 세션 대신 공유 토큰(QUOTA_SHARED_TOKEN)으로 보호한다. 토큰이
// 설정되지 않았으면 엔드포인트를 닫는다(404).
const router: IRouter = Router();

router.get("/quota", async (req, res) => {
  const expected = process.env.QUOTA_SHARED_TOKEN?.trim();
  if (!expected) {
    res.status(404).json({ error: "quota endpoint disabled" });
    return;
  }
  const given = (req.get("x-quota-token") ?? "").trim();
  if (given !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    res.json(await getApiQuotaStatus());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
