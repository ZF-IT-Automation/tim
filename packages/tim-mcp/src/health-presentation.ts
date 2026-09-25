import type {
  HealthReport,
  MemoryCoverageSeqRange,
  MemoryHealthReport,
  MemorySummaryCoverageReport,
} from 'tim-core';

/** Default MCP preview. The store still samples up to 50; this trims the tool payload. */
export const HEALTH_RANGE_PREVIEW = 5;

export interface HealthRangeMore {
  pendingRanges: number;
  coveredRanges: number;
}

export interface PresentedSummaryCoverage extends MemorySummaryCoverageReport {
  more: HealthRangeMore;
}

export interface PresentedHealthReport extends Omit<HealthReport, 'memory'> {
  memory?: Omit<MemoryHealthReport, 'summaryCoverage'> & {
    summaryCoverage: PresentedSummaryCoverage;
  };
}

function previewRanges(
  ranges: MemoryCoverageSeqRange[],
  total: number,
  verbose: boolean,
): { ranges: MemoryCoverageSeqRange[]; more: number } {
  const shown = verbose ? ranges : ranges.slice(0, HEALTH_RANGE_PREVIEW);
  return { ranges: shown, more: Math.max(0, total - shown.length) };
}

/**
 * Counts stay. Range arrays default to the first 5; `more` is how many were
 * left out of the array (including ranges the store already withheld past 50).
 * `verbose` returns the store's lists unchanged.
 */
export function presentHealthReport(
  report: HealthReport,
  verbose = false,
): PresentedHealthReport {
  const memory = report.memory;
  if (!memory) return { ...report, memory: undefined };
  const coverage = memory.summaryCoverage;
  const pending = previewRanges(coverage.pendingRanges, coverage.pendingRangeCount, verbose);
  const covered = previewRanges(coverage.coveredRanges, coverage.coveredRangeCount, verbose);
  return {
    ...report,
    memory: {
      ...memory,
      summaryCoverage: {
        ...coverage,
        pendingRanges: pending.ranges,
        coveredRanges: covered.ranges,
        pendingRangesTruncated: pending.more > 0,
        coveredRangesTruncated: covered.more > 0,
        more: {
          pendingRanges: pending.more,
          coveredRanges: covered.more,
        },
      },
    },
  };
}
