import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  useListMatches,
  useListScans,
  useTriggerScan,
  getListMatchesQueryKey,
  getListScansQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import {
  Download, Loader2, PlayCircle, RefreshCw, AlertCircle, CheckCircle2, XCircle, Clock,
  MapPin, Phone, CalendarSearch, Search, Paperclip, X, ListFilter, Package, Info,
  ChevronDown, ChevronRight, ChevronLeft, ArrowUp, ArrowDown, ArrowUpDown,
  Copy, Check,
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
// 불편해. 9/3~5일 이렇게 표시해줘"): 놓친 날짜를 자동으로 채우는 갭필이나
// "기간 지정 재검색"에서는 targetDates가 여러 날짜로 찍히는데, 이를
// "2026-09-07, 2026-09-08, 2026-09-09"처럼 풀어 쓰면 한눈에 읽기 어렵다.
// 날짜가 하나면 "9/7"처럼, 연속된 여러 날짜면 "9/7~9"처럼, 달이 걸치면
// "9/29~10/1"처럼 압축해서 보여준다.
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

// 요구사항(2026-09-12 사용자 요청: "공고번호는 복사하기 버튼만 놔두고 다
// 안보이게 해줘"): 표에서 공고번호 텍스트 자체는 더 이상 노출하지 않고,
// 필요할 때 눌러서 클립보드로 복사할 수 있는 버튼만 남긴다.
function CopyNoticeNumberButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error("Clipboard API 사용 불가");
      }
    } catch {
      // 클립보드 API를 쓸 수 없는 환경(비보안 컨텍스트 등)을 위한 대체 수단.
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        document.body.removeChild(textarea);
        return;
      }
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="공고번호 복사"
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground whitespace-nowrap"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          복사됨
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          복사
        </>
      )}
    </button>
  );
}

// 버그 수정(2026-09-15 UX 리뷰): status만 보고 초록 "완료" 배지를 달면,
// 공공데이터포털 한도초과 등으로 일부 공고를 확인하지 못한 실행도 똑같이
// "완료"로 보여서 리드 누락을 알아채기 어려웠다. errorMessage가 있는데
// status가 completed인 경우(=부분적으로만 확인됨)는 노란 "부분완료"로
// 구분한다.
function scanStatusBadge(scan: { status: string; errorMessage?: string | null }) {
  if (scan.status === "completed") {
    if (scan.errorMessage) {
      return (
        <Badge variant="outline" className="gap-1 text-amber-700 border-amber-300 bg-amber-50">
          <AlertCircle className="h-3 w-3" /> 부분완료
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 text-green-700 border-green-300">
        <CheckCircle2 className="h-3 w-3" /> 완료
      </Badge>
    );
  }
  if (scan.status === "failed") {
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
  // 요구사항(2026-09-13 사용자 요청: "히스토리는 계속 누적으로 남겨두고 다만
  // 10개까지 보여주고 페이지를 넘기는 방식으로 수정하자"): 예전에는 서버가
  // 최근 7건만 남기고 자동삭제했었지만(daily-scan.ts 참고, 지금은 제거), 이제
  // 기록은 전부 보존하고 화면에서 10건씩 페이지를 넘겨가며 본다.
  const SCAN_HISTORY_PAGE_SIZE = 10;
  const [scanPage, setScanPage] = useState(0);
  const scansQuery = useListScans(
    { limit: SCAN_HISTORY_PAGE_SIZE, offset: scanPage * SCAN_HISTORY_PAGE_SIZE },
    {
      query: {
        queryKey: getListScansQueryKey({ limit: SCAN_HISTORY_PAGE_SIZE, offset: scanPage * SCAN_HISTORY_PAGE_SIZE }),
        refetchInterval: 15_000,
        // 버그 수정(2026-09-15 테스트팀 QA에서 발견): offset이 바뀌는 순간
        // react-query가 잠시 data를 undefined로 돌려주는데, 아래 totalScanPages
        // 계산 effect가 그 틈에 "총 페이지 수 1"로 착각해 scanPage를 0으로
        // 되돌려버려 "다음" 버튼이 사실상 동작하지 않았다(요청은 나가지만 즉시
        // 취소됨). placeholderData로 이전 페이지 데이터를 유지해 그 틈을 없앤다.
        placeholderData: keepPreviousData,
      },
    },
  );
  const triggerScan = useTriggerScan();

  const matches = matchesQuery.data?.matches ?? [];
  const scans = scansQuery.data?.scans ?? [];
  const scansTotal = scansQuery.data?.total ?? 0;
  const totalScanPages = Math.max(1, Math.ceil(scansTotal / SCAN_HISTORY_PAGE_SIZE));
  // 실행 기록이 삭제될 일은 이제 없지만(위 요구사항), 혹시 모를 상황(관리자의
  // 수동 전체 삭제 등)에 대비해 총 페이지 수보다 큰 페이지에 머물러 있으면
  // 마지막 페이지로 되돌린다.
  useEffect(() => {
    setScanPage((page) => Math.min(page, totalScanPages - 1));
  }, [totalScanPages]);

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

  // 요구사항(2026-09-11 사용자 요청: "검색결과에서 리스트가 너무 끝도없이
  // 나오는데.. 이걸 좀 효과적으로 정리하는 방법이 없을까" — 사용자가 고른 방식:
  // 정렬 + 페이지네이션 + 날짜별 접기/펼치기): 결과를 낙찰일 기준으로 묶어
  // 접고 펼 수 있게 하고, 그 날짜 묶음 단위로 페이지를 나눈다. 정렬 기준으로
  // 낙찰일을 고르면 날짜 묶음 자체의 순서(최신순/오래된순)가 바뀌고, 규모·
  // 낙찰자를 고르면 각 날짜 묶음 "안"의 행 순서가 바뀐다.
  type SortColumn = "awardDate" | "budgetAmount" | "bidderName";
  const [sortColumn, setSortColumn] = useState<SortColumn>("awardDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDir(column === "bidderName" ? "asc" : "desc");
    }
  };
  const sortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  // 접힌 날짜 묶음의 집합. 기본은 전부 펼쳐진 상태(기존과 동일하게 모든 결과가
  // 바로 보임) — 여기 들어있는 날짜만 접혀서 요약 줄만 보인다.
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(() => new Set());
  const toggleDateCollapsed = (dateKey: string) => {
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  const dateGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleMatches>();
    for (const match of visibleMatches) {
      const key = match.awardDate ?? "날짜 미상";
      const bucket = groups.get(key);
      if (bucket) bucket.push(match);
      else groups.set(key, [match]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "날짜 미상") return 1;
      if (b === "날짜 미상") return -1;
      if (sortColumn === "awardDate" && sortDir === "asc") return a < b ? -1 : a > b ? 1 : 0;
      return a > b ? -1 : a < b ? 1 : 0; // 기본(및 규모·낙찰자 정렬 시)은 최신 날짜가 위로
    });
    return keys.map((dateKey) => {
      const items = [...(groups.get(dateKey) ?? [])];
      if (sortColumn !== "awardDate") {
        items.sort((x, y) => {
          let cmp = 0;
          if (sortColumn === "budgetAmount") {
            cmp = (x.budgetAmount ?? x.awardAmount ?? 0) - (y.budgetAmount ?? y.awardAmount ?? 0);
          } else {
            cmp = (x.bidderName ?? "").localeCompare(y.bidderName ?? "", "ko");
          }
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
      return { dateKey, items };
    });
  }, [visibleMatches, sortColumn, sortDir]);

  // 요구사항: 날짜 묶음 단위로 페이지를 나눠 한 화면 길이를 제한한다.
  const DATE_GROUPS_PER_PAGE = 10;
  const [groupPage, setGroupPage] = useState(0);
  const totalGroupPages = Math.max(1, Math.ceil(dateGroups.length / DATE_GROUPS_PER_PAGE));
  const clampedGroupPage = Math.min(groupPage, totalGroupPages - 1);
  const pageGroups = dateGroups.slice(
    clampedGroupPage * DATE_GROUPS_PER_PAGE,
    clampedGroupPage * DATE_GROUPS_PER_PAGE + DATE_GROUPS_PER_PAGE,
  );
  const totalVisibleCount = visibleMatches.length;
  // 다른 실행 기록을 선택하면 완전히 다른 데이터셋이 되므로, 이전 데이터셋
  // 기준으로 보던 페이지 번호를 그대로 들고 있으면 혼란스럽다 — 새로 1페이지로.
  useEffect(() => {
    setGroupPage(0);
  }, [selectedScanRunId]);

  // 버그 수정(2026-09-15 UX 리뷰): "지금 실행"/"이 기간으로 검색"을 누르면
  // POST 요청 자체는 곧바로 끝나 버튼이 바로 다시 눌릴 수 있게 되는데, 실제
  // 스캔은 서버에서 계속 진행 중이라 화면에는 아무 변화가 없다. "안 눌렸나?"
  // 하고 같은 대상일을 여러 번 재실행하면 공공데이터포털 API 한도만 낭비된다
  // (실제로 하루에 같은 날짜를 6번 넘게 재실행한 이력이 있었다). 실행 시작을
  // 토스트로 알리고, 결과 반영 전까지(20초) 버튼을 잠가 중복 클릭을 막는다.
  const [justTriggered, setJustTriggered] = useState(false);
  const runScan = (range?: { startDate: string; endDate: string }) => {
    triggerScan.mutate(
      { data: range ? range : {} },
      {
        onSuccess: () => {
          toast({
            title: "자동검색 실행을 시작했습니다",
            description: "완료까지 몇 분 정도 걸릴 수 있습니다. 끝나면 아래 표가 자동으로 갱신됩니다.",
          });
          setJustTriggered(true);
          // 요구사항(2026-09-13): 페이지네이션 도입으로 limit/offset 조합별로
          // 쿼리 키가 달라지므로, 파라미터 없이 호출해 "/api/scans"로 시작하는
          // 모든 페이지의 캐시를 한번에 무효화한다(현재 보고 있는 페이지가
          // 몇 페이지든 새로고침되도록).
          void queryClient.invalidateQueries({ queryKey: getListScansQueryKey() });
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey({ limit: 500 }) });
            void queryClient.invalidateQueries({ queryKey: getListScansQueryKey() });
            setJustTriggered(false);
          }, 20_000);
        },
        onError: () => {
          toast({
            title: "실행에 실패했습니다",
            description: "잠시 후 다시 시도해 주세요.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const rangeInvalid = !startDate || !endDate || endDate < startDate;

  // 요구사항(2026-09-11 사용자 재지적: "모든 검색의 기준은 낙찰일이야"): "지금
  // 실행" 버튼은 기본적으로 어제(낙찰일 기준) 하루를 검색한다. 다만 스캔을
  // 며칠 건너뛴 경우, 놓친 날짜를 자동으로 채워 넣는 갭필 로직
  // (computeTargetDatesWithGapFill, daily-scan.ts 참고) 때문에 화면의 "대상일"에
  // 날짜가 여러 개 찍힐 수 있다 — 이는 정상 동작이다.
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
            <>
              <div className="text-xs text-muted-foreground">
                총 {totalVisibleCount}건 · {dateGroups.length}일
              </div>
              {/* 요구사항(2026-09-12 사용자 요청: "검색결과에 가로 스크롤이
              생겼는데 안생기도록 내용 사이즈를 조정해줘"): 컬럼마다 nowrap +
              넉넉한(p-4) 셀 여백을 그대로 두면 8개 컬럼 폭 합이 화면보다
              커져 가로 스크롤이 생긴다. 셀 여백을 좁히고(px-2), 값이 길어질
              수 있는 낙찰자/연락처는 한 줄 고정 대신 줄바꿈되도록 바꿔서
              전체 폭이 뷰포트 안에 들어오게 한다. */}
              <div className="overflow-x-auto rounded-md border">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-2">공고번호</TableHead>
                      <TableHead className="px-2">
                        <button
                          type="button"
                          onClick={() => toggleSort("awardDate")}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          낙찰일 {sortIndicator("awardDate")}
                        </button>
                      </TableHead>
                      <TableHead className="px-2">키워드 · 수량</TableHead>
                      <TableHead className="px-2">
                        <button
                          type="button"
                          onClick={() => toggleSort("bidderName")}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          낙찰자 {sortIndicator("bidderName")}
                        </button>
                      </TableHead>
                      <TableHead className="px-2">
                        <button
                          type="button"
                          onClick={() => toggleSort("budgetAmount")}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          규모 {sortIndicator("budgetAmount")}
                        </button>
                      </TableHead>
                      {/* 요구사항(2026-09-13 사용자 요청: "낙찰받은 사람의 사무실과
                      실제 공사 현장을 모두 검색해서 결과에 보여줘"): 사업자 주소와
                      실제 공사현장 주소를 둘 다 보여준다 — 다만 현장 주소가
                      제공되지 않는 경우가 대부분이라(2026-09-15 UX 리뷰), 별도
                      컬럼 대신 클릭하면 둘 다 보여주는 팝오버 하나로 합친다. */}
                      <TableHead className="px-2">주소</TableHead>
                      <TableHead className="px-2">연락처</TableHead>
                      <TableHead className="px-2">첨부파일</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageGroups.map(({ dateKey, items }) => {
                      const isCollapsed = collapsedDates.has(dateKey);
                      return (
                        <Fragment key={dateKey}>
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={8} className="py-2 px-2">
                              <button
                                type="button"
                                onClick={() => toggleDateCollapsed(dateKey)}
                                className="inline-flex items-center gap-1.5 text-sm font-medium hover:text-primary"
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                                {dateKey} ({items.length}건)
                              </button>
                            </TableCell>
                          </TableRow>
                          {isCollapsed
                            ? null
                            : items.map((match) => (
                    <TableRow key={match.id}>
                      <TableCell className="px-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {/* 개선(2026-09-15 UX 리뷰): 리드가 나라장터에서 왔는지
                          LH에서 왔는지 화면 어디에도 표시가 없어서, 공고번호가
                          "LH-"로 시작하는지 같은 간접 단서로만 구분할 수
                          있었다. 출처 배지를 명시적으로 붙인다. */}
                          <Badge
                            variant="outline"
                            className={
                              match.source === "LH"
                                ? "shrink-0 px-1.5 py-0 text-[10px] font-normal text-blue-700 border-blue-300"
                                : "shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                            }
                          >
                            {match.source}
                          </Badge>
                          <CopyNoticeNumberButton value={match.noticeNumber} />
                        </div>
                      </TableCell>
                      <TableCell className="px-2 whitespace-nowrap">{match.awardDate ?? "-"}</TableCell>
                      {/* 요구사항(2026-09-10 사용자 요청: "검색 결과에
                      키워드/수량을 꼭 함께 넣어줘. 이게 가장 중요해. 이걸
                      한눈에 보고 해당 업체에 연락을 하려는게 이 싸이트의
                      핵심이야"): 어떤 자재가 얼마나 필요한지를 가장 먼저
                      눈에 띄게 보여준다. */}
                      <TableCell className="px-2 max-w-[160px]">
                        {match.matchedKeyword ? (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary whitespace-normal break-words">
                            <Package className="h-3.5 w-3.5 shrink-0" />
                            <span>{match.matchedKeyword}</span>
                            {match.quantityText ? <span>· {match.quantityText}</span> : null}
                          </span>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      {/* 개선(2026-09-15 UX 리뷰): break-words로 두면 긴
                      상호명이 3~4줄로 줄바꿈돼 행마다 높이가 들쭉날쭉해져서
                      "한눈에 훑고 바로 전화"하기 어려웠다. 1줄로 잘라 보여주고
                      전체 이름은 title로 확인하게 한다. */}
                      <TableCell className="px-2 font-medium max-w-[130px]">
                        {match.bidderName ? (
                          <a
                            href={naverSearchHref(match.bidderName)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate hover:underline hover:text-primary"
                            title={`${match.bidderName} — 네이버에서 전화번호 검색`}
                          >
                            {match.bidderName}
                          </a>
                        ) : (
                          "낙찰자 미확인"
                        )}
                      </TableCell>
                      {/* 개선(2026-09-15 UX 리뷰): "규모"가 추정가격(예산)인지
                      실제 낙찰금액인지 구분 없이 같은 자리에 표시돼, 전화영업
                      중에 실제와 다른 금액을 말할 위험이 있었다. 어느 쪽인지
                      작은 라벨로 밝힌다. */}
                      <TableCell className="px-2 text-muted-foreground whitespace-nowrap">
                        {match.budgetAmount != null ? (
                          <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] align-middle">예산</span>
                        ) : match.awardAmount != null ? (
                          <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] align-middle">낙찰</span>
                        ) : null}
                        {formatAmount(match.budgetAmount ?? match.awardAmount)}
                      </TableCell>
                      {/* 요구사항(2026-09-13 사용자 요청: "낙찰받은 사람의 사무실과
                      실제 공사 현장을 모두 검색해서 결과에 보여줘"): 사업자 주소
                      (bidderAddress)와 실제 공사현장 주소(siteAddress)를 보여준다.
                      개선(2026-09-15 UX 리뷰): 현장 주소는 실제로는 거의 항상
                      비어있어 별도 칼럼으로 두면 폭만 차지하고(가로스크롤 재발
                      원인), title 툴팁만으로는 터치기기에서 전체 주소를 볼 수
                      없었다 — 하나로 합치고, 클릭하면(터치 포함) 둘 다 보여주는
                      팝오버로 바꾼다. */}
                      <TableCell className="px-2 text-muted-foreground max-w-[170px]">
                        {match.bidderAddress || match.siteAddress ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                className="flex w-full items-start gap-1.5 text-left hover:text-foreground"
                              >
                                <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <span className="truncate">{match.bidderAddress ?? match.siteAddress}</span>
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80 space-y-2 text-xs">
                              <div>
                                <div className="font-medium text-foreground">사업자 주소</div>
                                <div className="text-muted-foreground">{match.bidderAddress ?? "주소 미확인"}</div>
                              </div>
                              <div>
                                <div className="font-medium text-foreground">현장 주소</div>
                                <div className="text-muted-foreground">{match.siteAddress ?? "주소 미확인"}</div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 shrink-0" /> 주소 미확인
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="px-2 max-w-[150px]">
                        <div className="flex flex-wrap items-center gap-1">
                          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          {isUsablePhone(match.bidderPhone) ? (
                            <a href={telHref(match.bidderPhone!)} className="text-primary hover:underline break-words">
                              {match.bidderPhone}
                            </a>
                          ) : (
                            <span className="text-muted-foreground break-words">
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
                      {/* 요구사항(2026-09-10 사용자 요청 1, 2: "키워드가 나온
                      파일은 다운로드 해서 우리 서버에 저장해줘" / "저장된
                      파일을 열어볼 수 있도록 링크를 만들어줘"): 첨부파일은
                      daily-scan.ts가 매칭 시점에 이미 서버(SCAN_ROOT)에
                      저장해두고 있었다 — 화면에서 열어볼 수 있는 링크가
                      없었을 뿐이라 여기에 추가한다. */}
                      <TableCell className="px-2 max-w-[160px]">
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
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {totalGroupPages > 1 ? (
                <div className="flex items-center justify-between text-sm text-muted-foreground pt-1">
                  <span>
                    {clampedGroupPage * DATE_GROUPS_PER_PAGE + 1}–
                    {Math.min((clampedGroupPage + 1) * DATE_GROUPS_PER_PAGE, dateGroups.length)} / {dateGroups.length}일
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGroupPage((p) => Math.max(0, p - 1))}
                      disabled={clampedGroupPage === 0}
                    >
                      <ChevronLeft className="h-4 w-4" /> 이전
                    </Button>
                    <span>
                      {clampedGroupPage + 1} / {totalGroupPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGroupPage((p) => Math.min(totalGroupPages - 1, p + 1))}
                      disabled={clampedGroupPage >= totalGroupPages - 1}
                    >
                      다음 <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>자동검색</CardTitle>
            <CardDescription>
              매일 오전 7시(KST) 자동으로 전일 낙찰된 공고 중 키워드가 있는 건을 검색합니다. 아래 기록은
              삭제되지 않고 전부 누적 보관되며, 10건씩 페이지를 넘겨 볼 수 있습니다.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={handleRunNow}
            disabled={triggerScan.isPending || justTriggered}
            className="shrink-0"
          >
            {triggerScan.isPending || justTriggered ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            {justTriggered ? "실행 중..." : "지금 실행"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 요구사항(2026-09-11 사용자 요청: "이 기간으로 검색과 지금 실행은
          중복되서 헷갈려"): 두 버튼은 동작이 다르다 — 위 "지금 실행"은 화면의
          날짜 지정과 무관하게 어제(낙찰일 기준) + 놓친 날짜를 자동으로 채워
          재확인하는 정기 점검용이고, 아래 "이 기간으로 검색"은 사용자가 지정한
          과거의 특정 기간만 자동 보정 없이 정확히 재검색하는 별개 기능이다.
          같은 툴바에 나란히 있어 헷갈렸던 것이므로 동작은 그대로 두고
          레이아웃만 분리해 두 기능이 다르다는 것을 명확히 한다. */}
          {/* 요구사항(2026-09-11 사용자 재지적: "입찰,개찰,낙찰 3가지를 정확히
          구분해야 한다 — 자동검색이든 기간 지정 재검색이든 모든 검색의 기준은
          낙찰일이다. 낙찰이 안 된 건에서 키워드를 검색할 필요 없다. 낙찰 된 건
          >> 키워드가 있는 건, 이 순서대로 하라"): 지정한 기간을 "낙찰일"로 보고,
          그 낙찰일을 찾기 위해 서버가 내부적으로 개찰일 기준 최대 14일을 되짚어
          조회한 뒤 실제 낙찰일이 지정 기간에 해당하고 낙찰자가 확정된 공고만
          남겨서 돌려준다(daily-scan.ts executeScanRun 참고). "지금 실행"과
          동일한 기준(낙찰일)을 공유한다. */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <div className="text-sm font-medium">기간 지정 재검색 (낙찰일 기준, 최종낙찰자만)</div>
            <p className="text-xs text-muted-foreground">
              위 "지금 실행"과 별개로, 지정한 기간에 낙찰(최종낙찰자 확정)된 공고만 검색합니다(시작일=종료일이면
              하루만 검색. 아직 낙찰자가 확정되지 않은 건은 결과에서 제외됩니다).
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
                disabled={triggerScan.isPending || justTriggered || rangeInvalid}
              >
                {triggerScan.isPending || justTriggered ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CalendarSearch className="h-4 w-4" />
                )}
                {justTriggered ? "실행 중..." : "이 기간으로 검색"}
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
                    <TableHead>
                      {/* 개선(2026-09-15 UX 리뷰): "확인 건수"가 "낙찰 건수"보다
                      작은 경우가 흔한데(최소 공사 규모 미달 건은 상세조회 자체를
                      건너뜀) 왜 그런지 설명이 없어 리드가 누락된 것처럼 보였다. */}
                      <span className="inline-flex items-center gap-1">
                        확인 건수
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              aria-label="확인 건수 설명 보기"
                            >
                              <Info className="h-3 w-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-72 text-xs text-muted-foreground">
                            낙찰 건수보다 적을 수 있습니다. 최소 공사 규모 미달인 건은 상세 조회 자체를 건너뛰고,
                            그 외 공공데이터포털 API 한도초과 등으로 조회하지 못한 건은 "오류" 칸에 표시됩니다.
                          </PopoverContent>
                        </Popover>
                      </span>
                    </TableHead>
                    <TableHead>매칭 건수</TableHead>
                    <TableHead>시작 시각</TableHead>
                    <TableHead>오류</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((scan) => (
                    <TableRow key={scan.id} className={scan.id === selectedScanRunId ? "bg-muted/50" : undefined}>
                      <TableCell>{scanStatusBadge(scan)}</TableCell>
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
                      <TableCell className="max-w-xs text-xs">
                        {scan.errorMessage ? (
                          <span className="text-destructive">{scan.errorMessage}</span>
                        ) : scan.candidatesChecked < scan.awardsFound ? (
                          <span className="text-muted-foreground">
                            {scan.awardsFound - scan.candidatesChecked}건은 최소 공사 규모 미달로 상세 조회를
                            하지 않았습니다.
                          </span>
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
          {/* 요구사항(2026-09-13 사용자 요청: "히스토리는 계속 누적으로
          남겨두고 다만 10개까지 보여주고 페이지를 넘기는 방식으로 수정하자") */}
          {totalScanPages > 1 ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground pt-1">
              <span>
                {scanPage * SCAN_HISTORY_PAGE_SIZE + 1}–
                {Math.min((scanPage + 1) * SCAN_HISTORY_PAGE_SIZE, scansTotal)} / {scansTotal}건
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScanPage((p) => Math.max(0, p - 1))}
                  disabled={scanPage === 0}
                >
                  <ChevronLeft className="h-4 w-4" /> 이전
                </Button>
                <span>
                  {scanPage + 1} / {totalScanPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScanPage((p) => Math.min(totalScanPages - 1, p + 1))}
                  disabled={scanPage >= totalScanPages - 1}
                >
                  다음 <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
