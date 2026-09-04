import { useEffect, useRef, useState } from "react"
import { 
  useStartBidCollection, 
  useGetBidCollectionStatus,
  getGetBidCollectionStatusQueryKey,
  downloadBidArchive,
  downloadBidResultsCsv,
  downloadBidResultsXlsx
} from "@workspace/api-client-react"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import {
  FileText, Play, Download, Search, FileDown,
  CheckCircle2, XCircle, Loader2, Clock, AlertCircle, FileArchive, Table as TableIcon,
  Upload, RefreshCw, X, ExternalLink, History, FolderOpen
} from "lucide-react"

interface JobHistoryEntry {
  jobId: string;
  status: string;
  keywords: string[];
  noticeCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  summary: {
    notices: number;
    attachments: number;
    downloaded: number;
    downloadFailures: number;
    parseFailures: number;
    lookupFailures: number;
    filesWithKeywords: number;
    keywordMatches: number;
  };
}

export default function Home() {
  const [jobId, setJobId] = useLocalStorage<string | null>("bid-search-job-id", null);
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [noticeNumbers, setNoticeNumbers] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>(["부직포"]);
  const [keywordInput, setKeywordInput] = useState("");
  const [uploadInfo, setUploadInfo] = useState<{ fileName: string; duplicateCount: number; invalidValues: string[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inputMode, setInputMode] = useState<"file" | "paste">("file");
  const [pasteText, setPasteText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState("ALL");
  const [xlsxReady, setXlsxReady] = useState(false);
  const [xlsxChecking, setXlsxChecking] = useState(false);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<JobHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const resultPreviewRef = useRef<HTMLDivElement>(null);

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch("/api/bids/jobs?limit=50");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "검색 기록을 불러오지 못했습니다.");
      setHistory(data.jobs ?? []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "검색 기록을 불러오지 못했습니다.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    void loadHistory();
  };

  const selectHistoryJob = (id: string) => {
    setJobId(id);
    setHistoryOpen(false);
    window.history.replaceState(null, "", `${window.location.pathname}?jobId=${id}`);
  };

  const formatDateTime = (value: string | null) => {
    if (!value) return "-";
    try {
      return new Date(value).toLocaleString("ko-KR");
    } catch {
      return value;
    }
  };

  useEffect(() => {
    const requestedJobId = new URLSearchParams(window.location.search).get("jobId");
    if (/^[0-9a-f-]{36}$/i.test(requestedJobId ?? "") && requestedJobId !== jobId) {
      setJobId(requestedJobId);
    }
  }, [jobId, setJobId]);
  
  const startMutation = useStartBidCollection();
  
  const { data: statusData, isError, error, refetch } = useGetBidCollectionStatus(
    jobId || "", 
    { 
      query: { 
        enabled: !!jobId,
        queryKey: getGetBidCollectionStatusQueryKey(jobId || ""),
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          if (status === 'running' || status === 'queued') {
            return 2000; // Poll every 2 seconds while running
          }
          return false;
        }
      } 
    }
  );

  const isRunning = statusData?.status === 'running' || statusData?.status === 'queued';
  const isCompleted = statusData?.status === 'completed' || statusData?.status === 'completed_with_errors';
  const keywordResults = statusData?.searchResults?.filter((result) => result.keywordFound) ?? [];
  const filteredResults = (statusData?.searchResults ?? []).filter(result =>
    resultFilter === "ALL" || result.resultStatus === resultFilter
  );
  const hasResults = filteredResults.length > 0;
  const parseFailureResults = statusData?.searchResults?.filter((result) => result.resultStatus === 'parse_failed') ?? [];
  const keywordNotices = [...new Set(keywordResults.map((result) => result.noticeNumber))];

  useEffect(() => {
    if (statusData?.keywords?.length) setKeywords(statusData.keywords);
  }, [statusData?.jobId, statusData?.keywords]);

  useEffect(() => {
    setXlsxReady(false);
    setXlsxError(null);
    if (!jobId || !isCompleted) return;

    const controller = new AbortController();
    setXlsxChecking(true);
    fetch(`/api/bids/jobs/${jobId}/results.xlsx/status`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !data.ready) {
          throw new Error(data.error ?? "검색 결과 XLSX를 만들지 못했습니다.");
        }
        setXlsxReady(true);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setXlsxError(error instanceof Error ? error.message : "검색 결과 XLSX를 만들지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setXlsxChecking(false);
      });

    return () => controller.abort();
  }, [isCompleted, jobId]);

  const handleStart = () => {
    if (!noticeNumbers.length || !keywords.length) {
      setInputError("공고번호 파일과 검색 키워드를 확인해 주세요.");
      return;
    }
    startMutation.mutate(
      { data: { noticeNumbers, keywords } },
      {
        onSuccess: (data) => {
          setJobId(data.jobId);
        }
      }
    );
  };

  const addKeyword = () => {
    const additions = keywordInput.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
    if (additions.length) setKeywords(current => [...new Set([...current, ...additions])].slice(0, 20));
    setKeywordInput("");
  };

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setInputError(null);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/bids/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentBase64 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "공고번호 파일을 분석하지 못했습니다.");
      setNoticeNumbers(data.noticeNumbers);
      setUploadInfo({ fileName: file.name, duplicateCount: data.duplicateCount, invalidValues: data.invalidValues });
      setJobId(null);
    } catch (error) {
      setNoticeNumbers([]);
      setUploadInfo(null);
      setInputError(error instanceof Error ? error.message : "파일 업로드에 실패했습니다.");
    } finally {
      setUploading(false);
    }
  };

  const applyPastedNotices = () => {
    setInputError(null);
    const matches = pasteText.toUpperCase().match(/R[0-9A-Z]{12}-[0-9]{3}/g) ?? [];
    const unique = [...new Set(matches)];
    if (!unique.length) {
      setNoticeNumbers([]);
      setUploadInfo(null);
      setInputError("붙여넣은 텍스트에서 유효한 공고번호를 찾지 못했습니다. (형식 예: R25AC00123456-000)");
      return;
    }
    setNoticeNumbers(unique);
    setUploadInfo({
      fileName: `직접 입력 (${unique.length}건)`,
      duplicateCount: matches.length - unique.length,
      invalidValues: [],
    });
    setJobId(null);
  };

  const retryFailed = async () => {
    if (!jobId) return;
    const response = await fetch(`/api/bids/jobs/${jobId}/retry`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      setInputError(data.error ?? "실패 공고를 재처리하지 못했습니다.");
      return;
    }
    setJobId(data.jobId);
  };

  const downloadFile = async (type: 'zip' | 'csv' | 'xlsx') => {
    if (!jobId) return;
    setIsDownloading(type);
    try {
      if (type === 'zip') {
        const blob = await downloadBidArchive(jobId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bid-attachments-${jobId}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      } else if (type === 'csv') {
        const csvString = await downloadBidResultsCsv(jobId);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bid-results-${jobId}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } else if (type === 'xlsx') {
        const blob = await downloadBidResultsXlsx(jobId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bid-results-${jobId}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(`Failed to download ${type}`, e);
      if (type === 'xlsx') {
        setXlsxReady(false);
        setXlsxError(e instanceof Error ? `엑셀 다운로드 실패: ${e.message}` : "엑셀 다운로드에 실패했습니다.");
      }
      alert(`다운로드 실패 (${type})`);
    } finally {
      setIsDownloading(null);
    }
  };

  const getNoticeStatusBadge = (status?: string) => {
    switch(status) {
      case 'completed':
        return <Badge variant="success" className="gap-1"><CheckCircle2 className="w-3 h-3" />완료</Badge>;
      case 'running':
        return <Badge variant="default" className="gap-1 bg-blue-600 hover:bg-blue-600/90"><Loader2 className="w-3 h-3 animate-spin" />진행중</Badge>;
      case 'partial':
        return <Badge variant="warning" className="gap-1"><AlertCircle className="w-3 h-3" />부분완료</Badge>;
      case 'failed':
        return <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" />실패</Badge>;
      case 'queued':
        return <Badge variant="secondary" className="gap-1"><Clock className="w-3 h-3" />대기중</Badge>;
      default:
        return <Badge variant="outline" className="text-muted-foreground gap-1"><Clock className="w-3 h-3" />대기</Badge>;
    }
  };

  const getResultStatusBadge = (status: string) => {
    switch (status) {
      case 'keyword_found':
        return <Badge variant="success">키워드 발견</Badge>;
      case 'keyword_not_found':
        return <Badge variant="secondary">키워드 없음</Badge>;
      case 'download_failed':
        return <Badge variant="destructive">다운로드 실패</Badge>;
      case 'parse_failed':
        return <Badge variant="warning">파싱 실패</Badge>;
      case 'no_attachment':
        return <Badge variant="outline">첨부파일 없음</Badge>;
      case 'not_awarded':
        return <Badge variant="outline">낙찰자 없음</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const displayedNoticeNumbers = statusData?.notices?.map(item => item.noticeNumber) ?? noticeNumbers;
  const combinedNotices = displayedNoticeNumbers.map(noticeNum => {
    const found = statusData?.notices?.find(n => n.noticeNumber === noticeNum);
    return found || {
      noticeNumber: noticeNum,
      noticeName: null,
      requestedOrder: "0",
      resolvedOrder: null,
      orderMatched: null,
      lookupAttempts: 0,
      status: "pending",
      attachmentCount: 0,
      downloadedCount: 0,
      failedCount: 0,
      keywordHitCount: 0,
      parseFailureCount: 0,
      attachments: [],
      error: null,
      awardStatus: undefined,
      bidderName: undefined
    };
  });

  const progressPercent = statusData && statusData.totalCount > 0 
    ? Math.round((statusData.completedCount / statusData.totalCount) * 100) 
    : 0;

  return (
    <div className="min-h-screen bg-background pb-12 flex flex-col items-center">
      {/* Header */}
      <header className="w-full bg-card border-b border-border py-6 px-6 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="bg-primary/10 text-primary p-1.5 rounded-md">
                <Search className="w-5 h-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                나라장터 공고 첨부문서 검색
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              엑셀의 공고번호를 불러와 원하는 키워드로 첨부문서와 낙찰정보를 검색합니다.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isCompleted && (
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="gap-2"
                  onClick={() => downloadFile('zip')}
                  disabled={!!isDownloading}
                >
                  {isDownloading === 'zip' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
                  ZIP 다운로드
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="gap-2"
                  onClick={() => downloadFile('csv')}
                  disabled={!!isDownloading}
                >
                  {isDownloading === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TableIcon className="w-4 h-4" />}
                  CSV 다운로드
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="gap-2"
                  onClick={() => downloadFile('xlsx')}
                  disabled={!!isDownloading}
                >
                  {isDownloading === 'xlsx' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TableIcon className="w-4 h-4" />}
                  XLSX 다운로드
                </Button>
              </div>
            )}
            
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={openHistory}
            >
              <History className="w-4 h-4" />
              검색 기록
            </Button>

            <Button
              onClick={handleStart}
              disabled={startMutation.isPending || isRunning || !noticeNumbers.length || !keywords.length}
              className="gap-2 font-medium"
            >
              {startMutation.isPending || isRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {isRunning ? "수집 및 검색 중..." : "수집 시작"}
            </Button>
          </div>
        </div>
      </header>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-5 h-5" /> 검색 기록
            </DialogTitle>
            <DialogDescription>
              지금까지 실행한 검색 작업입니다. 클릭하면 해당 결과를 다시 불러옵니다. (서버에 영구 저장되어 다른 기기/브라우저에서도 동일하게 보입니다.)
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {historyLoading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중...
              </div>
            )}
            {historyError && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" /> {historyError}
              </div>
            )}
            {!historyLoading && !historyError && history.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                아직 실행한 검색이 없습니다.
              </div>
            )}
            {history.map((entry) => (
              <button
                key={entry.jobId}
                type="button"
                onClick={() => selectHistoryJob(entry.jobId)}
                className={`w-full rounded-md border p-3 text-left text-sm transition hover:bg-muted/50 ${entry.jobId === jobId ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {entry.keywords.slice(0, 5).map((keyword) => (
                      <Badge key={keyword} variant="secondary" className="text-xs">{keyword}</Badge>
                    ))}
                    {entry.keywords.length > 5 && (
                      <span className="text-xs text-muted-foreground">외 {entry.keywords.length - 5}개</span>
                    )}
                  </div>
                  {getNoticeStatusBadge(entry.status)}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>공고 {entry.noticeCount}건</span>
                  <span className="text-emerald-700 font-medium">키워드 발견 {entry.summary?.keywordMatches ?? 0}건</span>
                  <span>{formatDateTime(entry.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <main className="max-w-6xl w-full mx-auto p-6 flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">검색 작업 만들기</CardTitle>
            <CardDescription>XLS, XLSX 또는 CSV 파일과 하나 이상의 검색 키워드를 입력하세요.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">공고번호</label>
                <div className="flex rounded-md border p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setInputMode("file")}
                    className={`rounded px-2.5 py-1 font-medium transition ${inputMode === "file" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    파일 업로드
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode("paste")}
                    className={`rounded px-2.5 py-1 font-medium transition ${inputMode === "paste" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    직접 붙여넣기
                  </button>
                </div>
              </div>

              {inputMode === "file" ? (
                <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20 p-4 hover:bg-muted/40">
                  {uploading ? <Loader2 className="mb-2 h-6 w-6 animate-spin" /> : <Upload className="mb-2 h-6 w-6 text-muted-foreground" />}
                  <span className="text-sm font-medium">{uploadInfo?.fileName ?? "파일을 선택하거나 여기에 놓으세요"}</span>
                  <span className="mt-1 text-xs text-muted-foreground">최대 15MB · XLS/XLSX/CSV</span>
                  <input type="file" className="hidden" accept=".xls,.xlsx,.csv" onChange={event => void handleUpload(event.target.files?.[0])} />
                </label>
              ) : (
                <div className="space-y-2">
                  <textarea
                    className="min-h-28 w-full resize-y rounded-lg border border-border bg-muted/20 p-3 text-sm font-mono focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder={"공고번호를 붙여넣으세요. 쉼표, 줄바꿈, 공백 등 어떤 구분자여도 됩니다.\n예: R25AC00123456-000, R25AC00123457-001"}
                    value={pasteText}
                    onChange={event => setPasteText(event.target.value)}
                  />
                  <Button type="button" variant="outline" size="sm" className="w-full" onClick={applyPastedNotices} disabled={!pasteText.trim()}>
                    붙여넣은 공고번호 적용
                  </Button>
                </div>
              )}

              {uploadInfo && (
                <div className="rounded-md bg-muted/40 p-3 text-xs">
                  유효 공고 <strong>{noticeNumbers.length}</strong>건 · 중복 제거 <strong>{uploadInfo.duplicateCount}</strong>건 · 형식 오류 <strong>{uploadInfo.invalidValues.length}</strong>건
                  {uploadInfo.invalidValues.length > 0 && <div className="mt-2 max-h-20 overflow-auto text-destructive">{uploadInfo.invalidValues.join(", ")}</div>}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium">검색 키워드</label>
              <div className="flex gap-2">
                <input
                  className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                  value={keywordInput}
                  placeholder="예: 부직포, 투수시트"
                  onChange={event => setKeywordInput(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addKeyword(); } }}
                />
                <Button type="button" variant="outline" onClick={addKeyword}>추가</Button>
              </div>
              <div className="flex min-h-12 flex-wrap gap-2 rounded-md border p-3">
                {keywords.map(keyword => (
                  <Badge key={keyword} variant="secondary" className="gap-1 py-1">
                    {keyword}
                    <button aria-label={`${keyword} 삭제`} onClick={() => setKeywords(current => current.filter(item => item !== keyword))}><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
                {!keywords.length && <span className="text-xs text-muted-foreground">키워드를 하나 이상 추가하세요.</span>}
              </div>
              <p className="text-xs text-muted-foreground">동일한 공고번호와 키워드 조합의 완료 작업은 기존 결과를 재사용합니다.</p>
            </div>
          </CardContent>
        </Card>
        
        {/* Error States */}
        {(isError || inputError) && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="p-4 flex items-center gap-3 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <p className="text-sm font-medium">{inputError ?? "상태를 불러오는데 실패했습니다. 네트워크를 확인해주세요."}</p>
            </CardContent>
          </Card>
        )}
        {statusData?.error && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="p-4 flex items-center gap-3 text-destructive">
              <XCircle className="w-5 h-5" />
              <p className="text-sm font-medium">작업 오류: {statusData.error}</p>
            </CardContent>
          </Card>
        )}

        {/* Progress Overview */}
        {(jobId || startMutation.isPending) && (
          <Card className="overflow-hidden border-border shadow-sm">
            <div className="bg-muted/30 p-6 flex flex-col gap-5 border-b border-border">
              <div className="flex justify-between items-end">
                <div className="space-y-1">
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    작업 진행률
                    {isRunning && <Badge variant="secondary" className="text-xs font-normal h-5 border-primary/20 bg-primary/10 text-primary">진행중</Badge>}
                    {isCompleted && <Badge variant="success" className="text-xs font-normal h-5">완료됨</Badge>}
                    {isCompleted && statusData?.notices?.some(item => item.status === "failed" || item.status === "partial") && (
                      <Button size="sm" variant="outline" className="ml-2 gap-1" onClick={() => void retryFailed()}>
                        <RefreshCw className="h-3 w-3" /> 실패건 재처리
                      </Button>
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {statusData ? `${statusData.totalCount}개 중 ${statusData.completedCount}개 완료` : '작업 초기화 중...'}
                  </p>
                </div>
                <div className="text-3xl font-bold tracking-tighter text-primary">
                  {progressPercent}%
                </div>
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>

            {statusData?.summary && (
              <div className="grid grid-cols-2 md:grid-cols-6 divide-y md:divide-y-0 md:divide-x divide-border">
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <FileText className="w-4 h-4" /> 전체 공고
                  </div>
                  <div className="text-2xl font-semibold">{statusData.summary.notices}</div>
                </div>
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <FileDown className="w-4 h-4" /> 문서 다운로드
                  </div>
                  <div className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
                    {statusData.summary.downloaded}
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      / {statusData.summary.attachments}
                    </span>
                  </div>
                </div>
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <Search className="w-4 h-4" /> 키워드 발견
                  </div>
                  <div className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                    {statusData.summary.keywordMatches}
                  </div>
                </div>
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <XCircle className="w-4 h-4" /> 실패
                  </div>
                  <div className="text-2xl font-semibold text-destructive">
                    {statusData.summary.downloadFailures}
                  </div>
                </div>
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground">파싱 실패</div>
                  <div className="text-2xl font-semibold text-amber-600">
                    {statusData.summary.parseFailures}
                  </div>
                </div>
                <div className="p-4 flex flex-col items-center justify-center text-center gap-1">
                  <div className="text-sm font-medium text-muted-foreground">조회 실패</div>
                  <div className="text-2xl font-semibold text-destructive">
                    {statusData.summary.lookupFailures}
                  </div>
                </div>
              </div>
            )}
          </Card>
        )}

        {isCompleted && (
          <Card className="border-emerald-300 bg-gradient-to-r from-emerald-50 to-white shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <TableIcon className="h-5 w-5 text-emerald-700" />
                최종 엑셀 결과
              </CardTitle>
              <CardDescription>
                브라우저에서는 동일한 엑셀 내용을 결과표로 바로 확인하거나 XLSX 원본을 내려받을 수 있습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="min-w-44 gap-2 bg-emerald-700 hover:bg-emerald-800"
                  disabled={!xlsxReady || xlsxChecking}
                  onClick={() => {
                    resultPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#result-preview`);
                  }}
                >
                  {xlsxChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                  엑셀 파일 열기
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="min-w-44 gap-2 border-emerald-600 text-emerald-800 hover:bg-emerald-50"
                  disabled={!xlsxReady || xlsxChecking || !!isDownloading}
                  onClick={() => void downloadFile("xlsx")}
                >
                  {isDownloading === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  엑셀 다운로드
                </Button>
              </div>
              {xlsxChecking && (
                <p className="mt-3 text-sm text-muted-foreground">엑셀 파일 생성 상태를 확인하고 있습니다.</p>
              )}
              {xlsxError && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>엑셀 파일을 사용할 수 없습니다. {xlsxError}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isCompleted && (
          <Card className="border-emerald-200 bg-emerald-50/40">
            <CardHeader>
              <CardTitle className="text-lg">키워드 발견 공고번호 요약</CardTitle>
              <CardDescription>실제 첨부문서 내부에서 근거 문맥이 확인된 공고만 표시합니다.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {keywordNotices.length ? keywordNotices.map((noticeNumber) => (
                <Badge key={noticeNumber} variant="outline" className="bg-white border-emerald-300 text-emerald-800">
                  {noticeNumber}
                </Badge>
              )) : <span className="text-sm text-muted-foreground">발견 공고 없음</span>}
            </CardContent>
          </Card>
        )}

        {isCompleted && parseFailureResults.length > 0 && (
          <Card className="border-amber-300 bg-amber-50/60">
            <CardHeader>
              <CardTitle className="text-lg text-amber-900">파싱 실패 및 재시도 결과</CardTitle>
              <CardDescription>실패를 키워드 없음으로 처리하지 않고 원인과 재시도 횟수를 기록했습니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {parseFailureResults.map((result, index) => (
                <div key={`${result.noticeNumber}-${result.fileName}-${index}`} className="rounded-md border border-amber-200 bg-white p-3 text-sm">
                  <div className="font-mono text-xs font-semibold">{result.noticeNumber}</div>
                  <div className="mt-1 break-all font-medium">{result.fileName}</div>
                  <div className="mt-1 text-amber-900">{result.parseError}</div>
                  <div className="mt-1 text-xs text-muted-foreground">파싱 재시도 {result.retryCount}회 후 최종 실패</div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
          {/* Notice List */}
          <Card id="result-preview" ref={resultPreviewRef} className="scroll-mt-28 border-border shadow-sm flex flex-col h-[700px]">
            <CardHeader className="pb-4 shrink-0">
              <CardTitle className="text-lg">공고별 처리 상태</CardTitle>
              <CardDescription>
                수집 대상 {combinedNotices.length}개 공고의 문서 다운로드 및 검색 현황입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 overflow-auto flex-1">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                  <TableRow>
                    <TableHead className="w-[140px]">공고번호</TableHead>
                    <TableHead>공고명</TableHead>
                    <TableHead className="w-[80px] text-center">상태</TableHead>
                    <TableHead className="w-[110px] text-center">낙찰</TableHead>
                    <TableHead className="w-[80px] text-center">차수</TableHead>
                    <TableHead className="w-[80px] text-center">문서수</TableHead>
                    <TableHead className="w-[70px] text-center">파싱실패</TableHead>
                    <TableHead className="w-[70px] text-center">발견</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {combinedNotices.map((notice, idx) => (
                    <TableRow key={`${notice.noticeNumber}-${idx}`} className={notice.keywordHitCount > 0 ? "bg-emerald-50/30 dark:bg-emerald-950/10" : ""}>
                      <TableCell className="font-mono text-xs font-medium text-slate-700 dark:text-slate-300">
                        {notice.noticeNumber}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate" title={notice.noticeName || '정보 없음'}>
                        {notice.noticeName ? (
                          <span className="text-sm">{notice.noticeName}</span>
                        ) : (
                          <span className="text-muted-foreground text-xs italic">대기중...</span>
                        )}
                        {notice.error && (
                          <div className="text-xs text-destructive mt-0.5 truncate" title={notice.error}>
                            {notice.error}
                          </div>
                        )}
                        {notice.attachments.length > 0 && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer text-primary">
                              첨부파일 {notice.attachments.length}개 보기
                            </summary>
                            <ul className="mt-2 space-y-1.5">
                              {notice.attachments.map((attachment, attachmentIndex) => (
                                <li key={`${attachment.fileName}-${attachmentIndex}`} className="border-l-2 pl-2">
                                  <div className="break-all">{attachment.fileName}</div>
                                  <div className="text-muted-foreground">
                                    {attachment.priority ? '우선검사 · ' : ''}
                                    다운로드 {attachment.downloadStatus === 'success' ? '성공' : attachment.downloadStatus === 'failed' ? '실패' : '대기'} ·
                                    {' '}시도 {attachment.attempts}회 · 파싱 {attachment.parsedFileCount}개
                                    {attachment.parseFailureCount > 0 ? ` · 파싱실패 ${attachment.parseFailureCount}개` : ''}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {getNoticeStatusBadge(notice.status)}
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {notice.awardStatus === 'confirmed' ? (
                          <div>
                            <Badge variant="success" className="mb-0.5">낙찰</Badge>
                            {notice.bidderName && (
                              <div className="text-muted-foreground truncate max-w-[100px]" title={notice.bidderName}>
                                {notice.bidderName}
                              </div>
                            )}
                          </div>
                        ) : notice.awardStatus === 'not_found' ? (
                          <Badge variant="outline" className="text-muted-foreground">낙찰자 없음</Badge>
                        ) : (
                          <span className="text-muted-foreground">확인중...</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        <div>{notice.requestedOrder} → {notice.resolvedOrder ?? '-'}</div>
                        <div className={notice.orderMatched === true ? 'text-emerald-600' : notice.orderMatched === false ? 'text-destructive' : 'text-muted-foreground'}>
                          {notice.orderMatched === true ? '일치' : notice.orderMatched === false ? '불일치' : '미확인'}
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {notice.status !== 'pending' ? (
                          <span className="text-muted-foreground">
                            <span className="text-foreground font-medium">{notice.downloadedCount}</span> / {notice.attachmentCount}
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {notice.parseFailureCount}
                      </TableCell>
                      <TableCell className="text-center">
                        {notice.keywordHitCount > 0 ? (
                          <Badge variant="outline" className="bg-emerald-100/50 text-emerald-700 border-emerald-200">
                            {notice.keywordHitCount}건
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">{notice.status !== 'pending' ? '0' : '-'}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Results Tab / Section */}
          <Card className="border-border shadow-sm flex flex-col h-[700px]">
            <CardHeader className="pb-4 shrink-0 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg">엑셀 결과 웹 미리보기</CardTitle>
                <CardDescription>
                  XLSX와 동일한 전체 상태 및 발견 문맥을 브라우저에서 바로 확인합니다.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={resultFilter}
                  onChange={event => setResultFilter(event.target.value)}
                >
                  <option value="ALL">전체 상태</option>
                  <option value="keyword_found">FOUND</option>
                  <option value="keyword_not_found">NOT_FOUND</option>
                  <option value="no_attachment">NO_ATTACHMENT</option>
                  <option value="download_failed">DOWNLOAD_FAIL</option>
                  <option value="parse_failed">PARSE_FAIL</option>
                  <option value="not_awarded">NOT_AWARDED</option>
                </select>
                {hasResults && (
                  <Badge variant="secondary" className="font-medium bg-primary/10 text-primary hover:bg-primary/20">
                    {filteredResults.length}건
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-auto flex-1">
              {!statusData?.searchResults || statusData.searchResults.length === 0 ? (
                <div className="h-full w-full flex flex-col items-center justify-center text-center p-6 min-h-[300px]">
                  <div className="bg-muted p-4 rounded-full mb-4">
                    <Search className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-medium text-foreground mb-1">
                    {isRunning ? '검색을 진행하고 있습니다' : '발견된 결과가 없습니다'}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {isRunning ? '문서 다운로드 및 키워드 분석이 끝나면 결과가 표시됩니다.' : '해당 공고들의 문서에서 대상 키워드를 찾지 못했습니다.'}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader className="bg-muted/50 sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                    <TableRow>
                      <TableHead className="w-[120px]">공고번호</TableHead>
                      <TableHead className="w-[110px]">판정</TableHead>
                      <TableHead className="w-[160px]">문서/위치</TableHead>
                      <TableHead>발견 문맥</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredResults.map((res, idx) => (
                      <TableRow key={`result-${idx}`}>
                        <TableCell className="font-mono text-xs font-medium text-slate-700 dark:text-slate-300 align-top pt-4">
                          {res.noticeNumber}
                        </TableCell>
                        <TableCell className="align-top pt-4">
                          {getResultStatusBadge(res.resultStatus)}
                          {res.retryCount > 0 && (
                            <div className="text-[10px] text-muted-foreground mt-1">재시도 {res.retryCount}회</div>
                          )}
                        </TableCell>
                        <TableCell className="align-top pt-4">
                          <div className="text-xs font-medium max-w-[150px] truncate" title={res.fileName}>
                            {res.fileName}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                            {res.sheet && <div>{res.sheet}</div>}
                            {res.page && <div>{res.page}p</div>}
                            {res.location && <div className="truncate" title={res.location}>{res.location}</div>}
                          </div>
                          {res.downloadError && (
                            <div className="text-[10px] text-destructive mt-1">{res.downloadError}</div>
                          )}
                          {res.parseError && (
                            <div className="text-[10px] text-amber-700 mt-1">{res.parseError}</div>
                          )}
                        </TableCell>
                        <TableCell className="py-3 pr-4">
                          <div className="text-xs bg-muted/40 p-3 rounded-md border border-border font-mono whitespace-pre-wrap leading-relaxed max-h-[200px] overflow-y-auto">
                            {(() => {
                              const text = res.originalText || res.surroundingText;
                              const keywords = res.foundKeywords;
                              if (!keywords || keywords.length === 0) return <span>{text}</span>;
                              
                              const escapedKeywords = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                              const regex = new RegExp(`(${escapedKeywords.join('|')})`, 'gi');
                              const parts = text.split(regex);
                              
                              return parts.map((part, i) => {
                                if (keywords.some(kw => kw.toLowerCase() === part.toLowerCase())) {
                                  return <mark key={i} className="bg-yellow-200 text-yellow-900 font-bold px-1 rounded-sm">{part}</mark>;
                                }
                                return <span key={i}>{part}</span>;
                              });
                            })()}
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <span className="text-muted-foreground">공사명</span><span>{res.noticeName ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">규격</span><span>{res.itemSpecification ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">품명</span><span>{res.itemName ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">수량</span><span>{res.itemQuantity ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">단위</span><span>{res.itemUnit ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">품목금액</span><span>{res.itemAmount ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground font-semibold">낙찰자(영업 대상)</span><span className="font-semibold">{res.bidderName ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">낙찰 식별번호</span><span>{res.awardIdentifier ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">낙찰일</span><span>{res.awardDate ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">낙찰금액</span><span>{res.awardAmount ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">공사금액</span><span>예산 {res.budgetAmount ?? '-'} / 추정 {res.estimatedAmount ?? '-'} / 기초 {res.baseAmount ?? '-'}</span>
                            <span className="text-muted-foreground">공사개요</span><span>{res.constructionOverview ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">주소</span><span>{res.bidderAddress ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">연락처</span><span>{res.bidderPhone ?? '미공개/확인불가'}</span>
                            <span className="text-muted-foreground">연락처 출처</span>
                            <span>
                              {res.contactSource === 'government' && '나라장터 낙찰정보'}
                              {res.contactSource === 'attachment' && '첨부파일에서 추출'}
                              {res.contactSource === 'portal' && '포털 검색 보완'}
                              {!res.contactSource && (res.bidderPhone && res.bidderPhone !== '미공개/확인불가' ? '확인됨' : '미확인')}
                            </span>
                          </div>
                          {jobId && res.downloadStatus === 'success' && res.fileName && res.fileName !== '-' && (
                            <a
                              href={`/api/bids/jobs/${jobId}/file?notice=${encodeURIComponent(res.noticeNumber)}&path=${encodeURIComponent(res.fileName)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10"
                            >
                              <FolderOpen className="h-3 w-3" /> 원본 파일 직접 열어서 검수하기
                            </a>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

      </main>
    </div>
  )
}
