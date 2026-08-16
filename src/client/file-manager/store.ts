/**
 * Global store for the floating file manager. Deliberately NOT part of the
 * per-session SidebarState: the file manager is a parallel tool, its window
 * geometry / current directory / UI preferences survive session switches and
 * page reloads under one localStorage key.
 */
/** Window geometry to restore when leaving maximized mode. */
export interface FileManagerRestoreRect {
  x: number
  y: number
  width: number
  height: number
}

export const FILE_MANAGER_PREVIEW_RATIO_MIN = 0.25
export const FILE_MANAGER_PREVIEW_RATIO_MAX = 0.85

export type FileManagerSortKey = 'name' | 'size' | 'mtime'

export interface FileManagerState {
  open: boolean
  /** Current directory (empty until the first open). */
  dir: string
  x: number
  y: number
  width: number
  height: number
  /** Right-side preview pane. */
  previewOpen: boolean
  /** Selected file path (the preview follows it). */
  selectedPath: string | null
  showHidden: boolean
  sortKey: FileManagerSortKey
  sortAsc: boolean
  /** Recently visited directories (most recent first, deduplicated). */
  recentDirs: string[]
  /** Favorite directories (pinned). */
  favoriteDirs: string[]
  /** Whether the window occupies the full viewport. */
  maximized: boolean
  /** Geometry to restore from maximized mode. */
  restoreRect: FileManagerRestoreRect | null
  /** Preview pane share of the main area (0.25–0.85; default 0.5). */
  previewRatio: number
  /** Preview fills the whole window (the list pane is hidden). */
  previewFull: boolean
}

const STORAGE_KEY = 'dsh-file-manager:v1'

export const FILE_MANAGER_MIN_WIDTH = 520
export const FILE_MANAGER_MIN_HEIGHT = 320
export const FILE_MANAGER_DEFAULT_WIDTH = 760
export const FILE_MANAGER_DEFAULT_HEIGHT = 480

export function sanitizeFileManagerState(parsed: unknown): FileManagerState | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.dir !== 'string') return undefined
  if (typeof record.open !== 'boolean') return undefined
  if (typeof record.x !== 'number' || !Number.isFinite(record.x)) return undefined
  if (typeof record.y !== 'number' || !Number.isFinite(record.y)) return undefined
  if (typeof record.width !== 'number' || !Number.isFinite(record.width)) return undefined
  if (typeof record.height !== 'number' || !Number.isFinite(record.height)) return undefined
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : FILE_MANAGER_DEFAULT_WIDTH
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : FILE_MANAGER_DEFAULT_HEIGHT
  const width = Math.max(FILE_MANAGER_MIN_WIDTH, Math.min(record.width, viewportWidth))
  const height = Math.max(FILE_MANAGER_MIN_HEIGHT, Math.min(record.height, viewportHeight))
  return {
    open: record.open,
    dir: record.dir,
    x: Math.max(0, Math.min(record.x, Math.max(0, viewportWidth - width))),
    y: Math.max(0, Math.min(record.y, Math.max(0, viewportHeight - height))),
    width,
    height,
    previewOpen: record.previewOpen === true,
    selectedPath: typeof record.selectedPath === 'string' ? record.selectedPath : null,
    showHidden: record.showHidden === true,
    sortKey: record.sortKey === 'size' || record.sortKey === 'mtime' ? record.sortKey : 'name',
    sortAsc: record.sortAsc !== false,
    recentDirs: Array.isArray(record.recentDirs)
      ? record.recentDirs.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : [],
    favoriteDirs: Array.isArray(record.favoriteDirs)
      ? record.favoriteDirs.filter((item): item is string => typeof item === 'string').slice(0, 50)
      : [],
    maximized: record.maximized === true,
    restoreRect: sanitizeRestoreRect(record.restoreRect),
    previewRatio: typeof record.previewRatio === 'number' && Number.isFinite(record.previewRatio)
      ? clampPreviewRatio(record.previewRatio)
      : 0.5,
    previewFull: record.previewFull === true,
  }
}

function defaultState(): FileManagerState {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : FILE_MANAGER_DEFAULT_WIDTH
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : FILE_MANAGER_DEFAULT_HEIGHT
  return {
    open: false,
    dir: '',
    width: Math.min(FILE_MANAGER_DEFAULT_WIDTH, viewportWidth),
    height: Math.min(FILE_MANAGER_DEFAULT_HEIGHT, viewportHeight),
    x: Math.max(0, Math.round((viewportWidth - FILE_MANAGER_DEFAULT_WIDTH) / 2)),
    y: Math.max(0, Math.round((viewportHeight - FILE_MANAGER_DEFAULT_HEIGHT) / 2)),
    previewOpen: true,
    selectedPath: null,
    showHidden: true,
    sortKey: 'name',
    sortAsc: true,
    recentDirs: [],
    favoriteDirs: [],
    maximized: false,
    restoreRect: null,
    previewRatio: 0.5,
    previewFull: false,
  }
}

function clampPreviewRatio(value: number): number {
  return Math.min(FILE_MANAGER_PREVIEW_RATIO_MAX, Math.max(FILE_MANAGER_PREVIEW_RATIO_MIN, value))
}

function sanitizeRestoreRect(value: unknown): FileManagerRestoreRect | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.x !== 'number' || !Number.isFinite(record.x)
    || typeof record.y !== 'number' || !Number.isFinite(record.y)
    || typeof record.width !== 'number' || !Number.isFinite(record.width)
    || typeof record.height !== 'number' || !Number.isFinite(record.height)
  ) return null
  return {
    x: Math.max(0, record.x),
    y: Math.max(0, record.y),
    width: Math.max(FILE_MANAGER_MIN_WIDTH, record.width),
    height: Math.max(FILE_MANAGER_MIN_HEIGHT, record.height),
  }
}

function loadState(): FileManagerState {
  if (typeof localStorage === 'undefined') return defaultState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return defaultState()
    return sanitizeFileManagerState(JSON.parse(raw)) ?? defaultState()
  } catch {
    return defaultState()
  }
}

export class FileManagerStore {
  private state: FileManagerState = loadState()
  private readonly listeners = new Set<() => void>()
  private persistTimer: number | undefined

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): FileManagerState {
    return this.state
  }

  update(mutator: (draft: FileManagerState) => void): void {
    const draft = structuredClone(this.state)
    mutator(draft)
    this.state = draft
    this.schedulePersist()
    this.notify()
  }

  toggle(): void {
    this.update(s => { s.open = !s.open })
  }

  setOpen(open: boolean): void {
    if (this.state.open === open) return
    this.update(s => { s.open = open })
  }

  setDir(dir: string, selectedPath: string | null = null): void {
    this.update(s => {
      s.dir = dir
      s.selectedPath = selectedPath
    })
  }

  touchRecent(dir: string): void {
    if (dir === '') return
    this.update(s => {
      s.recentDirs = [dir, ...s.recentDirs.filter(item => item !== dir)].slice(0, 20)
    })
  }

  toggleFavorite(dir: string): void {
    if (dir === '') return
    this.update(s => {
      s.favoriteDirs = s.favoriteDirs.includes(dir)
        ? s.favoriteDirs.filter(item => item !== dir)
        : [dir, ...s.favoriteDirs]
    })
  }

  private schedulePersist(): void {
    if (typeof window === 'undefined') return
    window.clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
      } catch {
        // Best-effort persistence.
      }
    }, 200)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export function createFileManagerStore(): FileManagerStore {
  return new FileManagerStore()
}
