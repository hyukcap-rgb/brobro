import { useRef, useState } from "react";
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
  MapPin, Phone, CalendarSearch, Search, Paperclip, X, ListFilter, Package,
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

// 요구사항(2026-09-10 사용자 요청: "검색결과가 쌓이게 되면 리스트가 보기
// 어려워질꺼같아... 검색 결과는 날짜가 바뀌면 자동으로 삭제 해줘"): 데이터
// 자체는 지우지 않고 그대로 보존한다(엑셀 다운로드로 언제든 전체 누적 내역을
// 받을 수 있음) — 대신 화면의 "일일 검색 결과" 카드에는 오늘(KST) 생성된
// 결과만 걸러서 보여준다. 이 값은 렌더링마다 새로 계산되므로 자정이 지나면
// (matchesQuery가 30초마다 다시 불러오는 시점에) 화면이 자동으로 갱신된다.
function getKstDateKeyFromIso(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function getKstTodayKey(): string {
  return getKstDateKeyFromIso(new Date().toISOString());
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR");
  } catch {
    return value;
  }
}

// 요구사항(2026-09-10 사용자 요청: "대상일이 2일 이상일때 옆으로 나열되는게
// 불편해. 9/3~5일 이렇게 표시해줘"): "지금 실행"은 최근 3일을 항상 재확인하므로
// targetDates가 여러 날짜로 찍히는데, 이를 "2026-09-07, 2026-09-08,
// 2026-09-09"처럼 풀어 쓰면 한눈에 읽기 어렵다. 날짜가 하나면 "9/7"처럼, 연속된
// 여러 날짜면 "9/7~9"처럼, 달이 걸치면 "9/29~10/1"처럼 압축해서 보여준다.
function formatTargetDates(dates: string[]): string {
  if (dates.length === 0) return "-";
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const [, firstMonth, firstDay] = first.split("-").map(Number);
  const [, lastMonth, lastDay] = last.split("-").map(Number);
  if (sorted.length === 1 || first === last) {
    return `${firstMonth}/${firstDay}`;
  }
  if (firstMonth === lastMonth) {
    return `${firstMonth}/${firstDay}~${lastDay}`;
  }
  return `${firstMonth}/${firstDay}~${lastMonth}/${lastDay}`;
}

function formatAmount(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${value.toLocaleString("ko-KR")}원`;
}

function contactSourceLabel(source: string | null | undefined): string | null {
  if (source === "government") return "정부 낙찰기록";
  if (source === "attachment") return "첨부파일에서 추출";
  // 요구사항(2026-09-11 사용자 요청): 조달청 "나라장터 사용자정보 서비스"로
  // 사업자등록번호 기준 정확 매칭 조회한 값이라 포털/웹 검색보다 신뢰도가
  // 높음을 구분해 보여준다.
  if (source === "registry") return "조달청 등록정보 보강";
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

  // 요구사항(2026-09-10 사용자 요청 4: "자동검색에서 매칭건수를 클릭하면 위에
  // 검색결과에 해당 검색결과를 보여주는 방식으로 수정하자"): 실행 기록의 매칭
  // 건수를 클릭하면 그 실행(scanRunId)에서 나온 결과만 위 카드에 걸러서
  // 보여준다. 선택을 해제하면 요구사항 3의 기본값(오늘 결과만)으로 돌아간다.
  const [selectedScanRunId, setSelectedScanRunId] = useState<number | null>(null);
  const selectedScan = selectedScanRunId != null ? (scans.find((scan) => scan.id === selectedScanRunId) ?? null) : null;
  const todayKey = getKstTodayKey();
  const visibleMatches =
    selectedScanRunId != null
      ? matches.filter((match) => match.scanRunId === selectedScanRunId)
      : matches.filter((match) => getKstDateKeyFromIso(match.createdAt) === todayKey);
  const matchesCardRef = useRef<HTMLDivElement>(null);
  const handleSelectScanRun = (scanId: number) => {
    setSelectedScanRunId((current) => (current === scanId ? null : scanId));
    matchesCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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

  // 요구사항(2026-09-10 사용자 문의: "대상일 기간이 이상하게 나오는데?"): "지금
  // 실행" 버튼은 이름과 달리 어제 하루만 검색하지 않는다 — 나라장터 최종낙찰자
  // 확정이 개찰일 이후에도 며칠씩 늦게 반영되는 것을 놓치지 않도록, 2026-09-08
  // 요청에 따라 매번 최근 3일(RECHECK_WINDOW_DAYS, daily-scan.ts 참고)을 항상
  // 다시 확인한다. 그래서 화면의 "대상일"에 날짜가 여러 개 찍히는 것이 정상
  // 동작이다 — 버튼 이름을 실제 동작에 맞게 명확히 표기한다(아래 라벨 참고).
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
      <Card ref={matchesCardRef}>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>일일 검색 결과</CardTitle>
            <CardDescription>
              {selectedScan ? (
                <>
                  <ListFilter className="inline h-3.5 w-3.5 mr-1 align-text-bottom" />
                  실행 기록 하나(대상일 {formatTargetDates(selectedScan.targetDates)}, {formatDateTime(selectedScan.startedAt)})의
                  매칭 결과만 걸러서 보고 있습니다. 오른쪽의 "필터 해제"를 누르면 오늘 결과로 돌아갑니다.
                </>
              ) : (
                <>
                  매일 오전 7시 자동 검색 결과가 여기 누적됩니다. 화면에는 오늘 찾은 결과만 표시되고, 지난 결과는 지워지지
                  않고 계속 쌓입니다 — 지난 결과 전체는 "엑셀 다운로드"로 받아보거나, 아래 "자동검색" 실행 기록의 매칭
                  건수를 클릭해 확인할 수 있습니다. 현장사무소로 직접 연락해 영업하세요.
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            {selectedScan ? (
              <Button variant="outline" size="sm" onClick={() => setSelectedScanRunId(null)}>
                <X className="h-4 w-4" /> 필터 해제
              </Button>
            ) : null}
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
          ) : visibleMatches.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              {selectedScan
                ? "이 실행에서 매칭된 결과가 없습니다."
                : "오늘 매칭된 결과가 아직 없습니다. 자동 검색은 매일 오전 7시에 실행됩니다."}
            </div>
          ) : (
            // 요구사항(2026-09-10 사용자 요청: "일일 검색결과가 박스형으로
            // 되어 있어서 너무 보기 힘들어. 엑셀형으로 한줄 형태로 나타내줘"):
            // 카드 그리드 대신 한 행 = 한 매칭 결과인 표 형태로 바꿔서 여러
            // 건을 한 화면에서 스캔하며 비교하기 쉽게 한다.
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>공고번호</TableHead>
                    <TableHead>낙찰일</TableHead>
                    <TableHead>키워드 · 수량</TableHead>
                    <TableHead>낙찰자</TableHead>
                    <TableHead>규모</TableHead>
                    <TableHead>주소</TableHead>
                    <TableHead>연락처</TableHead>
                    <TableHead>출처</TableHead>
                    <TableHead>첨부파일</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMatches.map((match) => (
                    <TableRow key={match.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{match.noticeNumber}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{match.awardDate ?? "-"}</TableCell>
                      {/* 요구사항(2026-09-10 사용자 요청: "검색 결과에
                      키워드/수량을 꼭 함께 넣어줘. 이게 가장 중요해. 이걸
                      한눈에 보고 해당 업체에 연락을 하려는게 이 싸이트의
                      핵심이야"): 어떤 자재가 얼마나 필요한지를 가장 먼저
                      눈에 띄게 보여준다. */}
                      <TableCell className="whitespace-nowrap">
                        {match.matchedKeyword ? (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-sm font-semibold text-primary">
                            <Package className="h-4 w-4 shrink-0" />
                            <span>{match.matchedKeyword}</span>
                            {match.quantityText ? <span>· {match.quantityText}</span> : null}
                          </span>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="font-medium whitespace-nowrap">
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
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatAmount(match.budgetAmount ?? match.awardAmount)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[220px]">
                        <div className="flex items-start gap-1.5">
                          <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span className="truncate" title={match.bidderAddress ?? undefined}>
                            {match.bidderAddress ?? "주소 미확인"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
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
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {contactSourceLabel(match.contactSource) ? (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {contactSourceLabel(match.contactSource)}
                          </Badge>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      {/* 요구사항(2026-09-10 사용자 요청 1, 2: "키워드가 나온
                      파일은 다운로드 해서 우리 서버에 저장해줘" / "저장된
                      파일을 열어볼 수 있도록 링크를 만들어줘"): 첨부파일은
                      daily-scan.ts가 매칭 시점에 이미 서버(SCAN_ROOT)에
                      저장해두고 있었다 — 화면에서 열어볼 수 있는 링크가
                      없었을 뿐이라 여기에 추가한다. */}
                      <TableCell className="max-w-[200px]">
                        {match.attachmentFileName ? (
                          <div className="flex items-center gap-1.5 text-xs">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            {match.attachmentDeletedAt ? (
                              <span className="text-muted-foreground truncate" title={match.attachmentFileName}>
                                {match.attachmentFileName} (보관기간 경과로 삭제됨)
                              </span>
                            ) : (
                              <a
                                href={`/api/matches/${match.id}/attachment`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline truncate"
                                title="첨부파일 열기"
                              >
                                {match.attachmentFileName}
                              </a>
                            )}
                          </div>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>자동검색</CardTitle>
            <CardDescription>
              매일 오전 7시(KST) 자동으로 전일 공고를 검색합니다. "지금 실행"은 낙찰 확정이 며칠씩 늦어지는
              경우를 놓치지 않도록 최근 3일을 항상 다시 확인합니다. 아래 기록은 최근 7건만 보관되고 이전
              기록은 자동 삭제됩니다.
            </CardDescription>
          </div>
          <Button size="sm" onClick={handleRunNow} disabled={triggerScan.isPending} className="shrink-0">
            {triggerScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            지금 실행 (최근 3일 재확인)
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 요구사항(2026-09-11 사용자 요청: "이 기간으로 검색과 지금 실행은
          중복되서 헷갈려"): 두 버튼은 동작이 다르다 — 위 "지금 실행"은 화면의
          날짜 지정과 무관하게 항상 최근 3일 + 놓친 날짜를 자동으로 채워
          재확인하는 정기 점검용이고, 아래 "이 기간으로 검색"은 사용자가 지정한
          과거의 특정 기간만 자동 보정 없이 정확히 재검색하는 별개 기능이다.
          같은 툴바에 나란히 있어 헷갈렸던 것이므로 동작은 그대로 두고
          레이아웃만 분리해 두 기능이 다르다는 것을 명확히 한다. */}
          {/* 요구사항(2026-09-11 사용자 요청: "기간 지정하는 기간 또한 낙찰일을
          기준으로 검색하라는 뜻이야" / "낙찰자가 확정된 건만 검색해야 헷갈리지
          않는데"): 나라장터 API 자체는 개찰일 기준으로만 조회되지만, "이 기간으로
          검색"은 지정 기간보다 더 이전까지 넓게 훑은 뒤 실제 낙찰일(확정일)이
          그 기간 안에 드는 건만 서버에서 걸러서 돌려준다(daily-scan.ts
          executeScanRun 참고). 아직 낙찰자가 확정되지 않은 공고는 결과에서
          제외된다. */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <div className="text-sm font-medium">기간 지정 재검색 (낙찰일 기준)</div>
            <p className="text-xs text-muted-foreground">
              위 "지금 실행"과 별개로, 지정한 기간 안에 낙찰자가 확정된 공고만 낙찰일 기준으로
              검색합니다(개찰일이 아닌 낙찰일 기준이며, 시작일=종료일이면 하루만 검색. 아직
              낙찰자가 확정되지 않은 건은 결과에서 제외됩니다).
            </p>
            <div className="flex items-center gap-2 flex-wrap">
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
            </div>
            {rangeInvalid && startDate && endDate ? (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> 종료일이 시작일보다 빠를 수 없습니다.
              </div>
            ) : null}
          </div>
          {scans.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">실행 기록이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>상태</TableHead>
                    <TableHead>대상일</TableHead>
                    <TableHead>낙찰 건수</TableHead>
                    <TableHead>확인 건수</TableHead>
                    <TableHead>매칭 건수</TableHead>
                    <TableHead>시작 시각</TableHead>
                    <TableHead>오류</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((scan) => (
                    <TableRow key={scan.id} className={scan.id === selectedScanRunId ? "bg-muted/50" : undefined}>
                      <TableCell>{scanStatusBadge(scan.status)}</TableCell>
                      <TableCell className="text-xs">{formatTargetDates(scan.targetDates)}</TableCell>
                      <TableCell>{scan.awardsFound}</TableCell>
                      <TableCell>{scan.candidatesChecked}</TableCell>
                      <TableCell className="font-medium">
                        {/* 요구사항(2026-09-10 사용자 요청 4: "자동검색에서
                        매칭건수를 클릭하면 위에 검색결과에 해당 검색결과를
                        보여주는 방식으로 수정하자") */}
                        {scan.matchesFound > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleSelectScanRun(scan.id)}
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                            title="이 실행의 매칭 결과만 위에서 보기"
                          >
                            <ListFilter className="h-3 w-3" />
                            {scan.matchesFound}
                          </button>
                        ) : (
                          scan.matchesFound
                        )}
                      </TableCell>
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
