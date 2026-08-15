/**
 * The telemetry tab: three collapsible sections rendered inside the
 * dsh-better-sidebar right/bottom panel for one session.
 *
 * - 上下文 (Context): request pressure vs the provider-reported context
 *   window, plus the heuristic system/tools/messages breakdown.
 * - LLM 统计 (LLM stats): whole-log token buckets (input / output / cache),
 *   turn & step counts, and estimated output speed + first-token latency
 *   computed from the sessionStats projection's wall times.
 * - 技能 (Skills): the agent's skill catalog served by the plugin's host
 *   half (`ctx.skills.list`, cwd-scoped), polled while the tab is visible;
 *   searchable, and shown as a compact grid with a "show all" fold so a long
 *   catalog never floods the panel.
 *
 * All projection data (tokenUsage / contextPressure / contextBreakdown /
 * sessionStats) comes from DSH's own session-projection seam — the host
 * computes, the client reads finished whole values through the session
 * binding's projection faces (per-key observables). The host half only
 * contributes the skills route.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '../../context-types.ts'
import type {
  SidebarContextBreakdown,
  SidebarContextPressure,
  SidebarSessionStats,
  SidebarSkillDefinition,
  SidebarSkillSummary,
  SidebarTokenUsage,
} from '../../context-types.ts'
import { fetchSkillDetail, fetchSkills, setSkillModelInvocation } from './api.ts'
import { formatDuration, t } from './locales.ts'
import css from './telemetry.module.css'

/** Read one host-computed projection value for a session through the binding. */
function useProjection<T>(
  ctx: Context,
  sessionId: string,
  key: 'tokenUsage' | 'contextPressure' | 'contextBreakdown' | 'sessionStats',
): { value: T | undefined; bindingOk: boolean } {
  const sessions = ctx.sessions
  const [, force] = useReducer((x: number) => x + 1, 0)
  // The binding/scope lifecycle follows the sessions list feed; a list change
  // can (un)scope the session, so re-resolve the face on every list update.
  useEffect(() => sessions.list.subscribe(force), [sessions])
  const binding = sessions.binding(sessionId)
  const face = binding?.session.projections.faceOf(key)
  const fallback = sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.[key] as T | undefined
  const value = useSyncExternalStore(
    useCallback((cb) => (face !== undefined ? face.subscribe(cb) : () => {}), [face]),
    useCallback(() => (face !== undefined ? (face.getSnapshot() as T) : fallback), [face, fallback]),
  )
  return { value, bindingOk: binding !== undefined }
}

/** Poll the skills catalog while the tab is visible (30s); stop while hidden. */
function useSkills(
  ctx: Context,
  scope: { sessionId: string; cwd?: string },
  visible: boolean,
): {
  skills: SidebarSkillSummary[] | null
  error: string | null
  fetchedAt: number | null
  scoped: boolean | null
  /** Optimistically patch one skill row after a successful toggle. */
  patchSkill: (name: string, patch: Partial<SidebarSkillSummary>) => void
} {
  const [state, setState] = useState<{
    skills: SidebarSkillSummary[] | null
    error: string | null
    fetchedAt: number | null
    scoped: boolean | null
  }>({ skills: null, error: null, fetchedAt: null, scoped: null })
  const patchSkill = useCallback((name: string, patch: Partial<SidebarSkillSummary>): void => {
    setState(prev => prev.skills === null
      ? prev
      : { ...prev, skills: prev.skills.map(s => (s.name === name ? { ...s, ...patch } : s)) })
  }, [])
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const result = await fetchSkills(scope.sessionId, scope.cwd, controller.signal)
        if (cancelled) return
        setState({
          skills: result.skills,
          error: result.error ?? null,
          fetchedAt: result.fetchedAt,
          scoped: result.scoped ?? null,
        })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === 'AbortError')) return
        setState(prev => ({ ...prev, error: cause instanceof Error ? cause.message : String(cause) }))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 30_000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [visible, scope.sessionId, scope.cwd])
  return { ...state, patchSkill }
}

/** Map a skill source bucket to a display label. */
function sourceLabel(source: string): string {
  if (source === 'bundled') return t('sourceBundled')
  if (source === 'runtime' || source === 'custom') return t('sourceRuntime')
  if (source === 'user-dsh' || source === 'user-agents') return t('sourceUser')
  if (source === 'project-dsh' || source === 'project-agents') return t('sourceProject')
  return source
}

/** Compact number formatting for a narrow panel (12.3k / 1.2M). */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

/** One collapsible section with a chevron header. */
function Section(props: {
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className={css.section}>
      <button type="button" className={css.sectionHeader} onClick={props.onToggle}>
        <span className={props.open ? css.chevronOpen : css.chevron} />
        <span className={css.sectionTitle}>{props.title}</span>
        {props.count !== undefined && <span className={css.sectionCount}>{props.count}</span>}
      </button>
      {props.open && <div className={css.sectionBody}>{props.children}</div>}
    </section>
  )
}

/** One stat tile (label + value + optional sub). */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): React.ReactElement {
  return (
    <div className={css.stat}>
      <div className={css.statLabel}>{label}</div>
      <div className={css.statValue}>{value}</div>
      {sub !== undefined && <div className={css.statSub}>{sub}</div>}
    </div>
  )
}

/** Load state of one skill detail fetch. */
type DetailState =
  | { status: 'loading' }
  | { status: 'ok'; data: SidebarSkillDefinition }
  | { status: 'error'; message: string }

/** Eye icon: solid when the skill is model-invocable, slashed when disabled. */
function EyeIcon({ enabled, size = 13 }: { enabled: boolean; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="2.1" fill={enabled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
      {!enabled && (
        <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  )
}

/**
 * Full-screen detail modal for one skill: metadata (source, provider,
 * location path with a copy button), a model-invocation toggle, and the
 * SKILL.md body.
 */
function SkillDetailModal(props: {
  skill: SidebarSkillSummary
  detail: DetailState
  onClose: () => void
  onToggle: (skill: SidebarSkillSummary, enabled: boolean) => Promise<string | null>
  toggleBusy: boolean
}): React.ReactElement {
  const { skill, detail, onClose, onToggle, toggleBusy } = props
  const [copied, setCopied] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const path = detail.status === 'ok' ? detail.data.path : undefined
  const copyPath = async (): Promise<void> => {
    if (path === undefined) return
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  const modelEnabled = skill.invocation?.modelInvocable ?? true
  const canToggle = skill.source !== 'bundled' && path !== undefined
  const handleToggle = async (): Promise<void> => {
    if (!canToggle || toggleBusy) return
    setToggleError(null)
    const error = await onToggle(skill, !modelEnabled)
    if (error !== null) setToggleError(error)
  }

  return createPortal(
    <div className={css.modalOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={css.modal} role="dialog" aria-modal="true" aria-label={skill.name}>
        <header className={css.modalHeader}>
          <div className={css.modalTitleRow}>
            <code className={css.modalName}>{skill.name}</code>
            <span className={css.skillBadge}>{sourceLabel(skill.source)}</span>
          </div>
          <button type="button" className={css.modalClose} onClick={onClose} aria-label={t('close')}>✕</button>
        </header>

        <div className={css.modalMeta}>
          {path !== undefined && (
            <div className={css.modalMetaRow}>
              <span className={css.modalMetaLabel}>{t('detailLocation')}</span>
              <code className={css.modalPath} title={path}>{path}</code>
              <button type="button" className={css.copyBtn} onClick={() => void copyPath()}>
                {copied ? t('copied') : t('copy')}
              </button>
            </div>
          )}
          <div className={css.modalMetaRow}>
            <span className={css.modalMetaLabel}>{t('detailProvider')}</span>
            <span className={css.modalMetaValue}>{skill.provider}</span>
          </div>
          {skill.whenToUse !== undefined && skill.whenToUse !== '' && (
            <div className={css.modalMetaRow}>
              <span className={css.modalMetaLabel}>{t('detailWhenToUse')}</span>
              <span className={css.modalMetaValue}>{skill.whenToUse}</span>
            </div>
          )}
          <div className={css.modalMetaRow}>
            <span className={css.modalMetaLabel}>{t('modelInvocation')}</span>
            <span className={css.modalMetaValue}>
              {modelEnabled ? t('modelInvocationOn') : t('modelInvocationOff')}
            </span>
            <button
              type="button"
              className={css.modalToggle}
              onClick={() => void handleToggle()}
              disabled={!canToggle || toggleBusy}
              role="switch"
              aria-checked={modelEnabled}
              aria-label={t('modelInvocation')}
            >
              <span className={modelEnabled ? css.modalToggleOn : css.modalToggleOff} />
            </button>
          </div>
          {toggleError !== null && <div className={css.modalToggleError}>{toggleError}</div>}
          {!canToggle && (
            <div className={css.modalToggleHint}>{t('modelInvocationReadonly')}</div>
          )}
        </div>

        <div className={css.modalBody}>
          {detail.status === 'loading' && <div className={css.empty}>{t('detailLoading')}</div>}
          {detail.status === 'error' && <div className={css.error}>{t('detailError', { message: detail.message })}</div>}
          {detail.status === 'ok' && (
            <>
              {detail.data.description !== '' && (
                <p className={css.modalDesc}>{detail.data.description}</p>
              )}
              <pre className={css.modalPre}>{detail.data.content}</pre>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const SKILLS_PREVIEW_COUNT = 8

/** The tab body. */
export function TelemetryTab(props: {
  ctx: Context
  scope: { sessionId: string; cwd?: string }
  visible: boolean
}): React.ReactElement {
  const { ctx, scope, visible } = props
  const sessionId = scope.sessionId
  const tokenUsage = useProjection<SidebarTokenUsage>(ctx, sessionId, 'tokenUsage')
  const pressure = useProjection<SidebarContextPressure>(ctx, sessionId, 'contextPressure')
  const breakdown = useProjection<SidebarContextBreakdown>(ctx, sessionId, 'contextBreakdown')
  const stats = useProjection<SidebarSessionStats>(ctx, sessionId, 'sessionStats')
  const skills = useSkills(ctx, scope, visible)
  const session = ctx.sessions.list.getSnapshot().byId[sessionId]

  // Section collapse state (per tab lifetime; not persisted).
  const [open, setOpen] = useState<{ context: boolean; llm: boolean; skills: boolean }>(
    { context: true, llm: true, skills: true },
  )
  // Skill search + show-all fold.
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  // Skill detail modal: the opened summary + its load state.
  const [detailSkill, setDetailSkill] = useState<SidebarSkillSummary | null>(null)
  const [detailState, setDetailState] = useState<DetailState>({ status: 'loading' })
  const detailRequestSeq = useRef(0)
  const openDetail = (skill: SidebarSkillSummary): void => {
    setDetailSkill(skill)
    setDetailState({ status: 'loading' })
    const seq = ++detailRequestSeq.current
    fetchSkillDetail(scope.sessionId, scope.cwd, skill.name)
      .then((result) => {
        if (seq !== detailRequestSeq.current) return
        setDetailState(result.skill !== null
          ? { status: 'ok', data: result.skill }
          : { status: 'error', message: t('detailNotFound') })
      })
      .catch((cause: unknown) => {
        if (seq !== detailRequestSeq.current) return
        setDetailState({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      })
  }
  const closeDetail = (): void => {
    detailRequestSeq.current += 1
    setDetailSkill(null)
  }

  // Skill model-invocation toggle (writes the SKILL.md frontmatter via host).
  const [toggleBusy, setToggleBusy] = useState(false)
  const toggleSkill = async (skill: SidebarSkillSummary, enabled: boolean): Promise<string | null> => {
    if (toggleBusy) return null
    setToggleBusy(true)
    try {
      const result = await setSkillModelInvocation(scope.sessionId, scope.cwd, skill.name, enabled)
      if (result.success) {
        const invocation = { ...(skill.invocation ?? { modelInvocable: true, userInvocable: true }), modelInvocable: enabled }
        skills.patchSkill(skill.name, { invocation })
        // Keep the open detail modal in sync with the fresh state.
        setDetailSkill(prev => (prev?.name === skill.name ? { ...prev, invocation } : prev))
        return null
      }
      return result.error ?? t('toggleFailed')
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    } finally {
      setToggleBusy(false)
    }
  }

  const filteredSkills = useMemo(() => {
    if (skills.skills === null) return []
    const q = query.trim().toLowerCase()
    if (q === '') return skills.skills
    return skills.skills.filter(s =>
      s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q),
    )
  }, [skills.skills, query])
  const shownSkills = showAll ? filteredSkills : filteredSkills.slice(0, SKILLS_PREVIEW_COUNT)

  // ── Context section ──────────────────────────────────────────────────────
  const projected = pressure.value?.projectedTokens
  const windowSize = pressure.value?.contextWindow
  const pressureTokens = pressure.value?.pressureTokens
  const pct = projected !== undefined && windowSize !== undefined && windowSize > 0
    ? Math.min(100, (projected / windowSize) * 100)
    : undefined

  // ── LLM section ──────────────────────────────────────────────────────────
  const uncached = tokenUsage.value?.uncachedInputTokens ?? 0
  const cacheRead = tokenUsage.value?.cacheReadTokens ?? 0
  const cacheWrite = tokenUsage.value?.cacheWriteTokens ?? 0
  const inputTotal = uncached + cacheRead + cacheWrite
  const output = tokenUsage.value?.outputTokens ?? 0
  const speed = stats.value !== undefined && stats.value.decodeMs > 0 && stats.value.decodeTokens > 0
    ? stats.value.decodeTokens / (stats.value.decodeMs / 1000)
    : undefined
  const avgTtft = stats.value !== undefined && stats.value.ttftSteps > 0 ? stats.value.ttftMs / stats.value.ttftSteps : undefined
  const hasLlm = stats.value !== undefined && stats.value.steps > 0
  const llmBindingOk = tokenUsage.bindingOk || stats.bindingOk

  return (
    <div className={css.root}>
      <header className={css.header}>
        <span className={css.title}>{t('title')}</span>
        <span className={css.session}>{session?.displayTitle ?? t('sessionNone')}</span>
      </header>

      {/* Context */}
      <Section
        title={t('context')}
        open={open.context}
        onToggle={() => setOpen(prev => ({ ...prev, context: !prev.context }))}
      >
        {projected === undefined
          ? (
            <div className={css.empty}>
              {t('noContextYet')}
              {!pressure.bindingOk && <span className={css.diag}> · {t('bindingUnavailable')}</span>}
            </div>
          )
          : (
            <div>
              <div className={css.gaugeRow}>
                <span className={css.gaugeValue}>
                  {formatCompact(projected)}
                  {windowSize !== undefined && (
                    <>
                      <span className={css.gaugeSlash}> / </span>
                      <span className={css.gaugeWindow}>{formatCompact(windowSize)}</span>
                    </>
                  )}
                </span>
                {pct !== undefined && <span className={css.gaugePct}>{pct.toFixed(0)}%</span>}
              </div>
              <div className={css.gaugeTrack}>
                <div
                  className={pct !== undefined && pct > 85 ? css.gaugeFillWarn : css.gaugeFill}
                  style={pct !== undefined ? { width: `${pct}%` } : undefined}
                />
              </div>
              <div className={css.gaugeMeta}>
                {pressureTokens !== undefined && <span>{t('pressure')}: {formatCompact(pressureTokens)}</span>}
                {windowSize === undefined && <span className={css.gaugeHint}>· {t('contextWindowUnknown')}</span>}
              </div>
              {breakdown.value !== undefined && (
                <div className={css.breakdown}>
                  <span>{t('breakdownSystem')}: {formatCompact(breakdown.value.systemTokens)}</span>
                  <span>{t('breakdownTools')}: {formatCompact(breakdown.value.toolsTokens)}</span>
                  <span>{t('breakdownMessages')}: {formatCompact(breakdown.value.messageTokens)}</span>
                </div>
              )}
            </div>
          )}
      </Section>

      {/* LLM stats */}
      <Section
        title={t('llm')}
        open={open.llm}
        onToggle={() => setOpen(prev => ({ ...prev, llm: !prev.llm }))}
      >
        {!hasLlm
          ? (
            <div className={css.empty}>
              {t('noLlmYet')}
              {!llmBindingOk && <span className={css.diag}> · {t('bindingUnavailable')}</span>}
            </div>
          )
          : (
            <div className={css.statsGrid}>
              <Stat label={t('input')} value={formatCompact(inputTotal)} sub={`${t('uncached')} ${formatCompact(uncached)}`} />
              <Stat label={t('output')} value={formatCompact(output)} />
              {(cacheRead > 0 || cacheWrite > 0) && (
                <Stat label={t('cacheRead')} value={formatCompact(cacheRead)} sub={`${t('cacheWrite')} ${formatCompact(cacheWrite)}`} />
              )}
              <Stat label={t('outputSpeed')} value={speed !== undefined ? speed.toFixed(1) : '—'} sub={t('speedUnit')} />
              <Stat label={t('avgTtft')} value={avgTtft !== undefined ? String(Math.round(avgTtft)) : '—'} sub={t('avgTtftUnit')} />
              <Stat label={t('turns')} value={String(stats.value?.turns ?? 0)} sub={`${t('steps')} ${String(stats.value?.steps ?? 0)}`} />
              <Stat label={t('llmTime')} value={formatDuration(stats.value?.llmMs ?? 0)} />
              <Stat label={t('toolTime')} value={formatDuration(stats.value?.toolMs ?? 0)} />
            </div>
          )}
      </Section>

      {/* Skills */}
      <Section
        title={t('skills')}
        count={skills.skills !== null ? skills.skills.length : undefined}
        open={open.skills}
        onToggle={() => setOpen(prev => ({ ...prev, skills: !prev.skills }))}
      >
        {skills.error !== null && skills.skills === null && (
          <div className={css.error}>{t('skillsError', { message: skills.error })}</div>
        )}
        {skills.skills === null && skills.error === null && (
          <div className={css.empty}>{t('skillsLoading')}</div>
        )}
        {skills.skills !== null && skills.skills.length === 0 && (
          <div className={css.empty}>
            {skills.scoped === false ? t('skillsUnscoped') : t('skillsEmpty')}
          </div>
        )}
        {skills.skills !== null && skills.skills.length > 0 && (
          <>
            <input
              className={css.search}
              type="search"
              placeholder={t('skillsSearchPlaceholder')}
              value={query}
              onChange={event => { setQuery(event.target.value); setShowAll(false) }}
            />
            {filteredSkills.length === 0
              ? <div className={css.empty}>{t('skillsNoMatch', { query })}</div>
              : (
                <>
                  <div className={css.skillGrid}>
                    {shownSkills.map(skill => {
                      const modelEnabled = skill.invocation?.modelInvocable ?? true
                      const canToggle = skill.source !== 'bundled'
                      return (
                        <button
                          key={skill.name}
                          type="button"
                          className={modelEnabled ? css.skillChip : css.skillChipDisabled}
                          title={skill.description}
                          onClick={() => openDetail(skill)}
                        >
                          <span className={css.skillName}>{skill.name}</span>
                          <span
                            className={canToggle ? css.skillToggleBtn : css.skillToggleBtnHidden}
                            role="switch"
                            aria-checked={modelEnabled}
                            aria-label={`${skill.name} ${t('modelInvocation')}`}
                            title={modelEnabled ? t('modelInvocationOn') : t('modelInvocationOff')}
                            onClick={(event) => {
                              event.stopPropagation()
                              void toggleSkill(skill, !modelEnabled)
                            }}
                          >
                            <EyeIcon enabled={modelEnabled} />
                          </span>
                          <span className={css.skillBadge}>{sourceLabel(skill.source)}</span>
                        </button>
                      )
                    })}
                  </div>
                  {filteredSkills.length > SKILLS_PREVIEW_COUNT && (
                    <button
                      type="button"
                      className={css.showMore}
                      onClick={() => setShowAll(prev => !prev)}
                    >
                      {showAll
                        ? t('skillsCollapse')
                        : t('skillsShowAll', { count: filteredSkills.length })}
                    </button>
                  )}
                </>
              )}
          </>
        )}
        {skills.fetchedAt !== null && (
          <footer className={css.footer}>
            {t('lastUpdated', { time: new Date(skills.fetchedAt).toLocaleTimeString() })}
          </footer>
        )}
      </Section>

      {/* Skill detail modal */}
      {detailSkill !== null && (
        <SkillDetailModal
          skill={detailSkill}
          detail={detailState}
          onClose={closeDetail}
          onToggle={toggleSkill}
          toggleBusy={toggleBusy}
        />
      )}
    </div>
  )
}
