/**
 * Host half of dsh-sidebar-telemetry: one fenced JSON route
 * `POST /telemetry/api/skills` that serves the agent's skill catalog
 * (`ctx.skills.list`, cwd-scoped to the requesting session) to the client
 * half's sidebar tab.
 *
 * Everything else the tab shows — token usage, context pressure/breakdown,
 * and LLM wall-time stats — arrives through DSH's own session-projection
 * seam (tokenUsage / contextPressure / contextBreakdown / sessionStats), so
 * no route exists for those: the client reads them directly. This half stays
 * deliberately tiny.
 *
 * The route passes the same browser-trust fence as the /api gateway and the
 * /sidebar routes: Host-header loopback or the connection row's
 * `trustedHosts`, read live from the loader row so the fence never drifts.
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Context, SidebarAgentPresetsService } from './context-types.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sidebar-telemetry'

/** Services required before mounting: the webserver routes, the session store, the loader's connection row, the skill registry, and the live-agent registry (scope resolution). */
export const inject = ['webServer', 'sessions', 'loader', 'skills', 'agents']

// ── Browser-trust fence (mirror of the /api gateway's fence) ────────────────

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Decide whether one request may reach the plugin routes (structural mirror of dsh-better-sidebar's fence). */
function isTrustedApiRequest(req: { headers: IncomingHttpHeaders }, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const parsed = parseAuthority(host)
  if (parsed === undefined) return false
  if (isLoopbackHostname(parsed.hostname)) return true
  return isTrustedAuthority(parsed, trustedHosts)
}

/** The connection row's resolved trustedHosts (live read; the /api fence's own list). */
function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

/**
 * Resolve a session's authoritative working directory (the skill catalog is
 * cwd-scoped, so project-level skills appear). Mirrors the sidebar's own
 * resolution: the attached session's header cwd wins, then the caller's
 * summary cwd, then the process cwd — never throws for a missing cwd.
 */
function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): string {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') return clientCwd
  return process.cwd()
}

// ── Wire helpers ────────────────────────────────────────────────────────────

function writeJson(res: { writeHead(status: number, headers?: Record<string, string>): unknown; end(body: string): unknown }, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      chunks.push(chunk)
      size += chunk.length
      if (size > 64 * 1024) {
        done = true
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', (error: Error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

// ── Plugin body ─────────────────────────────────────────────────────────────

// ── SKILL.md frontmatter editing (line-level, lossless) ────────────────────
// The filesystem skill provider reads `disable-model-invocation` from the
// YAML frontmatter: `true` hides the skill from the model catalog and makes
// the `skill` tool refuse it. Toggling = editing that one line in place, so
// every other frontmatter field, formatting and the body stay untouched. The
// provider's watcher invalidates its catalog on file change, so the model
// side picks the new state up without a restart.

/** A `disable-model-invocation: <truthy>` line (the disabled state). */
const DISABLE_TRUE_RE = /^\s*disable-model-invocation\s*:\s*(true|1|yes|on|y)\b/i
/** Any `disable-model-invocation:` line, whatever its value. */
const DISABLE_KEY_RE = /^\s*disable-model-invocation\s*:/i

/** Split `---\n…\n---` frontmatter off a skill body; null when absent/malformed. */
function splitFrontmatter(text: string): { fm: string[]; rest: string } | null {
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0]!.trim() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return null
  return { fm: lines.slice(1, end), rest: lines.slice(end + 1).join('\n') }
}

/**
 * Return a new file text with the model-invocation flag set to `enabled`.
 * `changed` is false when the file already has the desired state (or has no
 * frontmatter to edit).
 */
function setModelInvocable(text: string, enabled: boolean): { text: string; changed: boolean } {
  const split = splitFrontmatter(text)
  if (split === null) return { text, changed: false }
  const hasDisableTrue = split.fm.some(line => DISABLE_TRUE_RE.test(line))
  const hasDisableKey = split.fm.some(line => DISABLE_KEY_RE.test(line))
  let next: string[]
  let changed = false
  if (enabled && hasDisableKey) {
    // Enabling: drop the line entirely (absent = enabled).
    next = split.fm.filter(line => !DISABLE_KEY_RE.test(line))
    changed = true
  } else if (!enabled && !hasDisableTrue) {
    // Disabling: replace any present line, then prepend the flag.
    next = split.fm.filter(line => !DISABLE_KEY_RE.test(line))
    next.unshift('disable-model-invocation: true')
    changed = true
  } else {
    next = split.fm
  }
  if (!changed) return { text, changed: false }
  return { text: `---\n${next.join('\n')}\n---\n${split.rest}`, changed }
}

/** Atomic file write (tmp + rename), same pattern as the sidebar's fs.write. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.dsh-telemetry-${process.pid}-${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/** Whether a skill's source bucket is user-writable (bundled skills are read-only). */
function isWritableSkillSource(source: string): boolean {
  return source !== 'bundled'
}

/**
 * Resolve the viewing scope for skill reads. The skill registry is layered
 * PER SCOPE: the provider rows (dsh-skill-filesystem) register into the
 * session's agent-preset layer, so a plain host read returns nothing. The
 * live agent wins; without one, the session preset's standing key — exactly
 * the official `skill.list` presenter logic.
 */
async function resolveSkillScope(ctx: Context, sessionId: string): Promise<unknown> {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  const presetId = ctx.sessions.get(sessionId)?.header.agentPreset
  if (presets !== undefined && presetId !== undefined && presetId !== '') {
    try {
      return await presets.standingKeyFor(presetId)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Mount the fenced telemetry routes (skills list + one skill detail).
 * @param ctx - host plugin context (webServer, sessions, loader, skills, agents).
 */
export function applyTelemetry(ctx: Context): void {
  const fence = (req: { headers: IncomingHttpHeaders }): boolean => isTrustedApiRequest(req, trustedHostsOf(ctx))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/telemetry/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/telemetry/api/') ? pathname.slice('/telemetry/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown telemetry API method' } })
        return
      }
      try {
        const payload = (await readJsonBody(req)) as { sessionId?: unknown; cwd?: unknown } | null
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        const clientCwd = typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
        switch (method) {
          case 'skills': {
            const cwd = sessionCwdOf(ctx, sessionId, clientCwd)
            let skills: unknown[] = []
            let error: string | undefined
            let scoped = false
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 10_000)
              try {
                const scope = await resolveSkillScope(ctx, sessionId)
                scoped = scope !== undefined
                skills = await ctx.skills.list({
                  cwd,
                  signal: controller.signal,
                  ...(scope !== undefined ? { scope } : {}),
                })
              } finally {
                clearTimeout(timer)
              }
            } catch (cause) {
              error = cause instanceof Error ? cause.message : String(cause)
            }
            writeJson(res, 200, {
              ok: true,
              value: {
                sessionId,
                cwd,
                skills,
                scoped,
                fetchedAt: Date.now(),
                ...(error !== undefined ? { error } : {}),
              },
            })
            return
          }
          case 'skill': {
            const name = (payload as { name?: unknown } | null)?.name
            if (typeof name !== 'string' || name === '') {
              writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'name is required' } })
              return
            }
            const cwd = sessionCwdOf(ctx, sessionId, clientCwd)
            let skill: unknown = null
            let error: string | undefined
            let scoped = false
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 10_000)
              try {
                const scope = await resolveSkillScope(ctx, sessionId)
                scoped = scope !== undefined
                skill = (await ctx.skills.get(name, {
                  cwd,
                  signal: controller.signal,
                  ...(scope !== undefined ? { scope } : {}),
                })) ?? null
              } finally {
                clearTimeout(timer)
              }
            } catch (cause) {
              error = cause instanceof Error ? cause.message : String(cause)
            }
            writeJson(res, 200, {
              ok: true,
              value: {
                sessionId,
                cwd,
                name,
                skill,
                scoped,
                fetchedAt: Date.now(),
                ...(error !== undefined ? { error } : {}),
              },
            })
            return
          }
          case 'skill-set': {
            const rec = payload as { name?: unknown; modelEnabled?: unknown } | null
            const name = typeof rec?.name === 'string' ? rec.name : ''
            const modelEnabled = rec?.modelEnabled
            if (name === '' || typeof modelEnabled !== 'boolean') {
              writeJson(res, 400, {
                ok: false,
                error: { code: 'bad-request', message: 'name (string) and modelEnabled (boolean) are required' },
              })
              return
            }
            const cwd = sessionCwdOf(ctx, sessionId, clientCwd)
            // Toggle the skill's `disable-model-invocation` frontmatter flag:
            // resolve the definition (for its writable path), edit the file
            // line-level and write it back atomically. The filesystem
            // provider's watcher invalidates the catalog on change, so the
            // model side picks the new state up without a restart.
            let value: { name: string; success: boolean; path?: string; modelInvocable?: boolean; changed?: boolean; source?: string; error?: string }
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 10_000)
              let skill
              try {
                const scope = await resolveSkillScope(ctx, sessionId)
                skill = await ctx.skills.get(name, {
                  cwd,
                  signal: controller.signal,
                  ...(scope !== undefined ? { scope } : {}),
                })
              } finally {
                clearTimeout(timer)
              }
              if (skill === undefined) {
                value = { name, success: false, error: `skill "${name}" is unknown or no longer available` }
              } else if (!isWritableSkillSource(skill.source)) {
                value = { name, success: false, error: `bundled skill "${name}" is read-only` }
              } else if (skill.path === undefined) {
                value = { name, success: false, error: `skill "${name}" has no writable file path` }
              } else {
                const original = await readFile(skill.path, 'utf8')
                const edited = setModelInvocable(original, modelEnabled)
                if (edited.changed) await atomicWrite(skill.path, edited.text)
                value = {
                  name,
                  success: true,
                  path: skill.path,
                  source: skill.source,
                  modelInvocable: modelEnabled,
                  changed: edited.changed,
                }
              }
            } catch (cause) {
              value = { name, success: false, error: cause instanceof Error ? cause.message : String(cause) }
            }
            writeJson(res, 200, { ok: true, value })
            return
          }
          default:
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown telemetry API method "${method}"` } })
            return
        }
      } catch (error) {
        writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), 'dsh-sidebar-telemetry: /telemetry/api routes')
}
