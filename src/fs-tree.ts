/**
 * Single-level directory listing for the sidebar explorer / floating file
 * manager. Streams the level with opendir, sorts directories first then
 * names (case-insensitive), marks POSIX-hidden entries (dot-prefixed) for
 * dimmed display, and enriches rows with lstat metadata (size / mtime /
 * symlink flag) on a best-effort basis. Symlinks are reported as the link
 * itself, not its target.
 */
import { lstat, opendir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { SidebarError } from './wire.ts'

/** One explorer row. */
export interface SidebarFsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  /** File size in bytes (undefined for directories). */
  size?: number
  /** Last-modified time in epoch milliseconds (undefined while unknown). */
  mtimeMs?: number
  /** True when the row is a symlink (the explorer shows the link itself). */
  symlink?: boolean
}

/** One listed level. */
export interface SidebarFsListing {
  path: string
  entries: SidebarFsEntry[]
  truncated: boolean
}

/** Directory-first, case-insensitive name ordering (VSCode explorer order). */
export function compareEntries(a: SidebarFsEntry, b: SidebarFsEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * List one directory level.
 * @param path - absolute directory path.
 * @param maxEntries - row bound of one level (extra rows flag `truncated`).
 * @returns the sorted listing.
 * @throws {SidebarError} fs-error when the level is unreadable or not a directory.
 */
export async function listDirectory(path: string, maxEntries = 1000): Promise<SidebarFsListing> {
  let level
  try {
    level = await opendir(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${path}": ${messageOf(error)}`, 400)
  }
  const rows: SidebarFsEntry[] = []
  let overflow = 0
  try {
    for await (const dirent of level) {
      if (rows.length >= maxEntries) {
        overflow += 1
        continue
      }
      rows.push({
        name: dirent.name,
        // Platform join: on Windows the level path uses '\' — a hardcoded '/'
        // would leak mixed separators into every row's path.
        path: join(path, dirent.name),
        isDir: dirent.isDirectory(),
        hidden: dirent.name.startsWith('.'),
      })
    }
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${path}": ${messageOf(error)}`, 400)
  }
  // Enrich rows with lstat metadata (size / mtime / symlink). Directory
  // sizes stay undefined; failures degrade to the dirent-only row so one
  // unreadable entry cannot fail the whole level.
  await Promise.all(rows.map(async (row) => {
    try {
      const info = await lstat(row.path)
      row.symlink = info.isSymbolicLink()
      row.mtimeMs = info.mtimeMs
      if (info.isFile()) row.size = info.size
    } catch {
      // Keep the dirent-only row.
    }
  }))
  rows.sort(compareEntries)
  return { path, entries: rows, truncated: overflow > 0 }
}

/** The root row label of a listing: the last path segment (or the full path at the filesystem root). */
export function rootLabel(path: string): string {
  const base = basename(path)
  return base !== '' ? base : path
}

/** Parent of a path, or undefined at the filesystem root (the explorer's "up" target). */
export function parentOf(path: string): string | undefined {
  const parent = dirname(path)
  return parent === path ? undefined : parent
}

/** Normalize a caller-supplied path to an absolute, resolved path or throw fs-error. */
export function requireAbsolute(path: string): string {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new SidebarError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  return resolve(path)
}

/**
 * Whether `target` lies under `base` (or equals it), tolerant of separator
 * style and — on Windows, where the filesystem is case-insensitive — of
 * letter case. The media route uses this instead of a raw `startsWith` so a
 * case-mismatched or mixed-separator path can never be misclassified
 * (e.g. `C:\Users\Me` vs `c:/users/me/file.png`).
 * @param platform - filesystem semantics; injectable so both branches are
 * unit-testable on any host.
 */
export function isWithin(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/** Message text of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
