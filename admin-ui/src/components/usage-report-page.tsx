import { useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  BarChart3,
  Calendar,
  Coins,
  Cpu,
  Download,
  KeyRound,
  RefreshCw,
  Server,
  Wallet,
} from 'lucide-react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PricingCard } from '@/components/pricing-card'
import { TimeSeriesChart } from '@/components/charts/time-series-chart'
import { useClientKeys } from '@/hooks/use-client-keys'
import { useGroupOptions } from '@/hooks/use-groups'
import { usePricingConfig } from '@/hooks/use-pricing'
import { useByCredential, useByKey, useByModel, useTimeSeries } from '@/hooks/use-stats'
import { cn, formatCost, formatCredits, formatNumber } from '@/lib/utils'
import type {
  CredentialDistribution,
  KeyDistribution,
  ModelDistribution,
  StatsFilter,
  StatsGranularity,
  StatsRange,
  StatsTimeFilter,
  TimeSeriesPoint,
} from '@/types/api'

const RANGES: { label: string; value: StatsRange; granularity: StatsGranularity }[] = [
  { label: '24 小时', value: '24h', granularity: 'hour' },
  { label: '7 天', value: '7d', granularity: 'day' },
  { label: '30 天', value: '30d', granularity: 'day' },
]

type CostMetric = 'credits' | 'cost'

type BreakdownRow = {
  key: string
  label: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  credits: number
}

type ReportSummary = {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  credits: number
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function presetStartDate(range: StatsRange, endDate: string): string {
  const days = range === '24h' ? 1 : range === '7d' ? 6 : 29
  const date = new Date(`${endDate}T00:00:00`)
  date.setDate(date.getDate() - days)
  return toDateInputValue(date)
}

function rangeText(time: StatsTimeFilter): string {
  if (time.range) {
    return RANGES.find((item) => item.value === time.range)?.label ?? time.range
  }
  return `${time.startDate ?? ''} 至 ${time.endDate ?? ''}`
}

function aggregateSeries(series: TimeSeriesPoint[]): ReportSummary {
  return series.reduce(
    (total, point) => ({
      calls: total.calls + point.calls,
      errors: total.errors + point.errors,
      inputTokens: total.inputTokens + point.inputTokens,
      outputTokens: total.outputTokens + point.outputTokens,
      cacheCreationTokens: total.cacheCreationTokens + point.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens + point.cacheReadTokens,
      credits: total.credits + (point.credits ?? 0),
    }),
    {
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      credits: 0,
    },
  )
}

function totalTokens(row: Pick<BreakdownRow, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>) {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens
}

function successRate(calls: number, errors: number): number {
  if (calls === 0) return 0
  return Math.max(0, (calls - errors) / calls)
}

function cacheHitRate(summary: ReportSummary): number {
  const total = summary.inputTokens + summary.cacheReadTokens
  return total > 0 ? summary.cacheReadTokens / total : 0
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatTimestamp(ts: string, granularity: StatsGranularity): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (granularity === 'day') return `${month}-${day}`
  return `${month}-${day} ${String(date.getHours()).padStart(2, '0')}:00`
}

export function UsageReportPage() {
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const [activeRange, setActiveRange] = useState<StatsRange | undefined>('7d')
  const [granularity, setGranularity] = useState<StatsGranularity>('day')
  const [startDate, setStartDate] = useState(() => presetStartDate('7d', today))
  const [endDate, setEndDate] = useState(today)
  const [timeFilter, setTimeFilter] = useState<StatsTimeFilter>({ range: '7d', granularity: 'day' })
  const [keyFilter, setKeyFilter] = useState('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const [costMetric, setCostMetric] = useState<CostMetric>('credits')

  const statsFilter = useMemo<StatsFilter>(() => {
    const filter: StatsFilter = {}
    if (keyFilter !== 'all') filter.keyId = Number(keyFilter)
    if (groupFilter !== 'all') filter.group = groupFilter
    return filter
  }, [groupFilter, keyFilter])

  const seriesQuery = useTimeSeries(timeFilter, statsFilter)
  const modelQuery = useByModel(timeFilter, statsFilter)
  const credentialQuery = useByCredential(timeFilter, statsFilter)
  const keyQuery = useByKey(timeFilter, statsFilter)
  const { data: pricing } = usePricingConfig()
  const { data: clientKeys } = useClientKeys()
  const groupOptions = useGroupOptions()

  const series = useMemo(() => seriesQuery.data ?? [], [seriesQuery.data])
  const models = useMemo(() => modelQuery.data ?? [], [modelQuery.data])
  const credentials = useMemo(() => credentialQuery.data ?? [], [credentialQuery.data])
  const keys = useMemo(() => keyQuery.data ?? [], [keyQuery.data])
  const summary = useMemo(() => aggregateSeries(series), [series])
  const unitPrice = pricing?.creditUnitPrice ?? 0
  const currency = pricing?.currency ?? 'USD'
  const isFetching =
    seriesQuery.isFetching || modelQuery.isFetching || credentialQuery.isFetching || keyQuery.isFetching
  const isLoading =
    seriesQuery.isLoading || modelQuery.isLoading || credentialQuery.isLoading || keyQuery.isLoading
  const hasError = seriesQuery.error || modelQuery.error || credentialQuery.error || keyQuery.error

  const applyPreset = (range: StatsRange) => {
    const preset = RANGES.find((item) => item.value === range) ?? RANGES[1]
    const nextEnd = toDateInputValue(new Date())
    setActiveRange(range)
    setGranularity(preset.granularity)
    setStartDate(presetStartDate(range, nextEnd))
    setEndDate(nextEnd)
    setTimeFilter({ range, granularity: preset.granularity })
  }

  const applyCustomRange = () => {
    if (!startDate || !endDate || endDate < startDate) return
    setActiveRange(undefined)
    setTimeFilter({ startDate, endDate, granularity })
  }

  const refreshAll = () => {
    void Promise.all([
      seriesQuery.refetch(),
      modelQuery.refetch(),
      credentialQuery.refetch(),
      keyQuery.refetch(),
    ])
  }

  const exportReport = () => {
    const csv = buildReportCsv({
      credentials,
      currency,
      keys,
      models,
      series,
      summary,
      timeFilter,
      unitPrice,
    })
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const fileRange =
      timeFilter.range ?? `${timeFilter.startDate ?? 'start'}-${timeFilter.endDate ?? 'end'}`
    link.download = `kiro-usage-report-${fileRange}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <ReportHeader
        canExport={!isLoading && !isFetching && !hasError}
        isFetching={isFetching}
        onExport={exportReport}
        onRefresh={refreshAll}
      />
      <PricingCard />
      <ReportFilters
        activeRange={activeRange}
        clientKeys={clientKeys?.keys ?? []}
        endDate={endDate}
        granularity={granularity}
        groupFilter={groupFilter}
        groupOptions={groupOptions}
        keyFilter={keyFilter}
        startDate={startDate}
        onApplyCustom={applyCustomRange}
        onEndDateChange={(value) => {
          setEndDate(value)
          setActiveRange(undefined)
        }}
        onGranularityChange={(value) => {
          setGranularity(value)
          setActiveRange(undefined)
        }}
        onGroupChange={setGroupFilter}
        onKeyChange={setKeyFilter}
        onPreset={applyPreset}
        onStartDateChange={(value) => {
          setStartDate(value)
          setActiveRange(undefined)
        }}
      />

      {hasError ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-10 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            报表加载失败，请刷新重试
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">正在加载报表…</CardContent>
        </Card>
      ) : (
        <>
          <SummaryCards summary={summary} unitPrice={unitPrice} currency={currency} />
          <ReportCharts
            costMetric={costMetric}
            currency={currency}
            granularity={timeFilter.granularity}
            series={series}
            unitPrice={unitPrice}
            onCostMetricChange={setCostMetric}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <BreakdownTable
              icon={<Cpu className="h-4 w-4" />}
              rows={modelRows(models)}
              title="按模型"
              unitPrice={unitPrice}
              currency={currency}
            />
            <BreakdownTable
              icon={<Server className="h-4 w-4" />}
              rows={credentialRows(credentials)}
              title="按上游凭据"
              unitPrice={unitPrice}
              currency={currency}
            />
            <div className="xl:col-span-2">
              <BreakdownTable
                icon={<KeyRound className="h-4 w-4" />}
                rows={keyRows(keys)}
                title="按客户端 Key"
                unitPrice={unitPrice}
                currency={currency}
              />
            </div>
          </div>
          <ReportFootnote
            currency={currency}
            range={rangeText(timeFilter)}
            unitPrice={unitPrice}
          />
        </>
      )}
    </div>
  )
}

function ReportHeader({
  canExport,
  isFetching,
  onExport,
  onRefresh,
}: {
  canExport: boolean
  isFetching: boolean
  onExport: () => void
  onRefresh: () => void
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">用量报表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          基于逐请求用量日志，按时间、客户端 Key 和账号组核算 Token、Credit 与估算费用
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
          <RefreshCw className={cn('mr-1.5 h-4 w-4', isFetching && 'animate-spin')} />
          刷新
        </Button>
        <Button size="sm" onClick={onExport} disabled={!canExport}>
          <Download className="mr-1.5 h-4 w-4" />
          导出 CSV
        </Button>
      </div>
    </div>
  )
}

function ReportFilters({
  activeRange,
  clientKeys,
  endDate,
  granularity,
  groupFilter,
  groupOptions,
  keyFilter,
  startDate,
  onApplyCustom,
  onEndDateChange,
  onGranularityChange,
  onGroupChange,
  onKeyChange,
  onPreset,
  onStartDateChange,
}: {
  activeRange?: StatsRange
  clientKeys: { id: number; name: string }[]
  endDate: string
  granularity: StatsGranularity
  groupFilter: string
  groupOptions: string[]
  keyFilter: string
  startDate: string
  onApplyCustom: () => void
  onEndDateChange: (value: string) => void
  onGranularityChange: (value: StatsGranularity) => void
  onGroupChange: (value: string) => void
  onKeyChange: (value: string) => void
  onPreset: (value: StatsRange) => void
  onStartDateChange: (value: string) => void
}) {
  return (
    <Card className="mb-6">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {RANGES.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={activeRange === item.value ? 'default' : 'outline'}
              onClick={() => onPreset(item.value)}
            >
              {item.label}
            </Button>
          ))}
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
          <DateInput value={startDate} onChange={onStartDateChange} />
          <span className="text-xs text-muted-foreground">至</span>
          <DateInput value={endDate} onChange={onEndDateChange} />
          <Select value={granularity} onValueChange={(value) => onGranularityChange(value as StatsGranularity)}>
            <SelectTrigger className="h-8 w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hour">按小时</SelectItem>
              <SelectItem value="day">按天</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!startDate || !endDate || endDate < startDate}
            onClick={onApplyCustom}
          >
            应用日期
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={keyFilter} onValueChange={onKeyChange}>
            <SelectTrigger className="h-8 w-full sm:w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部客户端 Key</SelectItem>
              {clientKeys.map((key) => (
                <SelectItem key={key.id} value={String(key.id)}>
                  {key.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={groupFilter} onValueChange={onGroupChange}>
            <SelectTrigger className="h-8 w-full sm:w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部账号组</SelectItem>
              {groupOptions.map((group) => (
                <SelectItem key={group} value={group}>
                  {group}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="self-center text-[11px] text-muted-foreground">
            所有卡片、趋势、分布和 CSV 使用同一筛选口径
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function DateInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <Calendar className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="date"
        value={value}
        className="h-8 w-[150px] pl-8 text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function SummaryCards({
  summary,
  unitPrice,
  currency,
}: {
  summary: ReportSummary
  unitPrice: number
  currency: string
}) {
  const tokens = totalTokens(summary)
  const estimatedCost = formatCost(summary.credits, unitPrice, currency)
  const averageCredits = summary.calls > 0 ? summary.credits / summary.calls : 0
  const cards = [
    {
      icon: <Activity className="h-4 w-4" />,
      label: '调用与成功率',
      value: formatNumber(summary.calls),
      hint: `成功率 ${formatPercent(successRate(summary.calls, summary.errors))} · 异常 ${formatNumber(summary.errors)}`,
    },
    {
      icon: <Coins className="h-4 w-4" />,
      label: 'Credit 消耗',
      value: formatCredits(summary.credits),
      hint: `平均 ${formatCredits(averageCredits)} / 次`,
    },
    {
      icon: <Wallet className="h-4 w-4" />,
      label: '估算费用',
      value: estimatedCost ?? '未配置',
      hint: unitPrice > 0 ? `${unitPrice} ${currency} / credit` : '请先配置 Credit 单价',
    },
    {
      icon: <Cpu className="h-4 w-4" />,
      label: 'Token 总量',
      value: formatNumber(tokens),
      hint: `输入 ${formatNumber(summary.inputTokens)} · 输出 ${formatNumber(summary.outputTokens)}`,
    },
    {
      icon: <BarChart3 className="h-4 w-4" />,
      label: '缓存 Token',
      value: formatNumber(summary.cacheCreationTokens + summary.cacheReadTokens),
      hint: `写 ${formatNumber(summary.cacheCreationTokens)} · 读 ${formatNumber(summary.cacheReadTokens)}`,
    },
    {
      icon: <Server className="h-4 w-4" />,
      label: '缓存命中率',
      value: formatPercent(cacheHitRate(summary)),
      hint: '缓存读 /（输入 + 缓存读）',
    },
  ]

  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {card.icon}
              {card.label}
            </div>
            <div className="mt-3 truncate text-xl font-semibold tabular-nums">{card.value}</div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">{card.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ReportCharts({
  costMetric,
  currency,
  granularity,
  series,
  unitPrice,
  onCostMetricChange,
}: {
  costMetric: CostMetric
  currency: string
  granularity: StatsGranularity
  series: TimeSeriesPoint[]
  unitPrice: number
  onCostMetricChange: (metric: CostMetric) => void
}) {
  return (
    <div className="mb-6 grid gap-4 xl:grid-cols-2">
      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="mb-3">
            <h2 className="text-base font-semibold">Token 趋势</h2>
            <p className="text-[11px] text-muted-foreground">输入、输出、缓存写入与缓存读取</p>
          </div>
          <TimeSeriesChart data={series} granularity={granularity} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">调用与计费趋势</h2>
              <p className="text-[11px] text-muted-foreground">调用、异常与 Credit/估算费用</p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={costMetric === 'credits' ? 'secondary' : 'ghost'}
                onClick={() => onCostMetricChange('credits')}
              >
                Credit
              </Button>
              {unitPrice > 0 && (
                <Button
                  size="sm"
                  variant={costMetric === 'cost' ? 'secondary' : 'ghost'}
                  onClick={() => onCostMetricChange('cost')}
                >
                  {currency}
                </Button>
              )}
            </div>
          </div>
          <BillingTrendChart
            currency={currency}
            granularity={granularity}
            metric={costMetric}
            series={series}
            unitPrice={unitPrice}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function BillingTrendChart({
  currency,
  granularity,
  metric,
  series,
  unitPrice,
}: {
  currency: string
  granularity: StatsGranularity
  metric: CostMetric
  series: TimeSeriesPoint[]
  unitPrice: number
}) {
  const data = useMemo(
    () =>
      series.map((point) => ({
        ...point,
        billing: metric === 'cost' ? point.credits * unitPrice : point.credits,
        label: formatTimestamp(point.ts, granularity),
      })),
    [granularity, metric, series, unitPrice],
  )
  const billingName = metric === 'cost' ? `费用 (${currency})` : 'Credit'

  return (
    <div className="h-[260px] sm:h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 4, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
          <YAxis
            yAxisId="calls"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => formatNumber(value)}
            width={48}
            allowDecimals={false}
          />
          <YAxis
            yAxisId="billing"
            orientation="right"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => (metric === 'cost' ? value.toFixed(2) : formatCredits(value))}
            width={50}
          />
          <Tooltip />
          <Legend verticalAlign="top" iconType="circle" wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} />
          <Bar yAxisId="calls" dataKey="calls" name="调用" fill="#3b82f6" opacity={0.55} />
          <Bar yAxisId="calls" dataKey="errors" name="异常" fill="#ef4444" opacity={0.8} />
          <Line
            yAxisId="billing"
            type="monotone"
            dataKey="billing"
            name={billingName}
            stroke="#ec4899"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function modelRows(items: ModelDistribution[]): BreakdownRow[] {
  return items.map((item) => ({
    key: item.model,
    label: item.model,
    calls: item.calls,
    errors: item.errors,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cacheCreationTokens: item.cacheCreationTokens,
    cacheReadTokens: item.cacheReadTokens,
    credits: item.credits,
  }))
}

function credentialRows(items: CredentialDistribution[]): BreakdownRow[] {
  return items.map((item) => ({
    key: String(item.credentialId),
    label: item.email || `凭据 #${item.credentialId}`,
    calls: item.calls,
    errors: item.errors,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cacheCreationTokens: item.cacheCreationTokens,
    cacheReadTokens: item.cacheReadTokens,
    credits: item.credits,
  }))
}

function keyRows(items: KeyDistribution[]): BreakdownRow[] {
  return items.map((item) => ({
    key: String(item.keyId),
    label: item.name,
    calls: item.calls,
    errors: item.errors,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cacheCreationTokens: item.cacheCreationTokens,
    cacheReadTokens: item.cacheReadTokens,
    credits: item.credits,
  }))
}

function BreakdownTable({
  currency,
  icon,
  rows,
  title,
  unitPrice,
}: {
  currency: string
  icon: React.ReactNode
  rows: BreakdownRow[]
  title: string
  unitPrice: number
}) {
  const totalCredits = rows.reduce((sum, row) => sum + row.credits, 0)
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0)
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          {icon}
          <h2 className="text-base font-semibold">{title}</h2>
          <Badge variant="secondary">{rows.length}</Badge>
        </div>
        {rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">当前筛选范围暂无数据</div>
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-[880px] w-full text-xs">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr className="border-b">
                  <th className="pb-2 text-left font-medium">名称</th>
                  <th className="pb-2 text-right font-medium">调用</th>
                  <th className="pb-2 text-right font-medium">成功率</th>
                  <th className="pb-2 text-right font-medium">输入</th>
                  <th className="pb-2 text-right font-medium">输出</th>
                  <th className="pb-2 text-right font-medium">缓存写 / 读</th>
                  <th className="pb-2 text-right font-medium">Credit</th>
                  {unitPrice > 0 && <th className="pb-2 text-right font-medium">估算费用</th>}
                  <th className="pb-2 text-right font-medium">占比</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const share = totalCredits > 0 ? row.credits / totalCredits : row.calls / Math.max(totalCalls, 1)
                  return (
                    <tr key={row.key} className="border-b border-border/50 last:border-0">
                      <td className="max-w-[240px] truncate py-2.5 pr-3 font-medium" title={row.label}>
                        {row.label}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{formatNumber(row.calls)}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatPercent(successRate(row.calls, row.errors))}
                        {row.errors > 0 && <span className="ml-1 text-destructive">({row.errors})</span>}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{formatNumber(row.inputTokens)}</td>
                      <td className="py-2.5 text-right tabular-nums">{formatNumber(row.outputTokens)}</td>
                      <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatNumber(row.cacheCreationTokens)} / {formatNumber(row.cacheReadTokens)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{formatCredits(row.credits)}</td>
                      {unitPrice > 0 && (
                        <td className="py-2.5 text-right tabular-nums">
                          {formatCost(row.credits, unitPrice, currency) ?? '—'}
                        </td>
                      )}
                      <td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground">
                        {(share * 100).toFixed(1)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ReportFootnote({
  currency,
  range,
  unitPrice,
}: {
  currency: string
  range: string
  unitPrice: number
}) {
  return (
    <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
      报表范围：{range}。Credit 来自上游 meteringEvent；费用按当前配置的
      {unitPrice > 0 ? ` ${unitPrice} ${currency}/credit ` : '未配置单价'}即时估算，修改单价会重算历史展示，
      不代表上游账单。Token 来自逐请求 usage_log，包含输入、输出、缓存写入和缓存读取；请求日志页面可继续下钻单次请求与重试链路。
    </p>
  )
}

function csvCell(value: string | number): string {
  const text = String(value)
  // Spreadsheet applications may execute cells beginning with formula sigils.
  // Prefix user-controlled string values with an apostrophe so exports stay data-only.
  const safeText =
    typeof value === 'string' && /^[=+\-@\t\r]/.test(text.trimStart())
      ? `'${text}`
      : text
  return /[",\r\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText
}

function csvRows(rows: Array<Array<string | number>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function buildReportCsv({
  credentials,
  currency,
  keys,
  models,
  series,
  summary,
  timeFilter,
  unitPrice,
}: {
  credentials: CredentialDistribution[]
  currency: string
  keys: KeyDistribution[]
  models: ModelDistribution[]
  series: TimeSeriesPoint[]
  summary: ReportSummary
  timeFilter: StatsTimeFilter
  unitPrice: number
}): string {
  const cost = (credits: number) => (credits * unitPrice).toFixed(6)
  const rows: Array<Array<string | number>> = [
    ['Kiro 用量报表'],
    ['范围', rangeText(timeFilter)],
    ['粒度', timeFilter.granularity],
    ['Credit 单价', unitPrice],
    ['货币', currency],
    [],
    ['汇总'],
    ['调用', '异常', '成功率', '输入 Token', '输出 Token', '缓存写 Token', '缓存读 Token', 'Credit', `估算费用 (${currency})`],
    [summary.calls, summary.errors, formatPercent(successRate(summary.calls, summary.errors)), summary.inputTokens, summary.outputTokens, summary.cacheCreationTokens, summary.cacheReadTokens, summary.credits, cost(summary.credits)],
    [],
    ['时间序列'],
    ['时间', '调用', '异常', '输入 Token', '输出 Token', '缓存写 Token', '缓存读 Token', 'Credit', `估算费用 (${currency})`],
    ...series.map((point) => [point.ts, point.calls, point.errors, point.inputTokens, point.outputTokens, point.cacheCreationTokens, point.cacheReadTokens, point.credits, cost(point.credits)]),
    [],
    ['按模型'],
    ['模型', '调用', '异常', '输入 Token', '输出 Token', '缓存写 Token', '缓存读 Token', 'Credit', `估算费用 (${currency})`],
    ...models.map((item) => [item.model, item.calls, item.errors, item.inputTokens, item.outputTokens, item.cacheCreationTokens, item.cacheReadTokens, item.credits, cost(item.credits)]),
    [],
    ['按上游凭据'],
    ['凭据 ID', '邮箱', '调用', '异常', '输入 Token', '输出 Token', '缓存写 Token', '缓存读 Token', 'Credit', `估算费用 (${currency})`],
    ...credentials.map((item) => [item.credentialId, item.email ?? '', item.calls, item.errors, item.inputTokens, item.outputTokens, item.cacheCreationTokens, item.cacheReadTokens, item.credits, cost(item.credits)]),
    [],
    ['按客户端 Key'],
    ['Key ID', '名称', '调用', '异常', '输入 Token', '输出 Token', '缓存写 Token', '缓存读 Token', 'Credit', `估算费用 (${currency})`],
    ...keys.map((item) => [item.keyId, item.name, item.calls, item.errors, item.inputTokens, item.outputTokens, item.cacheCreationTokens, item.cacheReadTokens, item.credits, cost(item.credits)]),
  ]
  return csvRows(rows)
}
