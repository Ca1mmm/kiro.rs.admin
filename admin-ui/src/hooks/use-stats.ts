import { useQuery } from '@tanstack/react-query'
import {
  getByCredential,
  getByKey,
  getByModel,
  getOverview,
  getOverviewByKey,
  getTimeSeries,
} from '@/api/stats'
import type { StatsFilter, StatsTimeFilter } from '@/types/api'

/**
 * 统计刷新由页面级自动刷新控件统一调度。
 * 不保留上一筛选的数据，避免时间、Key 或账号组标签与旧结果错配。
 */
const COMMON = {
  staleTime: 25_000,
  refetchOnWindowFocus: false,
} as const

export function useOverview() {
  return useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: getOverview,
    ...COMMON,
  })
}

function timeKey(time: StatsTimeFilter) {
  return [
    time.range ?? 'custom',
    time.startDate ?? '',
    time.endDate ?? '',
    time.granularity,
  ] as const
}

export function useTimeSeries(time: StatsTimeFilter, filter?: StatsFilter) {
  return useQuery({
    queryKey: ['stats', 'timeseries', ...timeKey(time), filter?.keyId ?? 'all', filter?.group ?? 'all'],
    queryFn: () => getTimeSeries(time, filter),
    ...COMMON,
  })
}

export function useByModel(time: StatsTimeFilter, filter?: StatsFilter) {
  return useQuery({
    queryKey: ['stats', 'by-model', ...timeKey(time), filter?.keyId ?? 'all', filter?.group ?? 'all'],
    queryFn: () => getByModel(time, filter),
    ...COMMON,
  })
}

export function useByCredential(time: StatsTimeFilter, filter?: StatsFilter) {
  return useQuery({
    queryKey: ['stats', 'by-credential', ...timeKey(time), filter?.keyId ?? 'all', filter?.group ?? 'all'],
    queryFn: () => getByCredential(time, filter),
    ...COMMON,
  })
}

/** Usage Report：keyId/group 都参与请求和缓存键。 */
export function useByKey(time: StatsTimeFilter, filter?: StatsFilter) {
  return useQuery({
    queryKey: ['stats', 'report-by-key', ...timeKey(time), filter?.keyId ?? 'all', filter?.group ?? 'all'],
    queryFn: () => getByKey(time, filter),
    ...COMMON,
  })
}

/** Overview KeyPanel：横向比较全部 Key，刻意忽略 keyId，使用独立缓存空间。 */
export function useOverviewByKey(time: StatsTimeFilter, filter?: StatsFilter) {
  return useQuery({
    queryKey: ['stats', 'overview-by-key', ...timeKey(time), filter?.group ?? 'all'],
    queryFn: () => getOverviewByKey(time, filter),
    ...COMMON,
  })
}
