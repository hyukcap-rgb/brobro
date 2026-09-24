import { useEffect, useMemo, useState } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  useListMatches,
  getListMatchesQueryKey,
  type AppSettingsInputWorkCategoriesItem,
  type AppSettingsInputEnabledSourcesItem,
  type AwardedMatch,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertCircle,
  CheckCircle2,
  Filter,
  ListFilter,
  Loader2,
  Mail,
  Plus,
  Save,
  Sparkles,
  Globe,
  X,
} from "lucide-react";

function TagEditor({
  label,
  description,
  values,
  onChange,
  emptyHint = "(전체 허용, 필터 없음)",
  required = false,
}: {
  label: string;
  description: string;
  values: string[];
  onChange: (values: string[]) => void;
  // 요구사항(설정 저장 오류 명확화, 2026-09-09 사용자 리포트: "설정이 없으면
  // 에러가 나네"): 이 컴포넌트는 검색 키워드/공종 키워드 둘 다에 쓰이는데,
  // 실제로는 검색 키워드를 비우면 저장이 거부되고(서버 스키마 min(1)) 비워도
  // 스캔이 "전체 허용"이 되는 게 아니라 아무 것도 매칭되지 않는다. 반면 공종
  // 키워드는 비우면 정말로 "전체 허용"이다. 필드마다 다른 빈 상태 안내 문구를
  // 넣을 수 있게 했다.
  emptyHint?: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <Badge key={value} variant="secondary" className="gap-1">
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((item) => item !== value))}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {values.length === 0 ? (
          <span className={`text-xs ${required ? "text-destructive" : "text-muted-foreground"}`}>{emptyHint}</span>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="키워드 입력 후 Enter"
        />
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-4 w-4" /> 추가
        </Button>
      </div>
    </div>
  );
}

// 요구사항(2026-09-12 사용자 요청: "설정에서 매일 검색 결과를 이메일로 자동
// 전송될 수 있는 주소를 넣는곳을 만들어줘... 추가/삭제가 가능하도록 해줘"):
// TagEditor와 거의 같은 UI지만, 이메일 형식이 아니면 추가 자체를 막고 안내
// 문구를 보여준다는 점이 다르다.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailListEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("올바른 이메일 형식이 아닙니다 (예: name@example.com).");
      return;
    }
    if (values.includes(trimmed)) {
      setError("이미 등록된 주소입니다.");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
    setError(null);
  };

  return (
    <div className="space-y-2">
      <Label>결과 알림 이메일</Label>
      <p className="text-xs text-muted-foreground">
        매일 오전 7시 자동 검색이 끝났을 때, 그날 새로 찾은 결과가 있으면 이 주소로 요약 메일(첨부파일 포함)을
        보냅니다. 결과가 없으면 메일을 보내지 않습니다. 화면에서 "지금 실행"한 결과는 메일로 보내지 않습니다.
      </p>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <Badge key={value} variant="secondary" className="gap-1">
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((item) => item !== value))}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {values.length === 0 ? (
          <span className="text-xs text-muted-foreground">등록된 주소가 없습니다 (메일이 발송되지 않습니다).</span>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Input
          type="email"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="name@example.com 입력 후 Enter"
        />
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-4 w-4" /> 추가
        </Button>
      </div>
      {error ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}
    </div>
  );
}

// 나라장터 자체 검색 화면(입찰공고 > 최종낙찰자)의 "업무구분" 체크박스와 동일한
// 구성으로 맞췄다. 물품/일반용역/기술용역/공사는 실제로 별도 API로 연동되어
// 있어 선택할 수 있고, 기타/민간은 나라장터가 아닌 별도 API(누리장터) 등록이
// 필요해 아직 연동하지 못했다 — 체크박스는 보여주되 비활성화해 둔다.
const SUPPORTED_CATEGORIES = ["물품", "일반용역", "기술용역", "공사"] as const;
const UNSUPPORTED_CATEGORIES = ["기타", "민간"] as const;

function WorkCategoryPicker({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const allSelected = SUPPORTED_CATEGORIES.every((category) => values.includes(category));

  const toggle = (category: string) => {
    if (values.includes(category)) onChange(values.filter((item) => item !== category));
    else onChange([...values, category]);
  };

  const toggleAll = () => {
    onChange(allSelected ? [] : [...SUPPORTED_CATEGORIES]);
  };

  return (
    <div className="space-y-2">
      <Label>업무구분</Label>
      <p className="text-xs text-muted-foreground">
        선택한 업무구분의 낙찰 공고만 매일 자동 검색 대상이 됩니다. 나라장터 검색 화면의 업무구분 필터와 같습니다.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded border-input" />
          전체
        </label>
        {SUPPORTED_CATEGORIES.map((category) => (
          <label key={category} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={values.includes(category)}
              onChange={() => toggle(category)}
              className="h-4 w-4 rounded border-input"
            />
            {category}
          </label>
        ))}
        {UNSUPPORTED_CATEGORIES.map((category) => (
          <Tooltip key={category}>
            <TooltipTrigger asChild>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-not-allowed">
                <input type="checkbox" checked={false} disabled className="h-4 w-4 rounded border-input" />
                {category}
              </label>
            </TooltipTrigger>
            <TooltipContent>
              {category === "민간"
                ? "민간 낙찰정보는 나라장터가 아닌 별도 API(누리장터) 등록이 필요해 아직 지원하지 않습니다."
                : "나라장터 API에서 별도로 구분되지 않아 아직 지원하지 않습니다."}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

// 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대
// 입찰싸이트도 선택하면 검색할 수 있는 싸이트로 업그레이드"): 매일 자동 검색 +
// 수동 검색 모두의 대상 사이트. "나라장터"는 항상 켜져 있고 끌 수 없다(체크박스
// 비활성화). "LH"는 선택. "D2B"(군대)는 아직 API 연동이 없어 비활성화 표시만
// 한다 — WorkCategoryPicker의 UNSUPPORTED_CATEGORIES와 같은 패턴.
const SELECTABLE_SOURCES = ["LH"] as const;
const UNSUPPORTED_SOURCES = ["D2B(군대)"] as const;

function SiteSourcePicker({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const toggle = (source: string) => {
    if (values.includes(source)) onChange(values.filter((item) => item !== source));
    else onChange([...values, source]);
  };

  return (
    <div className="space-y-2">
      <Label>대상 사이트</Label>
      <p className="text-xs text-muted-foreground">
        매일 자동 검색과 "지금 실행" 모두 여기서 선택한 사이트를 대상으로 합니다. LH는 첨부파일 다운로드
        링크가 없어 공고명(제목)만으로 키워드를 찾고, 낙찰업체명/연락처는 제공하지 않습니다.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-not-allowed">
          <input type="checkbox" checked disabled className="h-4 w-4 rounded border-input" />
          나라장터 (항상 포함)
        </label>
        {SELECTABLE_SOURCES.map((source) => (
          <label key={source} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={values.includes(source)}
              onChange={() => toggle(source)}
              className="h-4 w-4 rounded border-input"
            />
            {source}
          </label>
        ))}
        {UNSUPPORTED_SOURCES.map((source) => (
          <Tooltip key={source}>
            <TooltipTrigger asChild>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-not-allowed">
                <input type="checkbox" checked={false} disabled className="h-4 w-4 rounded border-input" />
                {source}
              </label>
            </TooltipTrigger>
            <TooltipContent>아직 API 연동 전이라 지원하지 않습니다.</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

export default function Settings() {
  const settingsQuery = useGetSettings();
  const updateSettings = useUpdateSettings();
  const [matchKeywords, setMatchKeywords] = useState<string[]>([]);
  const [workTypeKeywords, setWorkTypeKeywords] = useState<string[]>([]);
  const [workCategories, setWorkCategories] = useState<string[]>([]);
  const [minEstimatedPrice, setMinEstimatedPrice] = useState("");
  const [maxEstimatedPrice, setMaxEstimatedPrice] = useState("");
  // 개선(2026-09-15 UX 리뷰): 다른 금액 필드는 비우면 "제한 없음"인데 이
  // 필드만 항상 숫자(0)를 넣어야 해서 같은 화면 안에서 입력 규칙이 달랐다.
  // 저장 시 빈 값은 그대로 0(=제한 없음)으로 보내는 동작은 유지하되(아래
  // handleSave), 화면에서는 다른 금액 필드처럼 비어 있으면 "제한 없음"으로
  // 보이게 통일한다.
  const [minBudgetAmount, setMinBudgetAmount] = useState("");
  const [notificationEmails, setNotificationEmails] = useState<string[]>([]);
  const [enabledSources, setEnabledSources] = useState<string[]>(["나라장터"]);
  const [secondaryKeywords, setSecondaryKeywords] = useState<string[]>([]);
  const [secondaryMinAwardAmount, setSecondaryMinAwardAmount] = useState("");
  const [secondaryMaxAwardAmount, setSecondaryMaxAwardAmount] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setMatchKeywords(settingsQuery.data.matchKeywords);
    setWorkTypeKeywords(settingsQuery.data.workTypeKeywords);
    setWorkCategories(settingsQuery.data.workCategories);
    setMinEstimatedPrice(settingsQuery.data.minEstimatedPrice != null ? String(settingsQuery.data.minEstimatedPrice) : "");
    setMaxEstimatedPrice(settingsQuery.data.maxEstimatedPrice != null ? String(settingsQuery.data.maxEstimatedPrice) : "");
    setMinBudgetAmount(settingsQuery.data.minBudgetAmount ? String(settingsQuery.data.minBudgetAmount) : "");
    setNotificationEmails(settingsQuery.data.notificationEmails);
    setEnabledSources(settingsQuery.data.enabledSources);
    setSecondaryKeywords(settingsQuery.data.secondaryKeywords);
    setSecondaryMinAwardAmount(
      settingsQuery.data.secondaryMinAwardAmount != null ? String(settingsQuery.data.secondaryMinAwardAmount) : "",
    );
    setSecondaryMaxAwardAmount(
      settingsQuery.data.secondaryMaxAwardAmount != null ? String(settingsQuery.data.secondaryMaxAwardAmount) : "",
    );
  }, [settingsQuery.data]);

  // 요구사항(설정 저장 오류 명확화, 2026-09-09): 서버까지 갔다가 400으로
  // 튕기지 않도록, 저장이 반드시 실패할 상태(필수 필드가 비어있음)를 미리
  // 감지해 저장 버튼 자체를 막고 이유를 화면에 보여준다.
  const matchKeywordsEmpty = matchKeywords.length === 0;
  const workCategoriesEmpty = workCategories.length === 0;
  const canSave = !matchKeywordsEmpty && !workCategoriesEmpty;

  // 개선(2026-09-15 UX 리뷰): 1차/2차 키워드가 서로 다른 조건을 완전히
  // 우회하는 구조라 조건을 바꿨을 때 결과가 얼마나 달라질지 저장 전에는 알
  // 방법이 없었다. 완전히 새로 스캔하는 건 API 한도를 쓰므로, 대신 "최근에
  // 이미 찾아둔 리드 중 지금 화면의(아직 저장 안 한) 조건에도 해당하는 건수"를
  // 계산해서 참고용으로 보여준다 — 조건을 완화한 경우 실제로는 더 많은 리드가
  // 나올 수 있으므로 어디까지나 참고용 신호다.
  const previewQuery = useListMatches(
    { limit: 300 },
    { query: { queryKey: getListMatchesQueryKey({ limit: 300 }) } },
  );
  const previewMatches = previewQuery.data?.matches ?? [];
  const previewCount = useMemo(() => {
    const matchesSecondary = (match: AwardedMatch) => {
      if (secondaryKeywords.length === 0 || !match.noticeName) return false;
      const titleHit = secondaryKeywords.some((kw) => match.noticeName!.includes(kw));
      if (!titleHit) return false;
      // daily-scan.ts와 동일하게: LH는 실제 낙찰금액이 없어 기초금액(예산)을
      // 대신 비교하고, 나라장터는 실제 낙찰금액(awardAmount)을 비교한다.
      const amount = match.source === "LH" ? match.budgetAmount : (match.awardAmount ?? match.budgetAmount);
      if (amount == null) return false;
      const minOk = secondaryMinAwardAmount.trim() === "" || amount >= Number(secondaryMinAwardAmount);
      const maxOk = secondaryMaxAwardAmount.trim() === "" || amount <= Number(secondaryMaxAwardAmount);
      return minOk && maxOk;
    };
    const matchesPrimary = (match: AwardedMatch) => {
      if (match.source !== "LH" && !workCategories.includes(match.workCategory ?? "")) return false;
      if (!match.matchedKeyword || !matchKeywords.includes(match.matchedKeyword)) return false;
      const estimated = match.estimatedAmount ?? null;
      if (minEstimatedPrice.trim() !== "" && (estimated == null || estimated < Number(minEstimatedPrice))) {
        return false;
      }
      if (maxEstimatedPrice.trim() !== "" && (estimated == null || estimated > Number(maxEstimatedPrice))) {
        return false;
      }
      // 요구사항(2026-09-24 사용자 요청: "규모는 예산이 아니라 낙찰가로
      // 변경하자. 검색하는 모든건 낙찰건만 대상이니까 그게 정확할것
      // 같아"): daily-scan.ts의 "최소 공사 규모" 판정과 동일하게, 낙찰금액이
      // 있으면 예산보다 우선한다.
      const budgetFloor = match.awardAmount ?? match.budgetAmount ?? 0;
      if (budgetFloor < (Number(minBudgetAmount) || 0)) return false;
      return true;
    };
    return previewMatches.filter(
      (match) => enabledSources.includes(match.source) && (matchesSecondary(match) || matchesPrimary(match)),
    ).length;
  }, [
    previewMatches,
    enabledSources,
    workCategories,
    matchKeywords,
    minEstimatedPrice,
    maxEstimatedPrice,
    minBudgetAmount,
    secondaryKeywords,
    secondaryMinAwardAmount,
    secondaryMaxAwardAmount,
  ]);

  const handleSave = () => {
    if (!canSave) return;
    setSaved(false);
    updateSettings.mutate(
      {
        data: {
          matchKeywords,
          workTypeKeywords,
          // SUPPORTED_CATEGORIES가 서버 스키마의 enum과 동일한 4개 값이므로 안전한 캐스팅이다.
          workCategories: workCategories as AppSettingsInputWorkCategoriesItem[],
          minEstimatedPrice: minEstimatedPrice.trim() === "" ? null : Number(minEstimatedPrice),
          maxEstimatedPrice: maxEstimatedPrice.trim() === "" ? null : Number(maxEstimatedPrice),
          minBudgetAmount: Number(minBudgetAmount) || 0,
          notificationEmails,
          // SELECTABLE_SOURCES ∪ 나라장터가 서버 스키마의 enum과 동일한 값이므로 안전한 캐스팅이다.
          enabledSources: enabledSources as AppSettingsInputEnabledSourcesItem[],
          secondaryKeywords,
          secondaryMinAwardAmount: secondaryMinAwardAmount.trim() === "" ? null : Number(secondaryMinAwardAmount),
          secondaryMaxAwardAmount: secondaryMaxAwardAmount.trim() === "" ? null : Number(secondaryMaxAwardAmount),
        },
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> 불러오는 중...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>자동 검색 설정</CardTitle>
          <CardDescription>
            매일 오전 7시(KST) 자동 검색에 사용되는 조건입니다. 저장하면 다음 실행부터 바로 적용됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-3">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">검색 대상 사이트</span>
          </div>
          <SiteSourcePicker values={enabledSources} onChange={setEnabledSources} />
        </CardContent>
      </Card>

      {/* 개선(2026-09-23 UI 정리 요청: "설정화면이 너무 복잡하게 되어있네.
      보기쉽고 알기쉽게 ui를 정리하자"): 예전에는 모든 필드가 카드 하나에 순서
      없이 쭉 나열돼 있었다. 실제 동작 순서(업무구분 → 추정가격/공사규모 →
      키워드)에 맞춰 "1차 조건" 카드로 묶어 흐름을 보이게 했다 — 필드·검증·
      저장 로직은 전혀 바뀌지 않았다. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">1차 조건 (첨부파일 내용 검색)</CardTitle>
          </div>
          <CardDescription>
            아래 조건(업무구분 → 추정가격/공사규모)으로 전일 낙찰 공고를 1차로 찾은 뒤, 그 공고의 품목 중
            "검색 키워드"와 일치하는 것이 있으면 영업 리드로 등록합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <WorkCategoryPicker values={workCategories} onChange={setWorkCategories} />

          <Separator />

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="minEstimatedPrice">추정가격 최소 (원)</Label>
                <Input
                  id="minEstimatedPrice"
                  type="number"
                  min={0}
                  placeholder="제한 없음"
                  value={minEstimatedPrice}
                  onChange={(event) => setMinEstimatedPrice(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxEstimatedPrice">추정가격 최대 (원)</Label>
                <Input
                  id="maxEstimatedPrice"
                  type="number"
                  min={0}
                  placeholder="제한 없음"
                  value={maxEstimatedPrice}
                  onChange={(event) => setMaxEstimatedPrice(event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              비워두면 추정가격으로는 거르지 않습니다. 추정가격이 공개되지 않은 공고는 아래 "최소 공사 규모"
              기준으로만 판단합니다.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="minBudget">최소 공사 규모 (원)</Label>
            <p className="text-xs text-muted-foreground">
              이 금액 미만인 공고는 제외합니다. 낙찰금액이 있으면 낙찰금액으로, 없으면(LH 등) 예산으로 판단합니다
              {/* 요구사항(2026-09-24: "규모는 예산이 아니라 낙찰가로 변경하자. 검색하는 모든건 낙찰건만
              대상이니까 그게 정확할것 같아") — 낙찰금액을 우선 기준으로 삼도록 설명 문구를 갱신 */}
              . 비워두면(제한 없음) 이 조건으로는 거르지 않습니다. 참고용 기본값: 50,000,000원.
            </p>
            <Input
              id="minBudget"
              type="number"
              min={0}
              placeholder="제한 없음"
              value={minBudgetAmount}
              onChange={(event) => setMinBudgetAmount(event.target.value)}
            />
          </div>

          <Separator />

          <TagEditor
            label="검색 키워드 (= 키워드1, 찾을 품목, 첨부파일 내용)"
            description="1차로 찾은 공고의 첨부파일(내역서/시방서 등)에서 이 키워드(품목)가 발견되면 리드로 등록합니다. 기본값: 부직포"
            values={matchKeywords}
            onChange={setMatchKeywords}
            required
            emptyHint="최소 1개 이상 입력해야 합니다. 비워두면 저장할 수 없습니다 (비워도 '전체 허용'이 아니라 아무 공고도 매칭되지 않기 때문입니다)."
          />

          <TagEditor
            label="업무구분(공종) 키워드 — 공사에만 적용"
            description="공사 공고의 공종이 이 키워드 중 하나를 포함해야 검색 대상이 됩니다. 비워두면 모든 공종을 검색합니다. (물품/용역 공고에는 적용되지 않습니다)"
            values={workTypeKeywords}
            onChange={setWorkTypeKeywords}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">2차 조건 — 사용자지정 키워드 (선택)</CardTitle>
          </div>
          <CardDescription>
            위 "검색 키워드"(= 키워드1, 첨부파일 내용 검색)가 이 공고에서 매칭되지 않았을 때만 적용되는 별도
            조건입니다. 여기 등록한 키워드 중 하나라도(OR) 공고 제목에 있고, 아래 "낙찰금액" 범위 안이면(업무구분/
            추정가격/최소 공사 규모와 상관없이) "사용자지정"으로 리드 등록합니다. 키워드1이 이미 매칭된 공고는
            (키워드1 리드로 이미 목록에 뜨므로) 이 조건으로 중복 등록되지 않습니다. 결과 목록·메일에는 실제 매칭된
            키워드 대신 "사용자지정"으로 표시되고, 해당 공고의 첨부파일은 (내용 검색 없이) 전부 내려받아 함께
            첨부합니다. 비워두면 이 조건은 사용하지 않습니다. 권장: 낙찰금액 최소를 1,000,000,000(10억)으로 설정.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TagEditor
            label="사용자지정 키워드 (= 키워드2)"
            description="공고 제목만으로 매칭합니다(첨부파일 내용 검색 없음). 자세한 조건은 위 설명 참고."
            values={secondaryKeywords}
            onChange={setSecondaryKeywords}
            emptyHint="비어 있으면 사용자지정 조건을 사용하지 않습니다."
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="secondaryMinAwardAmount">낙찰금액 최소 (원)</Label>
              <Input
                id="secondaryMinAwardAmount"
                type="number"
                min={0}
                placeholder="제한 없음 (권장: 1000000000 = 10억)"
                value={secondaryMinAwardAmount}
                onChange={(event) => setSecondaryMinAwardAmount(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="secondaryMaxAwardAmount">낙찰금액 최대 (원)</Label>
              <Input
                id="secondaryMaxAwardAmount"
                type="number"
                min={0}
                placeholder="제한 없음"
                value={secondaryMaxAwardAmount}
                onChange={(event) => setSecondaryMaxAwardAmount(event.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            LH는 실제 낙찰금액을 제공하지 않아, LH 공고에는 이 범위를 기초금액(예산)과 비교합니다. LH는 첨부파일
            다운로드 링크를 제공하지 않아 제목 매칭만으로 리드를 남기고 첨부파일은 붙지 않습니다.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">알림 이메일</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <EmailListEditor values={notificationEmails} onChange={setNotificationEmails} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-4">
          {/* 개선(2026-09-15 UX 리뷰, 항목 10) — 저장하기 전에 지금 화면의
          조건이면 결과가 대략 얼마나 될지 미리 보여준다. 실제로는 최근에 이미
          찾아둔 리드 중 지금 조건에도 해당하는 건수를 세는 것이라, 조건을
          완화한 경우 실제 결과는 이보다 많아질 수 있다 — 그래서 "참고용"임을
          분명히 밝힌다. */}
          <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <ListFilter className="h-4 w-4 mt-0.5 shrink-0" />
            {previewQuery.isLoading ? (
              <span>미리보기 계산 중...</span>
            ) : (
              <span>
                지금 화면의 조건이라면, 최근 저장된 리드 {previewMatches.length}건 중{" "}
                <span className="font-semibold text-foreground">{previewCount}건</span>이 해당됩니다. (저장 전
                참고용 — 조건을 완화하면 실제로는 이보다 많아질 수 있습니다.)
              </span>
            )}
          </div>

          {!canSave ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {matchKeywordsEmpty ? "검색 키워드를 최소 1개 이상 입력해야 저장할 수 있습니다." : "업무구분을 최소 1개 이상 선택해야 저장할 수 있습니다."}
            </div>
          ) : null}
          {updateSettings.isError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {updateSettings.error instanceof Error ? updateSettings.error.message : "저장에 실패했습니다."}
            </div>
          ) : null}
          {saved && !updateSettings.isPending ? (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 className="h-4 w-4" /> 저장되었습니다.
            </div>
          ) : null}

          <Button onClick={handleSave} disabled={updateSettings.isPending || !canSave}>
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            저장
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
