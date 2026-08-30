import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialDistribution,
  KeyDistribution,
  ModelDistribution,
  OverviewStats,
  StatsFilter,
  StatsTimeFilter,
  TimeSeriesPoint,
} from '@/types/api'

const api = axios.create({
  baseURL: '/api/admin',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) config.headers['x-api-key'] = apiKey
  return config
})

export async function getOverview(): Promise<OverviewStats> {
  const { data } = await api.get<OverviewStats>('/stats/overview')
  return data
}

function statsParams(time: StatsTimeFilter, filter?: StatsFilter) {
  return {
    ...time,
    ...(filter?.keyId !== undefined ? { keyId: filter.keyId } : {}),
    ...(filter?.group ? { group: filter.group } : {}),
  }
}

export async function getTimeSeries(time: StatsTimeFilter, filter?: StatsFilter): Promise<TimeSeriesPoint[]> {
  const { data } = await api.get<TimeSeriesPoint[]>('/stats/timeseries', {
    params: statsParams(time, filter),
  })
  return data
}

export async function getByModel(time: StatsTimeFilter, filter?: StatsFilter): Promise<ModelDistribution[]> {
  const { data } = await api.get<ModelDistribution[]>('/stats/by-model', {
    params: statsParams(time, filter),
  })
  return data
}

export async function getByCredential(time: StatsTimeFilter, filter?: StatsFilter): Promise<CredentialDistribution[]> {
  const { data } = await api.get<CredentialDistribution[]>('/stats/by-credential', {
    params: statsParams(time, filter),
  })
  return data
}

/** 报表查询：尊重 keyId 与 group，保证所有报表分布使用同一筛选口径。 */
export async function getByKey(time: StatsTimeFilter, filter?: StatsFilter): Promise<KeyDistribution[]> {
  const { data } = await api.get<KeyDistribution[]>('/stats/by-key', {
    params: statsParams(time, filter),
  })
  return data
}

/** Overview 横向比较：忽略 keyId，但继续透传 group。 */
export async function getOverviewByKey(time: StatsTimeFilter, filter?: StatsFilter): Promise<KeyDistribution[]> {
  const { data } = await api.get<KeyDistribution[]>('/stats/by-key', {
    params: { ...time, ...(filter?.group ? { group: filter.group } : {}) },
  })
  return data
}
