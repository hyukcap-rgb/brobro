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
import {
  Download, FileDown, Loader2, PlayCircle, RefreshCw, Paperclip, AlertCircle, CheckCircle2, XCircle, Clock,
} from "lucide-react";

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
  const matchesQuery = useListMatches(
    { limit: 500 },
    { query: { queryKey: getListMatchesQueryKey({ limit: 500 }), refetchInterval: 30_000 } },
  );
  const scansQuery = useListScans(
    { limit: 20 },
    { query: { queryKey: getListScansQueryKey({ limit: 20 }), refetchInterval: 15_000 } },
  );
  const triggerScan = useTriggerScan();

  const matches = matchesQuery.data?.matches ?? [];
  const scans = scansQuery.data?.scans ?? [];

  const handleRunNow = () => {
    triggerScan.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListScansQueryKey({ limit: 20 }) });
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey({ limit: 500 }) });
          void queryClient.invalidateQueries({ queryKey: getListScansQueryKey({ limit: 20 }) });
        }, 20_000);
      },
    });
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
            <CardTitle>누적 영업 리드 (부직포 매칭 낙찰 공고)</CardTitle>
            <CardDescription>
              매일 오전 7시 자동 검색 결과가 여기 누적됩니다. 현장사무소로 직접 연락해 영업하세요.
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => void matchesQuery.refetch()}>
              <RefreshCw className="h-4 w-4" /> 새로고침
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownload("/api/matches/export.csv", "누적_낙찰검색결과.csv")}
            >
              <FileDown className="h-4 w-4" /> CSV
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
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>공고번호</TableHead>
                    <TableHead>현장명 / 발주기관</TableHead>
                    <TableHead>업무구분</TableHead>
                    <TableHead>낙찰자</TableHead>
                    <TableHead>낙찰자 연락처</TableHead>
                    <TableHead>현장사무소</TableHead>
                    <TableHead>부직포 수량</TableHead>
                    <TableHead>예산 / 낙찰금액</TableHead>
                    <TableHead>낙찰일</TableHead>
                    <TableHead>첨부파일</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((match) => (
                    <TableRow key={match.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{match.noticeNumber}</TableCell>
                      <TableCell className="max-w-xs">
                        <div className="font-medium">{match.siteName ?? match.noticeName ?? "-"}</div>
                        <div className="text-xs text-muted-foreground">{match.demandAgency ?? "-"}</div>
                      </TableCell>
                      <TableCell>{match.workTypeName ?? "-"}</TableCell>
                      <TableCell>{match.bidderName ?? "-"}</TableCell>
                      <TableCell className="text-xs">
                        <div>{match.bidderPhone ?? "-"}</div>
                        <div className="text-muted-foreground">{match.bidderAddress ?? "-"}</div>
                      </TableCell>
                      <TableCell className="max-w-[180px] text-xs">{match.siteOffice ?? "미확인"}</TableCell>
                      <TableCell>{match.quantityText ?? "-"}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        <div>예산 {formatAmount(match.budgetAmount)}</div>
                        <div className="text-muted-foreground">낙찰 {formatAmount(match.awardAmount)}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{match.awardDate ?? "-"}</TableCell>
                      <TableCell>
                        {match.attachmentStoredPath ? (
                          <a
                            className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                            href={`/api/matches/${match.id}/attachment`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Paperclip className="h-3 w-3" />
                            {match.attachmentFileName ?? "파일"}
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
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
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>자동 검색 실행 기록</CardTitle>
            <CardDescription>매일 오전 7시(KST) 자동 실행되며, 필요하면 지금 바로 실행할 수 있습니다.</CardDescription>
          </div>
          <Button size="sm" onClick={handleRunNow} disabled={triggerScan.isPending}>
            {triggerScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            지금 실행
          </Button>
        </CardHeader>
        <CardContent>
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
