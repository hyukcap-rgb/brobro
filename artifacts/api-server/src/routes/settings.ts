import { Router, type IRouter } from "express";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getAppSettings, updateAppSettings } from "../lib/settings";

const router: IRouter = Router();

router.get("/settings", async (_req, res) => {
  res.json(await getAppSettings());
});

// 요구사항(설정 저장 오류 명확화, 2026-09-09 사용자 리포트: "설정이 없으면
// 에러가 나네"): 그동안은 어떤 검증 실패든 뭉뚱그려 "설정 값을 확인해
// 주세요."라고만 응답해서, 예를 들어 검색 키워드를 비운 채 저장하면(스키마상
// matchKeywords는 최소 1개 필요) 왜 실패하는지 사용자가 알 수 없었다. 어떤
// 필드가 문제인지 짚어주는 메시지로 바꾼다.
const SETTINGS_FIELD_ERROR_MESSAGES: Record<string, string> = {
  matchKeywords: "검색 키워드를 최소 1개 이상 입력해 주세요.",
  workCategories: "업무구분을 최소 1개 이상 선택해 주세요.",
  minEstimatedPrice: "추정가격 최소값을 확인해 주세요 (0 이상의 숫자).",
  maxEstimatedPrice: "추정가격 최대값을 확인해 주세요 (0 이상의 숫자).",
  minBudgetAmount: "최소 공사 규모 값을 확인해 주세요 (0 이상의 숫자).",
  notificationEmails: "이메일 주소 형식을 확인해 주세요.",
};

// 요구사항(2026-09-12 사용자 요청: 매일 검색 결과 자동 이메일 발송): 오타로 잘못된
// 주소가 저장되지 않도록 간단히 형식만 검사한다. zod 스키마는 orval이 생성하는
// 공용 파일이라(이 프로젝트의 zod 버전은 zod.email()을 지원하지 않음) 여기서
// 별도로 검사한다.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.put("/settings", async (req, res) => {
  const input = UpdateSettingsBody.safeParse(req.body);
  if (!input.success) {
    const field = input.error.issues[0]?.path[0];
    const message = (field != null && SETTINGS_FIELD_ERROR_MESSAGES[String(field)]) || "설정 값을 확인해 주세요.";
    res.status(400).json({ error: message });
    return;
  }
  if (input.data.notificationEmails?.some((email) => !EMAIL_PATTERN.test(email))) {
    res.status(400).json({ error: SETTINGS_FIELD_ERROR_MESSAGES.notificationEmails });
    return;
  }
  try {
    res.json(await updateAppSettings(input.data));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "설정을 저장하지 못했습니다." });
  }
});

export default router;
