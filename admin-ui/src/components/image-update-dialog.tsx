import { useEffect, useState } from 'react'
import {
  ChevronDown,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  XCircle,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  applyImageUpdate,
  checkGitHubRateLimit,
  checkSystemUpdate,
  getUpdateConfig,
  pullUpdateImage,
  rollbackImageUpdate,
  setUpdateConfig,
} from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type {
  GitHubRateLimitInfo,
  SetUpdateConfigRequest,
  UpdateMode,
} from '@/types/api'
import { Markdown } from '@/components/markdown'

interface ImageUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const DEFAULT_SOURCE_BRANCH = 'master'
const DEFAULT_SOURCE_UPSTREAM = 'https://github.com/ZyphrZero/kiro.rs.git'

/** 把 RFC3339 时间转成本地时区可读字符串。解析失败时原样返回。 */
function formatDateTime(value: string): string {
  if (!value) return '—'
  const t = Date.parse(value)
  if (Number.isNaN(t)) return value
  return new Date(t).toLocaleString()
}

export function ImageUpdateDialog({ open, onOpenChange }: ImageUpdateDialogProps) {
  const queryClient = useQueryClient()
  const [autoApplyTime, setAutoApplyTime] = useState('03:00')
  const [lastOutput, setLastOutput] = useState('')
  const [tipsOpen, setTipsOpen] = useState(false)
  const [githubToken, setGithubToken] = useState('')
  const [updateMode, setUpdateMode] = useState<UpdateMode>('binary')
  const [sourceRepoPath, setSourceRepoPath] = useState('')
  const [sourceBranch, setSourceBranch] = useState(DEFAULT_SOURCE_BRANCH)
  const [sourceUpstreamGitUrl, setSourceUpstreamGitUrl] = useState(
    DEFAULT_SOURCE_UPSTREAM,
  )
  const [sourceBuildPath, setSourceBuildPath] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['update-config'],
    queryFn: getUpdateConfig,
    enabled: open,
  })

  // 弹窗打开时复用 dashboard 已发起的请求；后台 30 分钟缓存避免重复打 GitHub。
  const { data: updateCheck, isFetching: checkingUpdate } = useQuery({
    queryKey: ['system-update-check'],
    queryFn: () => checkSystemUpdate(false),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })

  // 限流状态：弹窗打开时自动跑一次（用已保存 token），随 update-config 变化复刷
  const { data: rateLimit, isFetching: checkingRate } = useQuery({
    queryKey: ['github-rate-limit', data?.githubTokenSet],
    queryFn: () => checkGitHubRateLimit(),
    enabled: open && data !== undefined,
    staleTime: 60 * 1000,
    retry: 0,
  })

  const refreshUpdateCheck = useMutation({
    mutationFn: () => checkSystemUpdate(true),
    onSuccess: (info) => {
      queryClient.setQueryData(['system-update-check'], info)
      if (info.warning) {
        toast.error(info.warning)
      } else if (info.hasUpdate) {
        toast.success(`发现新版本 v${info.latestVersion}`)
      } else {
        toast.success('当前已是最新版本')
      }
    },
    onError: (err) => toast.error(`检查更新失败: ${extractErrorMessage(err)}`),
  })

  const autoApplyMutation = useMutation({
    mutationFn: (autoApply: boolean) => setUpdateConfig({ autoApply }),
    onMutate: async (autoApply) => {
      // 先做乐观更新，开关切换的视觉反馈瞬时生效
      const prev = queryClient.getQueryData<typeof data>(['update-config'])
      if (prev) {
        queryClient.setQueryData(['update-config'], { ...prev, autoApply })
      }
      return { prev }
    },
    onSuccess: (res) => {
      queryClient.setQueryData(['update-config'], res)
      toast.success(res.autoApply ? '已开启自动更新' : '已关闭自动更新')
    },
    onError: (err, _variables, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(['update-config'], ctx.prev)
      }
      toast.error(`切换失败: ${extractErrorMessage(err)}`)
    },
  })

  const autoApplyTimeMutation = useMutation({
    mutationFn: (autoApplyTime: string) => setUpdateConfig({ autoApplyTime }),
    onSuccess: (res) => {
      queryClient.setQueryData(['update-config'], res)
      toast.success(`自动更新时间已设为 ${res.autoApplyTime}`)
    },
    onError: (err) => toast.error(`保存时间失败: ${extractErrorMessage(err)}`),
  })

  useEffect(() => {
    if (!data) return
    setAutoApplyTime(data.autoApplyTime || '03:00')
    setUpdateMode(data.updateMode || 'binary')
    setSourceRepoPath(data.sourceRepoPath || '')
    setSourceBranch(data.sourceBranch || DEFAULT_SOURCE_BRANCH)
    setSourceUpstreamGitUrl(data.sourceUpstreamGitUrl || DEFAULT_SOURCE_UPSTREAM)
    setSourceBuildPath(data.sourceBuildPath || '')
    // 弹窗打开时把 token 输入框清空：后端不回显明文，输入框为空时表示"保持原值"
    setGithubToken('')
  }, [data])

  const updateModeMutation = useMutation({
    mutationFn: (config: SetUpdateConfigRequest) => setUpdateConfig(config),
    onSuccess: (res) => {
      queryClient.setQueryData(['update-config'], res)
      queryClient.invalidateQueries({ queryKey: ['system-update-check'] })
      toast.success(
        res.updateMode === 'source'
          ? '已保存源码合并更新方式'
          : '已保存官方二进制更新方式',
      )
    },
    onError: (err) => toast.error(`保存更新方式失败: ${extractErrorMessage(err)}`),
  })

  const saveUpdateMode = () => {
    const config = {
      updateMode,
      sourceRepoPath: sourceRepoPath.trim(),
      sourceBranch: sourceBranch.trim(),
      sourceUpstreamGitUrl: sourceUpstreamGitUrl.trim(),
      sourceBuildPath: sourceBuildPath.trim(),
    }

    if (
      config.updateMode === 'source' &&
      (!config.sourceRepoPath ||
        !config.sourceBranch ||
        !config.sourceUpstreamGitUrl ||
        !config.sourceBuildPath)
    ) {
      toast.error('源码仓库、分支、上游 URL 和构建 PATH 均不能为空')
      return
    }
    if (config.updateMode === 'source' && !config.sourceRepoPath.startsWith('/')) {
      toast.error('源码仓库必须是以 / 开头的绝对路径')
      return
    }

    updateModeMutation.mutate(config)
  }

  const githubTokenMutation = useMutation({
    mutationFn: (token: string) => setUpdateConfig({ githubToken: token }),
    onSuccess: (res) => {
      queryClient.setQueryData(['update-config'], res)
      // 保存成功后立刻强制重新检查，让用户看到新 token 是否能解锁限流
      queryClient.invalidateQueries({ queryKey: ['system-update-check'] })
      queryClient.invalidateQueries({ queryKey: ['github-rate-limit'] })
      setGithubToken('')
      toast.success(res.githubTokenSet ? 'GitHub Token 已保存' : 'GitHub Token 已清除')
    },
    onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
  })

  // "验证"按钮：用输入框的 token 调一次 /rate_limit，不保存到 config
  const verifyTokenMutation = useMutation({
    mutationFn: (token: string) => checkGitHubRateLimit(token),
    onSuccess: (info) => {
      if (info.valid) {
        toast.success(
          info.login
            ? `Token 有效，账号 ${info.login}，剩余 ${info.remaining}/${info.limit}`
            : `Token 有效，剩余 ${info.remaining}/${info.limit}`,
        )
      } else {
        toast.error(info.warning || 'Token 验证失败')
      }
    },
    onError: (err) => toast.error(`验证失败: ${extractErrorMessage(err)}`),
  })

  const pullMutation = useMutation({
    mutationFn: (mode: UpdateMode) => pullUpdateImage(mode),
    onSuccess: (res) => {
      setLastOutput(res.output || res.message)
      toast.success(res.message)
    },
    onError: (err) => toast.error(`准备失败: ${extractErrorMessage(err)}`),
  })

  const applyMutation = useMutation({
    mutationFn: (mode: UpdateMode) => applyImageUpdate(mode),
    onSuccess: (res) => {
      setLastOutput(res.output || res.message)
      toast.success(res.message)
      queryClient.invalidateQueries({ queryKey: ['update-config'] })
    },
    onError: (err) => toast.error(`更新失败: ${extractErrorMessage(err)}`),
  })

  const rollbackMutation = useMutation({
    mutationFn: rollbackImageUpdate,
    onSuccess: (res) => {
      setLastOutput(res.output || res.message)
      toast.success(res.message)
      queryClient.invalidateQueries({ queryKey: ['update-config'] })
    },
    onError: (err) => toast.error(`回退失败: ${extractErrorMessage(err)}`),
  })

  const sourceTaskPending =
    (pullMutation.isPending && pullMutation.variables === 'source') ||
    (applyMutation.isPending && applyMutation.variables === 'source')

  const busy =
    isLoading ||
    pullMutation.isPending ||
    applyMutation.isPending ||
    rollbackMutation.isPending ||
    updateModeMutation.isPending ||
    autoApplyMutation.isPending ||
    autoApplyTimeMutation.isPending ||
    githubTokenMutation.isPending ||
    verifyTokenMutation.isPending

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && sourceTaskPending) {
      toast.warning('源码更新任务仍在执行，完成前不能关闭窗口')
      return
    }
    onOpenChange(nextOpen)
  }

  const handleApply = () => {
    const mode = data?.updateMode ?? 'binary'
    if (
      mode === 'source' &&
      !window.confirm(
        '应用源码更新会二次校验 HEAD，仅以 fast-forward 推进本地源码分支，安装构建产物并退出当前进程；随后由进程守护器/部署环境接管重启。确认继续？',
      )
    ) {
      return
    }
    applyMutation.mutate(data?.updateMode ?? 'binary')
  }

  const handleRollback = () => {
    if (
      (data?.updateMode ?? 'binary') === 'source' &&
      !window.confirm(
        '回退只会恢复运行二进制，不会 reset 或回退本地源码分支。确认继续？',
      )
    ) {
      return
    }
    rollbackMutation.mutate()
  }

  const hasSourceAudit =
    data?.sourceLastMergedTag || data?.sourceLastMergedCommit || data?.sourcePreviousHead

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
        onOpenAutoFocus={(e) => {
          // 阻止 Radix 默认把焦点丢到第一个可聚焦子元素（信息按钮），
          // 否则 Tooltip 的受控开关会被 onFocus 立刻触发。
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4" />
            在线更新
            <TooltipProvider delayDuration={0} disableHoverableContent={false}>
              <Tooltip open={tipsOpen} onOpenChange={setTipsOpen}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="在线更新前置条件"
                    onClick={() => setTipsOpen((v) => !v)}
                    onMouseEnter={() => setTipsOpen(true)}
                    onMouseLeave={() => setTipsOpen(false)}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  collisionPadding={12}
                  onMouseEnter={() => setTipsOpen(true)}
                  onMouseLeave={() => setTipsOpen(false)}
                >
                  <div className="mb-1 font-medium">在线更新机制</div>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>binary 使用官方 Release 二进制并校验 SHA256</li>
                    <li>source 合并官方 Release tag，通过隔离构建和测试后安装产物</li>
                    <li>
                      旧版运行文件保留为 <code className="font-mono">.backup</code>
                    </li>
                    <li>进程退出后由进程守护器/部署环境接管重启</li>
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Sparkles className="h-4 w-4" />
                版本信息
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || refreshUpdateCheck.isPending}
                onClick={() => refreshUpdateCheck.mutate()}
              >
                {refreshUpdateCheck.isPending || checkingUpdate ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span className="ml-1.5">立即检查</span>
              </Button>
            </div>

            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <div className="flex items-baseline gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">当前版本</dt>
                <dd className="font-mono">
                  {updateCheck?.currentVersion
                    ? `v${updateCheck.currentVersion}`
                    : '加载中…'}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">最新版本</dt>
                <dd className="font-mono">
                  {updateCheck?.latestVersion
                    ? `v${updateCheck.latestVersion}`
                    : updateCheck
                      ? '未知'
                      : '加载中…'}
                  {updateCheck?.hasUpdate && (
                    <Badge variant="success" className="ml-2 align-middle">
                      可更新
                    </Badge>
                  )}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">构建类型</dt>
                <dd>
                  {updateCheck?.buildType === 'source'
                    ? '源码合并构建'
                    : updateCheck?.buildType === 'binary'
                      ? '官方二进制'
                      : '加载中…'}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">发布时间</dt>
                <dd className="font-mono">
                  {updateCheck?.publishedAt
                    ? formatDateTime(updateCheck.publishedAt)
                    : '—'}
                </dd>
              </div>
            </dl>

            {updateCheck?.releaseNotes && (
              <ReleaseNotesPanel
                version={updateCheck.latestVersion}
                title={updateCheck.releaseName}
                notes={updateCheck.releaseNotes}
                href={updateCheck.releaseUrl}
              />
            )}

            {!updateCheck?.releaseNotes && updateCheck?.releaseUrl && (
              <div className="mt-2 text-xs">
                <a
                  href={updateCheck.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:no-underline"
                >
                  查看 Release Notes
                </a>
              </div>
            )}

            {updateCheck?.warning && (
              <div className="mt-2 text-xs text-destructive">{updateCheck.warning}</div>
            )}
          </section>

          <section className="space-y-3 border-t pt-4">
            <div className="text-sm font-medium text-foreground">更新方式</div>
            <div
              role="radiogroup"
              aria-label="更新方式"
              className="grid gap-2 sm:grid-cols-2"
            >
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-xs transition-colors ${
                  updateMode === 'binary' ? 'border-primary bg-primary/5' : ''
                }`}
              >
                <input
                  type="radio"
                  name="update-mode"
                  value="binary"
                  checked={updateMode === 'binary'}
                  onChange={() => setUpdateMode('binary')}
                  disabled={busy || !data}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-foreground">官方二进制</span>
                  <span className="text-muted-foreground">
                    下载并校验官方 Release 二进制。
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-xs transition-colors ${
                  updateMode === 'source' ? 'border-primary bg-primary/5' : ''
                }`}
              >
                <input
                  type="radio"
                  name="update-mode"
                  value="source"
                  checked={updateMode === 'source'}
                  onChange={() => setUpdateMode('source')}
                  disabled={busy || !data}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-foreground">源码合并构建</span>
                  <span className="text-muted-foreground">
                    合并官方 Release tag 后在本地构建和测试。
                  </span>
                </span>
              </label>
            </div>

            {updateMode === 'source' && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-foreground">源码仓库绝对路径</span>
                    <Input
                      value={sourceRepoPath}
                      onChange={(e) => setSourceRepoPath(e.target.value)}
                      disabled={busy}
                      placeholder="/opt/kiro.rs"
                      className="font-mono text-sm"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-foreground">本地分支</span>
                    <Input
                      value={sourceBranch}
                      onChange={(e) => setSourceBranch(e.target.value)}
                      disabled={busy}
                      placeholder={DEFAULT_SOURCE_BRANCH}
                      className="font-mono text-sm"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-foreground">上游 Git URL</span>
                    <Input
                      value={sourceUpstreamGitUrl}
                      onChange={(e) => setSourceUpstreamGitUrl(e.target.value)}
                      disabled={busy}
                      placeholder={DEFAULT_SOURCE_UPSTREAM}
                      className="font-mono text-sm"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-foreground">构建 PATH</span>
                    <Input
                      value={sourceBuildPath}
                      onChange={(e) => setSourceBuildPath(e.target.value)}
                      disabled={busy}
                      placeholder="/usr/local/bin:/usr/bin:/bin"
                      className="font-mono text-sm"
                    />
                  </label>
                </div>

                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
                  <div className="font-medium">源码更新安全要求</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>
                      主仓库必须是绝对 top-level，指定分支已 checkout，tracked/untracked
                      全部干净。
                    </li>
                    <li>
                      准备阶段只在 detached 临时 worktree 合并 Release tag，并运行 npm build +
                      cargo check/test/release，可能耗时 2 小时以上。
                    </li>
                    <li>
                      应用前执行二次 CAS，仅以 ff-only 推进源码分支；冲突、build/test 失败或
                      HEAD 变化都会停止且不部署。
                    </li>
                    <li>回退只恢复运行二进制，不 reset Git。</li>
                  </ul>
                </div>
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !data}
              onClick={saveUpdateMode}
            >
              {updateModeMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5">保存更新方式</span>
            </Button>

            {hasSourceAudit && (
              <div className="rounded-md border bg-muted/30 p-3 text-xs">
                <div className="mb-2 font-medium text-foreground">源码更新审计</div>
                <dl className="space-y-1.5 text-muted-foreground">
                  {data?.sourceLastMergedTag && (
                    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                      <dt>合并 tag</dt>
                      <dd className="min-w-0 truncate" title={data.sourceLastMergedTag}>
                        {data.sourceLastMergedTag}
                      </dd>
                    </div>
                  )}
                  {data?.sourceLastMergedCommit && (
                    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                      <dt>合并 commit</dt>
                      <dd
                        className="min-w-0 truncate font-mono"
                        title={data.sourceLastMergedCommit}
                      >
                        {data.sourceLastMergedCommit}
                      </dd>
                    </div>
                  )}
                  {data?.sourcePreviousHead && (
                    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                      <dt>更新前 HEAD</dt>
                      <dd
                        className="min-w-0 truncate font-mono"
                        title={data.sourcePreviousHead}
                      >
                        {data.sourcePreviousHead}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </section>

          <section className="space-y-3 border-t pt-4">
            {data?.previousVersion && (
              <div className="text-xs text-muted-foreground">
                上一版本：
                <code className="font-mono">{data.previousVersion}</code>
                {data.updateMode === 'source' ? '（仅可回退运行二进制）' : '（可一键回退）'}
              </div>
            )}

            {data?.lastAppliedAt && (
              <div className="text-xs text-muted-foreground">
                上次更新于：
                <span className="font-mono">{formatDateTime(data.lastAppliedAt)}</span>
              </div>
            )}

            <div className="flex items-start justify-between gap-3">
              <div className="text-xs">
                <div className="font-medium text-foreground">无人值守自动更新</div>
                <div className="text-muted-foreground">
                  开启后服务每天自动检查，按已保存的更新方式准备并应用新版，重启由进程守护器/部署环境接管。
                </div>
                {data?.updateMode === 'source' && (
                  <div className="mt-1 text-amber-700 dark:text-amber-400">
                    源码自动更新会运行完整合并、构建和测试；安全校验失败即停止，成功推进的源码分支不会随二进制回退。
                  </div>
                )}
              </div>
              <Switch
                checked={!!data?.autoApply}
                disabled={busy}
                onCheckedChange={(checked) => autoApplyMutation.mutate(checked)}
              />
            </div>

            <label
              className={`flex items-center justify-between gap-3 text-xs ${
                data?.autoApply ? '' : 'opacity-60'
              }`}
            >
              <span className="text-muted-foreground">触发时间（本地时区，HH:MM）</span>
              <Input
                type="time"
                value={autoApplyTime}
                onChange={(e) => setAutoApplyTime(e.target.value)}
                onBlur={() => {
                  if (autoApplyTime && autoApplyTime !== data?.autoApplyTime) {
                    autoApplyTimeMutation.mutate(autoApplyTime)
                  }
                }}
                disabled={busy || !data?.autoApply}
                className="w-28 font-mono text-sm"
              />
            </label>
          </section>

          <section className="space-y-2 border-t pt-4">
            <div className="text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <KeyRound className="h-3.5 w-3.5" />
                GitHub Token
                {data?.githubTokenSet && (
                  <Badge variant="success" className="ml-1">已配置</Badge>
                )}
              </div>
              <div className="text-muted-foreground">
                把 GitHub API 限流从匿名 60/小时 提升到认证 5000/小时；只读权限即可。
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={
                  data?.githubTokenSet ? '已保存（输入新值会覆盖）' : 'ghp_xxxxxxxxxxxx'
                }
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                disabled={busy}
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !githubToken.trim()}
                onClick={() => verifyTokenMutation.mutate(githubToken.trim())}
                title="不保存，先用此 token 调用 /rate_limit 测试"
              >
                {verifyTokenMutation.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                <span className="ml-1.5">验证</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !githubToken.trim()}
                onClick={() => githubTokenMutation.mutate(githubToken.trim())}
              >
                {githubTokenMutation.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                <span className="ml-1.5">保存</span>
              </Button>
              {data?.githubTokenSet && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => githubTokenMutation.mutate('')}
                  title="清除已保存的 GitHub Token"
                >
                  清除
                </Button>
              )}
            </div>
            <RateLimitSummary
              info={rateLimit}
              loading={checkingRate}
              onRefresh={() =>
                queryClient.invalidateQueries({ queryKey: ['github-rate-limit'] })
              }
            />
          </section>

          {lastOutput && (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">最近输出</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                {lastOutput}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => pullMutation.mutate(data?.updateMode ?? 'binary')}
            >
              {pullMutation.isPending ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {pullMutation.isPending
                ? pullMutation.variables === 'source'
                  ? '合并构建中…'
                  : '下载中…'
                : (data?.updateMode ?? 'binary') === 'source'
                  ? '准备源码更新'
                  : '下载二进制'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !data?.previousVersion}
              onClick={handleRollback}
              title={
                data?.previousVersion
                  ? data.updateMode === 'source'
                    ? `仅回退运行二进制到 ${data.previousVersion}，不回退源码分支`
                    : `回退到 ${data.previousVersion}`
                  : '尚未记录可回退的版本'
              }
            >
              {rollbackMutation.isPending ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-2" />
              )}
              回退到上一版本
            </Button>
          </div>
          <Button
            type="button"
            disabled={busy || !updateCheck?.hasUpdate}
            onClick={handleApply}
            title={
              updateCheck?.hasUpdate
                ? `应用 v${updateCheck.latestVersion} 并重启`
                : updateCheck?.currentVersion
                  ? `当前已是最新版本 v${updateCheck.currentVersion}`
                  : '正在检查更新…'
            }
          >
            {applyMutation.isPending ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4 mr-2" />
            )}
            {applyMutation.isPending
              ? applyMutation.variables === 'source'
                ? '合并构建中…'
                : '应用中…'
              : '应用更新并重启'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ReleaseNotesPanelProps {
  version: string
  title?: string
  notes: string
  href?: string
}

/**
 * 折叠面板：展示当前版本的 Changelog（GitHub Release body 原文）。
 * 使用轻量 markdown 渲染器还原标题/列表/代码块/链接等，复杂样式仍可点击「在 GitHub 查看」打开。
 */
function ReleaseNotesPanel({ version, title, notes, href }: ReleaseNotesPanelProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3 rounded-md border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-foreground hover:bg-accent/40"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span>查看 v{version} 更新内容</span>
          {title && (
            <span className="font-normal text-muted-foreground">— {title}</span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t px-3 py-2.5 text-xs">
          <div className="max-h-72 overflow-auto pr-1 text-muted-foreground">
            <Markdown text={notes} />
          </div>
          {href && (
            <div className="mt-2">
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs underline hover:no-underline"
              >
                <ExternalLink className="h-3 w-3" />
                在 GitHub 查看完整 Release
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface RateLimitSummaryProps {
  info: GitHubRateLimitInfo | undefined
  loading: boolean
  onRefresh: () => void
}

/**
 * GitHub API 限流摘要卡片：
 * - 是否带 token（认证 vs 匿名）
 * - 已用 / 上限 / 剩余 + 进度条
 * - 限流窗口重置时间（本地时区）
 * - 失败时把 warning 直接展示出来
 *
 * `/rate_limit` 端点本身不消耗配额，可以放心点「刷新」按钮重查。
 */
function RateLimitSummary({ info, loading, onRefresh }: RateLimitSummaryProps) {
  if (loading && !info) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        正在查询 GitHub API 限流…
      </div>
    )
  }
  if (!info) return null

  const used = info.used ?? 0
  const limit = info.limit ?? 0
  const remaining = info.remaining ?? 0
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0
  const danger = info.valid && limit > 0 && remaining <= Math.max(5, Math.floor(limit / 20))
  const resetText = info.reset ? new Date(info.reset * 1000).toLocaleString() : '—'

  return (
    <div className="px-1 py-1 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          {info.valid ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          )}
          API 限流
          <Badge variant={info.authenticated ? 'success' : 'secondary'} className="ml-1">
            {info.authenticated ? '已认证' : '匿名'}
          </Badge>
          {info.login && (
            <span className="ml-1 text-muted-foreground">@{info.login}</span>
          )}
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2" onClick={onRefresh}>
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {info.valid ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono">
            <span className={danger ? 'text-amber-700 dark:text-amber-400' : ''}>
              已用 {used} / {limit}
            </span>
            <span className="text-muted-foreground">·</span>
            <span>剩余 {remaining}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${
                danger ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <div className="mt-1.5 text-muted-foreground">
            重置于：<span className="font-mono">{resetText}</span>
          </div>
        </>
      ) : (
        <div className="mt-1.5 text-destructive">{info.warning || 'Token 验证失败'}</div>
      )}
    </div>
  )
}
