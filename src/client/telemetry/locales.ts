/**
 * Minimal zh/en copy for the telemetry tab. The copy follows the DSH i18n
 * system: the client apply attaches the locale service (`ctx.locale`,
 * provided by `@deepseek-ai/dsh-client-locale`) through {@link attachLocale},
 * and `t()`/`isZh()` resolve the active locale from it — the Host-backed
 * `locale.preference` wins over the raw browser language and switches live.
 */

/** The zh dictionary (also registered into the DSH locale registry under {@link LOCALE_NS}). */
export const zh = {
  title: '运行状态',
  context: '上下文',
  contextDesc: '当前会话的请求压力（含系统提示与工具 schema）',
  contextWindowUnknown: '上下文窗口未知',
  pressure: '最近请求',
  projected: '下一请求预计',
  breakdownSystem: '系统',
  breakdownTools: '工具',
  breakdownMessages: '对话',
  noContextYet: '尚无用量数据（第一次模型调用后出现）',
  llm: 'LLM 统计',
  llmDesc: '整个会话日志累计（token 为 provider 报告值，速度为估算）',
  input: '输入',
  output: '输出',
  uncached: '未缓存',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  turns: '轮次',
  steps: '步骤',
  outputSpeed: '输出速度',
  speedUnit: 'tok/s',
  avgTtft: '平均首 token',
  avgTtftUnit: 'ms',
  llmTime: '模型耗时',
  toolTime: '工具耗时',
  timeSeconds: '{s}s',
  timeMinutes: '{m}m {s}s',
  noLlmYet: '尚无 LLM 调用',
  skills: '技能',
  skillsDesc: 'agent 可调用的技能目录（来自 dsh-skill 注册表）',
  skillsLoading: '加载中…',
  skillsError: '技能列表加载失败：{message}',
  skillsEmpty: '当前没有可用技能',
  skillsUnscoped: '无法解析当前会话的作用域，技能目录暂不可用',
  skillsFetchFailed: '获取失败',
  skillsSearchPlaceholder: '搜索技能…',
  skillsNoMatch: '没有匹配「{query}」的技能',
  skillsShowAll: '显示全部 {count} 个',
  skillsCollapse: '收起',
  bindingUnavailable: '会话绑定不可用',
  modelInvocation: '模型可用',
  modelInvocationOn: '已启用',
  modelInvocationOff: '已禁用',
  modelInvocationReadonly: '内置技能为只读，不可切换',
  toggleFailed: '切换失败',
  close: '关闭',
  copy: '复制',
  copied: '已复制',
  detailLocation: '位置',
  detailProvider: 'Provider',
  detailWhenToUse: '适用场景',
  detailLoading: '加载详情…',
  detailError: '加载详情失败：{message}',
  detailNotFound: '技能不存在或无法加载',
  sourceBundled: '内置',
  sourceRuntime: '运行时',
  sourceUser: '用户',
  sourceProject: '项目',
  refresh: '刷新',
  refreshFailed: '刷新失败',
  lastUpdated: '更新于 {time}',
  sessionNone: '无会话',
} as const

/** The en dictionary (also registered into the DSH locale registry). */
export const en: Record<keyof typeof zh, string> = {
  title: 'Telemetry',
  context: 'Context',
  contextDesc: 'Request pressure for this session (incl. system prompt & tool schemas)',
  contextWindowUnknown: 'context window unknown',
  pressure: 'last request',
  projected: 'next request',
  breakdownSystem: 'system',
  breakdownTools: 'tools',
  breakdownMessages: 'messages',
  noContextYet: 'No usage yet (appears after the first model call)',
  llm: 'LLM stats',
  llmDesc: 'Whole-log session totals (tokens are provider-reported, speed is estimated)',
  input: 'Input',
  output: 'Output',
  uncached: 'uncached',
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  turns: 'Turns',
  steps: 'Steps',
  outputSpeed: 'Output speed',
  speedUnit: 'tok/s',
  avgTtft: 'Avg first token',
  avgTtftUnit: 'ms',
  llmTime: 'Model time',
  toolTime: 'Tool time',
  timeSeconds: '{s}s',
  timeMinutes: '{m}m {s}s',
  noLlmYet: 'No LLM calls yet',
  skills: 'Skills',
  skillsDesc: 'The agent\'s skill catalog (from the dsh-skill registry)',
  skillsLoading: 'Loading…',
  skillsError: 'Failed to load skills: {message}',
  skillsEmpty: 'No skills available',
  skillsUnscoped: 'Could not resolve the session scope; the skill catalog is unavailable',
  skillsFetchFailed: 'Fetch failed',
  skillsSearchPlaceholder: 'Search skills…',
  skillsNoMatch: 'No skills match "{query}"',
  skillsShowAll: 'Show all {count}',
  skillsCollapse: 'Collapse',
  bindingUnavailable: 'session binding unavailable',
  modelInvocation: 'Model invocation',
  modelInvocationOn: 'Enabled',
  modelInvocationOff: 'Disabled',
  modelInvocationReadonly: 'Bundled skills are read-only',
  toggleFailed: 'Toggle failed',
  close: 'Close',
  copy: 'Copy',
  copied: 'Copied',
  detailLocation: 'Location',
  detailProvider: 'Provider',
  detailWhenToUse: 'When to use',
  detailLoading: 'Loading detail…',
  detailError: 'Failed to load detail: {message}',
  detailNotFound: 'Skill not found or unloadable',
  sourceBundled: 'bundled',
  sourceRuntime: 'runtime',
  sourceUser: 'user',
  sourceProject: 'project',
  refresh: 'Refresh',
  refreshFailed: 'Refresh failed',
  lastUpdated: 'Updated {time}',
  sessionNone: 'No session',
}

/** The locale namespace this plugin registers dictionaries under. */
export const LOCALE_NS = 'sidebarTelemetry'

type LocaleServiceLike = { getSnapshot(): { active: string } } | undefined
let localeService: LocaleServiceLike

/** Attach the DSH locale service (called once from the client apply). */
export function attachLocale(service: LocaleServiceLike): void {
  localeService = service
}

/** The active locale id ('zh' | 'en'): the DSH locale service's snapshot when attached, else the browser language. */
function activeLocale(): string {
  return localeService?.getSnapshot().active
    ?? (typeof navigator !== 'undefined' ? navigator.language : '')
    ?? 'en'
}

export type CopyKey = keyof typeof zh

/** Translate a copy key; `{name}` placeholders interpolate from `params`. */
export function t(key: CopyKey, params?: Record<string, string | number>): string {
  const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
  let text = dict[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** Whether the active locale is Chinese. */
export function isZh(): boolean {
  return activeLocale().toLowerCase().startsWith('zh')
}

/** Format milliseconds as a compact human duration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const seconds = ms / 1000
  if (seconds < 60) return t('timeSeconds', { s: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) })
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return t('timeMinutes', { m, s })
}

/** Format an epoch ms timestamp as HH:MM:SS. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
