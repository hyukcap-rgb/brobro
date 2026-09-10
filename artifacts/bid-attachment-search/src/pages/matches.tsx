import { useState } from "react";
import {
  useListMatches,
  useListScans,
  useTriggerScan,
  getListMatchesQueryKey,
  getListScansQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Download, Loader2, PlayCircle, RefreshCw, AlertCircle, CheckCircle2, XCircle, Clock,
  MapPin, Phone, CalendarSearch, Search,
} from "lucide-react";

// KST(Asia/Seoul) 기준 "어제" 날짜를 YYYY-MM-DD로 반환한다. 서버의 자동 검색과
// 동일한 기준일을 날짜 입력의 기본값으로 보여주기 위함 — 브라우저 로컬 시간대와
// 무관하게 항상 KST로 계산한다.
function getKstYesterdayKey(): string {
  const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR");
  } catch {
    return value;
  }
}

function formatAmount(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${value.toLocaleString("ko-KR")}원`;
}

function contactSourceLabel(source: string | null | undefined): string | null {
  if (source === "government") return "정부 낙찰기록";
  if (source === "attachment") return "첨부파일에서 추출";
  if (source === "portal") return "포털 검색 보완";
  // 요구사항(전화번호 검색 보완, 2026-09-09): 네이버 웹문서/블로그 검색결과
  // 텍스트에서 정규식으로 뽑아낸 번호라 지역검색(portal)보다 정확도가 낮으므로
  // "추정"이라고 명시해 화면에서 신뢰도를 구분할 수 있게 한다.
  if (source === "web") return "웹 검색 추정(확인 필요)";
  return null;
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}

// 요구사항(전화번호 검색, 2026-09-09 사용자 리포트: "전화번호를 검색해서
// 보여줘"): 나라장터가 내려주는 전화번호는 "***********"처럼 개인정보
// 마스킹된 채로 오는 경우가 많다(daily-scan.ts의 isUsablePhone과 동일 기준).
// 마스킹된 값을 그대로 tel: 링크로 보여주면 아무 쓸모가 없으므로 "확인불가"로
// 취급하고, 그 옆에 다시 검색할 수 있는 버튼을 보여준다.
function isUsablePhone(phone: string | null | undefined): boolean {
  return Boolean(phone && !phone.includes("*"));
}

// 요구사항(2026-09-09 사용자 요청: "이름을 클릭하면 네이버 검색창을 새창으로
// 보여주고"): 나라장터가 내려주는 낙찰자 전화번호는 개인정보 보호를 위해
// 마스킹되어 있는 경우가 많아(daily-scan.ts의 isUsablePhone 참고) 자동으로도
// 못 찾을 때가 있다. 그럴 때 사용자가 직접 회사명으로 네이버에서 전화번호를
// 찾아볼 수 있도록 낙찰자명을 새 탭에서 열리는 네이버 검색 링크로 만든다.
function naverSearchHref(query: string): string {
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(`${query} 전화번호`)}`;
}

function scanStatusBadge(status: string) {
  if (status === "completed") {
    return (
      <Badge variant="outline" className="gap-1 text-green-700 border-green-300">
        <CheckCircle2 className="h-3 w-3" /> 완료
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-destructive border-destructive/40">
        <XCircle className="h-3 w-3" /> 실패
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3 w-3" /> 진행중
    </Badge>
  );
}

export default function Matches() {
  const queryClient = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // 요구사항(기간 검색, 2026-09-09 사용자 요청: "이날짜로 검색은 검색 기간을
  // 내가 설정하는거야... 지금은 시작 날짜만 있는거잖아"): 시작일 하나만 있던
  // 것을 시작일~종료일 기간으로 바꾼다. 기본값은 둘 다 "어제"(하루짜리 구간)로
  // 시작해, 기존처럼 하루만 재검색하고 싶으면 그대로 버튼만 누르면 된다.
  const [startDate, setStartDate] = useState<string>(() => getKstYesterdayKey());
  const [endDate, setEndDate] = useState<string>(() => getKstYesterdayKey());
  const matchesQuery = useListMatches(
    { limit: 500 },
    { query: { queryKey: getListMatchesQueryKey({ limit: 500 }), refetchInterval: 30_000 } },
  );
  // 요구사항(2026-09-10 사용자 요청: "검색 list 가 오래 쌓이면 아래로 너무
  // 내려감... 최근 7개만 보여주고 나머지는 다 자동삭제해줘"): 서버가 최근 7건만
  // 남기고 나머지는 자동 삭제하므로(daily-scan.ts의 pruneOldScanRuns 참고),
  // 화면에서도 그에 맞춰 최근 7건만 조회한다.
  const scansQuery = useListScans(
    { limit: 7 },
    { query: { queryKey: getListScansQueryKey({ limit: 7 }), refetchInterval: 15_000 } },
  );
  const triggerScan = useTriggerScan();

  const matches = matchesQuery.data?.matches ?? [];
  const scans = scansQuery.data?.scans ?? [];

  const runScan = (range?: { startDate: string; endDate: string }) => {
    triggerScan.mutate(
      { data: range ? range : {} },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListScansQueryKey({ limit: 7 }) });
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey({ limit: 500 }) });
            void queryClient.invalidateQueries({ queryKey: getListScansQueryKey({ limit: 7 }) });
          }, 20_000);
        },
      },
    );
  };

  const rangeInvalid = !startDate || !endDate || endDate < startDate;

  const handleRunNow = () => runScan();
  const handleRunForRange = () => {
    if (rangeInvalid) return;
    runScan({ startDate, endDate });
  };

  const [refreshingContactId, setRefreshingContactId] = useState<number | null>(null);
  const handleRefreshContact = async (id: number) => {
    setRefreshingContactId(id);
    try {
      await fetch(`/api/matches/${id}/refresh-contact`, { method: "POST", credentials: "include" });
    } finally {
      setRefreshingContactId(null);
      void matchesQuery.refetch();
    }
  };

  const handleDownload = async (url: string, fileName: string) => {
    setDownloadError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("다운로드에 실패했습니다.");
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "다운로드에 실패했습니다.");
    }
  };

  return (
    <div className="mx-auto max-w-7xl p-6 space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>일일 검색 결과</CardTitle>
            <CardDescription>
              매일 오전 7시 자동 검색 결과가 여기 누적됩니다. 현장사무소로 직접 연락해 영업하세요.
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => void matchesQuery.refetch()}>
              <RefreshCw className="h-4 w-4" /> 새로고침
            </Button>
            <Button
              size="sm"
              onClick={() => handleDownload("/api/matches/export.xlsx", "누적_낙찰검색결과.xlsx")}
            >
              <Download className="h-4 w-4" /> 엑셀 다운로드
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {downloadError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {downloadError}
            </div>
          ) : null}
          {matchesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중...
            </div>
          ) : matches.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              아직 매칭된 결과가 없습니다. 자동 검색은 매일 오전 7시에 실행됩니다.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {matches.map((match) => (
                <div key={match.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{match.noticeNumber}</span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{match.awardDate ?? "-"}</span>
                  </div>
                  <div className="font-medium leading-snug">
                    {match.bidderName ? (
                      <a
                        href={naverSearchHref(match.bidderName)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-primary"
                        title="네이버에서 전화번호 검색"
                      >
                        {match.bidderName}
                      </a>
                    ) : (
                      "낙찰자 미확인"
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    규모 {formatAmount(match.budgetAmount ?? match.awardAmount)}
                  </div>
                  <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{match.bidderAddress ?? "주소 미확인"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-sm">
                      <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {isUsablePhone(match.bidderPhone) ? (
                        <a href={telHref(match.bidderPhone!)} className="text-primary hover:underline">
                          {match.bidderPhone}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">
                          {match.bidderPhone ? "번호 비공개(마스킹)" : "연락처 미확인"}
                        </span>
                      )}
                      {!isUsablePhone(match.bidderPhone) ? (
                        <button
                          type="button"
                          onClick={() => void handleRefreshContact(match.id)}
                          disabled={refreshingContactId === match.id}
                          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50 shrink-0"
                          title="네이버에서 전화번호 다시 찾기"
                        >
                          {refreshingContactId === match.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Search className="h-3 w-3" />
                          )}
                          다시 찾기
                        </button>
                      ) : null}
                    </div>
                    {contactSourceLabel(match.contactSource) ? (
                      <Badge variant="outline" className="text-[10px] font-normal shrink-0">
                        {contactSourceLabel(match.contactSource)}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>자동검색</CardTitle>
            <CardDescription>
              매일 오전 7시(KST) 자동으로 전일 공고를 검색합니다. 필요하면 지금 바로 실행하거나, 원하는 기간을
              직접 지정해 다시 검색해볼 수 있습니다 (시작일=종료일이면 하루만 검색). 아래 기록은 최근 7건만
              보관되고 이전 기록은 자동 삭제됩니다.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="h-9 w-[150px]"
              aria-label="검색 시작일"
            />
            <span className="text-sm text-muted-foreground">~</span>
            <Input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="h-9 w-[150px]"
              aria-label="검색 종료일"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunForRange}
              disabled={triggerScan.isPending || rangeInvalid}
            >
              {triggerScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarSearch className="h-4 w-4" />}
              이 기간으로 검색
            </Button>
            <Button size="sm" onClick={handleRunNow} disabled={triggerScan.isPending}>
              {triggerScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
              지금 실행 (전일)
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rangeInvalid && startDate && endDate ? (
            <div className="flex items-center gap-2 text-sm text-destructive mb-3">
              <AlertCircle className="h-4 w-4" /> 종료일이 시작일보다 빠를 수 없습니다.
            </div>
          ) : null}
          {scans.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">실행 기록이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>상태</TableHead>
                    <TableHead>대상일</TableHead>
                    <TableHead>실행 방식</TableHead>
                    <TableHead>낙찰 건수</TableHead>
                    <TableHead>확인 건수</TableHead>
                    <TableHead>매칭 건수</TableHead>
                    <TableHead>시작 시각</TableHead>
                    <TableHead>오류</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((scan) => (
                    <TableRow key={scan.id}>
                      <TableCell>{scanStatusBadge(scan.status)}</TableCell>
                      <TableCell className="text-xs">{scan.targetDates.join(", ")}</TableCell>
                      <TableCell className="text-xs">{scan.triggerType === "manual" ? "수동" : "자동"}</TableCell>
                      <TableCell>{scan.awardsFound}</TableCell>
                      <TableCell>{scan.candidatesChecked}</TableCell>
                      <TableCell className="font-medium">{scan.matchesFound}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(scan.startedAt)}</TableCell>
                      <TableCell className="max-w-xs text-xs text-destructive">{scan.errorMessage ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
