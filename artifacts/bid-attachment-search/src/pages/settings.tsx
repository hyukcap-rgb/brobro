import { useEffect, useState } from "react";
import { useGetSettings, useUpdateSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, Loader2, Plus, X } from "lucide-react";

function TagEditor({
  label,
  description,
  values,
  onChange,
}: {
  label: string;
  description: string;
  values: string[];
  onChange: (values: string[]) => void;
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
        {values.length === 0 ? <span className="text-xs text-muted-foreground">(전체 허용, 필터 없음)</span> : null}
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

export default function Settings() {
  const settingsQuery = useGetSettings();
  const updateSettings = useUpdateSettings();
  const [matchKeywords, setMatchKeywords] = useState<string[]>([]);
  const [workTypeKeywords, setWorkTypeKeywords] = useState<string[]>([]);
  const [minBudgetAmount, setMinBudgetAmount] = useState("50000000");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setMatchKeywords(settingsQuery.data.matchKeywords);
    setWorkTypeKeywords(settingsQuery.data.workTypeKeywords);
    setMinBudgetAmount(String(settingsQuery.data.minBudgetAmount));
  }, [settingsQuery.data]);

  const handleSave = () => {
    setSaved(false);
    updateSettings.mutate(
      {
        data: {
          matchKeywords,
          workTypeKeywords,
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
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <TagEditor
            label="검색 키워드 (첨부파일 내용)"
            description="공고 첨부파일(내역서/시방서 등)에서 이 키워드가 발견되면 매칭됩니다. 기본값: 부직포"
            values={matchKeywords}
            onChange={setMatchKeywords}
          />
          <TagEditor
            label="업무구분(공종) 키워드"
            description="공고의 공종이 이 키워드 중 하나를 포함해야 검색 대상이 됩니다. 비워두면 모든 공종을 검색합니다."
            values={workTypeKeywords}
            onChange={setWorkTypeKeywords}
          />
          <div className="space-y-2">
            <Label htmlFor="minBudget">최소 공사 규모 (원)</Label>
            <p className="text-xs text-muted-foreground">이 금액 미만인 공사는 검색 대상에서 제외합니다. 기본값: 50,000,000원</p>
            <Input
              id="minBudget"
              type="number"
              min={0}
              value={minBudgetAmount}
              onChange={(event) => setMinBudgetAmount(event.target.value)}
            />
          </div>

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

          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            저장
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
