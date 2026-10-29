// narafile(brog2b-v2)에서 먼저 적용한 키워드 매칭 정확도 개선(normalizeForMatch 등)을
// brog2b에도 동일하게 적용 (2026-10-29 사용자 요청: "키워드 관련 최적화를 narafile 에서
// 하고 있어. 여기도 적용하자.") — 아래 본문은 narafile의 keyword-text.ts를 그대로 가져온 것.
// 키워드 문자열 정리·검사(2026-10-25).
// 가입·관리자 등록·미리보기가 모두 같은 규칙을 쓰도록 한곳에 모았다.
// - 앞뒤 공백 제거, 연속 공백·탭·줄바꿈·전각/특수 공백은 공백 하나로, 보이지 않는 문자 제거, 유니코드 NFC 정규화
// - 쓸 수 있는 글자: 한글·영문·숫자·공백과 일부 기호( - · . / ( ) + & , ' # )
// - %, _, \ 등은 SQL LIKE의 와일드카드라 받지 않는다(조회 쿼리에서도 따로 이스케이프한다).

const INVISIBLE = /[​-‍⁠﻿­]/g;
const SPACES = /[\s   -   　]+/g;
const ALLOWED = /^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ \-·.\/()+&,'#]+$/;
const MEANINGFUL = /[0-9A-Za-z가-힣]/g;

export const KEYWORD_MAX_LENGTH = 30;

export function normalizeKeyword(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(SPACES, " ")
    .trim();
}

// 문제가 있으면 사용자에게 보여 줄 문장을, 없으면 null을 돌려준다.
export function keywordProblem(keyword: string): string | null {
  if (!keyword) return "키워드를 입력해 주세요.";
  if (keyword.length > KEYWORD_MAX_LENGTH) return `키워드는 ${KEYWORD_MAX_LENGTH}자까지입니다.`;
  if (!ALLOWED.test(keyword)) return "키워드에는 한글·영문·숫자와 일부 기호( - · . / ( ) + & , ' # )만 쓸 수 있습니다.";
  if ((keyword.match(MEANINGFUL) ?? []).length < 2) return "키워드는 한글·영문·숫자 2글자 이상이어야 합니다.";
  return null;
}

// 첨부 본문 매칭용: 줄바꿈·연속 공백 때문에 "수성 페인트"가 "수성\n페인트"를 놓치지 않도록
// 본문의 공백도 같은 방식으로 하나로 줄여 비교한다.
export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE, "").replace(SPACES, " ").toLocaleLowerCase("ko-KR");
}
