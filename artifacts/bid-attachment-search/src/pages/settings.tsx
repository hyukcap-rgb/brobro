import { useEffect, useState } from "react";
import { useGetSettings, useUpdateSettings, type AppSettingsInputWorkCategoriesItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, CheckCircle2, Loader2, Plus, X } from "lucide-react";

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

export default function Settings() {
  const settingsQuery = useGetSettings();
  const updateSettings = useUpdateSettings();
  const [matchKeywords, setMatchKeywords] = useState<string[]>([]);
  const [workTypeKeywords, setWorkTypeKeywords] = useState<string[]>([]);
  const [workCategories, setWorkCategories] = useState<string[]>([]);
  const [minEstimatedPrice, setMinEstimatedPrice] = useState("");
  const [maxEstimatedPrice, setMaxEstimatedPrice] = useState("");
  const [minBudgetAmount, setMinBudgetAmount] = useState("50000000");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setMatchKeywords(settingsQuery.data.matchKeywords);
    setWorkTypeKeywords(settingsQuery.data.workTypeKeywords);
    setWorkCategories(settingsQuery.data.workCategories);
    setMinEstimatedPrice(settingsQuery.data.minEstimatedPrice != null ? String(settingsQuery.data.minEstimatedPrice) : "");
    setMaxEstimatedPrice(settingsQuery.data.maxEstimatedPrice != null ? String(settingsQuery.data.maxEstimatedPrice) : "");
    setMinBudgetAmount(String(settingsQuery.data.minBudgetAmount));
  }, [settingsQuery.data]);

  // 요구사항(설정 저장 오류 명확화, 2026-09-09): 서버까지 갔다가 400으로
  // 튕기지 않도록, 저장이 반드시 실패할 상태(필수 필드가 비어있음)를 미리
  // 감지해 저장 버튼 자체를 막고 이유를 화면에 보여준다.
  const matchKeywordsEmpty = matchKeywords.length === 0;
  const workCategoriesEmpty = workCategories.length === 0;
  const canSave = !matchKeywordsEmpty && !workCategoriesEmpty;

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
            아래 조건(업무구분 → 추정가격/공사규모)으로 전일 낙찰 공고를 1차로 찾은 뒤, 그 공고의 품목 중
            "검색 키워드"와 일치하는 것이 있으면 영업 리드로 등록합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <WorkCategoryPicker values={workCategories} onChange={setWorkCategories} />

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
          <p className="text-xs text-muted-foreground -mt-4">
            비워두면 추정가격으로는 거르지 않습니다. 추정가격이 공개되지 않은 공고는 아래 "최소 공사 규모"
            기준으로만 판단합니다.
          </p>

          <TagEditor
            label="검색 키워드 (= 찾을 품목, 첨부파일 내용)"
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
          <div className="space-y-2">
            <Label htmlFor="minBudget">최소 공사 규모 (원)</Label>
            <p className="text-xs text-muted-foreground">
              이 금액 미만인 공고는 제외합니다. 추정가격이 없는 공고를 걸러내는 안전장치로도 쓰입니다. 현재 설정:{" "}
              {minBudgetAmount.trim() === "" || Number.isNaN(Number(minBudgetAmount))
                ? "미입력"
                : `${Number(minBudgetAmount).toLocaleString("ko-KR")}원`}{" "}
              (기본값 50,000,000원)
            </p>
            <Input
              id="minBudget"
              type="number"
              min={0}
              value={minBudgetAmount}
              onChange={(event) => setMinBudgetAmount(event.target.value)}
            />
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
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            저장
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
