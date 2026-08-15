/**
 * Typed fetch wrapper over the plugin's own fenced `/telemetry/api` routes
 * (the host half registers them; every request passes the same browser-trust
 * fence as the /api gateway and the sidebar routes).
 */
import type { SidebarSkillDefinition, SidebarSkillSummary } from '../../context-types.ts'

/** One skills snapshot response. */
export interface SkillsResult {
  sessionId: string
  cwd: string
  skills: SidebarSkillSummary[]
  fetchedAt: number
  /** Whether the host resolved a viewing scope (agent/preset). Absent = legacy host. */
  scoped?: boolean
  /** Present when the host skill discovery failed (partial/empty catalog). */
  error?: string
}

/** Fetch the agent's skill catalog for one session (cwd-scoped on the host). */
export async function fetchSkills(
  sessionId: string,
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<SkillsResult> {
  return await call<SkillsResult>('skills', { sessionId, cwd }, signal)
}

/** One skill detail response. */
export interface SkillDetailResult {
  sessionId: string
  cwd: string
  name: string
  /** Full skill definition (content + path + metadata), or null when unknown/unloadable. */
  skill: SidebarSkillDefinition | null
  fetchedAt: number
  /** Whether the host resolved a viewing scope (agent/preset). */
  scoped?: boolean
  /** Present when the host skill loading failed. */
  error?: string
}

/** Fetch one skill's full definition (body, path, metadata). */
export async function fetchSkillDetail(
  sessionId: string,
  cwd: string | undefined,
  name: string,
  signal?: AbortSignal,
): Promise<SkillDetailResult> {
  return await call<SkillDetailResult>('skill', { sessionId, cwd, name }, signal)
}

/** One skill invocation-toggle response. */
export interface SkillSetResult {
  name: string
  success: boolean
  /** Absolute path of the edited SKILL.md (present on success). */
  path?: string
  /** The resulting model-invocable state (present on success). */
  modelInvocable?: boolean
  /** Whether the file actually changed (false = already in the desired state). */
  changed?: boolean
  source?: string
  error?: string
}

/** Toggle a skill's model invocation by editing its SKILL.md frontmatter. */
export async function setSkillModelInvocation(
  sessionId: string,
  cwd: string | undefined,
  name: string,
  modelEnabled: boolean,
  signal?: AbortSignal,
): Promise<SkillSetResult> {
  return await call<SkillSetResult>('skill-set', { sessionId, cwd, name, modelEnabled }, signal)
}

/** Shared fetch wrapper over the fenced /telemetry/api routes. */
async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/telemetry/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const parsed: { ok?: boolean; value?: T; error?: { message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value
}
