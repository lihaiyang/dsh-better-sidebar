/**
 * The floating file manager: a self-contained, always-available window that
 * browses directories, manages files, and previews any file through the same
 * viewer registry as the sidebar editor — but WITHOUT creating sidebar tabs.
 * It is a parallel surface: hidden instead of destroyed, with its own global
 * store and localStorage persistence.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronLeftOutline14, IconChevronRightOutline14, IconChevronUpOutline14,
  IconCloseFill14, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16,
  IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconFolderOpenOutline16,
  IconFullscreenOutline16, IconPlusOutline16, IconRefreshOutline14, IconTrashOutline16, Input, Menu, Modal,
  writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { api, downloadUrl, type FsEntry } from '../api.ts'
import { t } from '../locales.ts'
import type { SidebarStore } from '../state.ts'
import { FilePreviewHost } from './FilePreviewHost.tsx'
import {
  FILE_MANAGER_MIN_HEIGHT, FILE_MANAGER_MIN_WIDTH,
  FILE_MANAGER_PREVIEW_RATIO_MAX, FILE_MANAGER_PREVIEW_RATIO_MIN,
  type FileManagerStore, type FileManagerSortKey,
} from './store.ts'
import css from './file-manager.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
  truncated?: boolean
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return undefined
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (at === -1) return undefined
  if (at === 0) return trimmed.startsWith('/') ? '/' : undefined
  return trimmed.slice(0, at)
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return '--'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatMtime(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return '--'
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return '--'
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Compare one level client-side for the selected column. */
function compareForSort(a: FsEntry, b: FsEntry, key: FileManagerSortKey): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  if (key === 'size') {
    const as = a.size ?? -1
    const bs = b.size ?? -1
    if (as !== bs) return as - bs
  } else if (key === 'mtime') {
    const am = a.mtimeMs ?? 0
    const bm = b.mtimeMs ?? 0
    if (am !== bm) return am - bm
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** Restore-window glyph (overlapping frames) in the app outline style. */
function RestoreGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="4.5" width="10" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 4V3a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12.5 10H11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function FileManagerWindow(props: {
  ctx: Context
  store: SidebarStore
  fmStore: FileManagerStore
}) {
  const { ctx, store, fmStore } = props
  // The floating file manager opens files as a local file browser: HTML
  // previews run UNSAFE (same-origin, no iframe sandbox) by default, so a
  // page with local storage / same-origin fetch / dev-server assumptions
  // just opens instead of showing the sandbox status as an error. The
  // sidebar editor keeps its sandboxed-by-default behavior.
  const previewStore = useMemo(() => ({
    getPrefs: () => ({ ...store.getPrefs(), htmlViewerNoSandbox: true, htmlViewerDefaultUnsafe: true }),
  }) as unknown as SidebarStore, [store])
  const fm = useSyncExternalStore(
    useCallback((callback: () => void) => fmStore.subscribe(callback), [fmStore]),
    useCallback(() => fmStore.getSnapshot(), [fmStore]),
  )

  // Re-render on DSH locale switches (t() reads the active locale at call
  // time; the window is a sibling of the Sidebar shell, so it must subscribe
  // itself instead of riding Sidebar's own locale revision).
  const localeRevision = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.locale.subscribe(callback), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  void localeRevision

  // Current conversation scope (browsing is global, but API routes still
  // need a sessionId; the session cwd is the default directory + trust root).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const sessionId = sessionList.current
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId }).then(result => {
      if (!cancelled) setFetchedCwd(result.cwd)
    }).catch(() => { /* the list row surfaces its own error */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  // First use: start in the current session cwd.
  useEffect(() => {
    if (fm.dir === '' && cwd !== undefined) fmStore.setDir(cwd, null)
  }, [fm.dir, cwd, fmStore])

  // Every displayed directory is explicitly trusted before it is listed so
  // write operations inside it work even when it is outside the session cwd.
  useEffect(() => {
    if (!fm.open || fm.dir === '' || sessionId === undefined) return
    let cancelled = false
    api.fsTrust({ sessionId }, fm.dir).catch(() => {
      // The list below will surface the same fs-error if the dir is gone.
    })
    return () => { cancelled = true }
  }, [fm.open, fm.dir, sessionId])

  // Directory listing + refresh.
  const [level, setLevel] = useState<LevelData>({})
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    if (!fm.open || fm.dir === '' || sessionId === undefined) {
      setLevel({})
      return
    }
    let cancelled = false
    setLevel({})
    api.fsTree({ sessionId, cwd }, fm.dir).then((listing) => {
      if (cancelled) return
      fmStore.touchRecent(fm.dir)
      setLevel({ entries: listing.entries, truncated: listing.truncated })
    }).catch((error: unknown) => {
      if (cancelled) return
      setLevel({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [fm.open, fm.dir, refreshTick, sessionId, cwd])

  // Navigation history (in-memory; the component stays mounted while hidden).
  const backStack = useRef<string[]>([])
  const forwardStack = useRef<string[]>([])

  const navigateTo = useCallback((dir: string, pushHistory = true) => {
    const normalized = dir
    if (pushHistory && fm.dir !== '' && fm.dir !== normalized) {
      backStack.current.push(fm.dir)
      forwardStack.current = []
    }
    fmStore.setDir(normalized, null)
    setPathInput(normalized)
  }, [fm.dir, fmStore])

  const goBack = useCallback(() => {
    const prev = backStack.current.pop()
    if (prev === undefined) return
    if (fm.dir !== '') forwardStack.current.push(fm.dir)
    fmStore.setDir(prev, null)
    setPathInput(prev)
  }, [fm.dir, fmStore])

  const goForward = useCallback(() => {
    const next = forwardStack.current.pop()
    if (next === undefined) return
    backStack.current.push(fm.dir)
    fmStore.setDir(next, null)
    setPathInput(next)
  }, [fm.dir, fmStore])

  const goUp = useCallback(() => {
    const parent = parentOf(fm.dir)
    if (parent === undefined) return
    navigateTo(parent)
  }, [fm.dir, navigateTo])

  const refresh = useCallback(() => {
    setLevel({})
    setRefreshTick(tick => tick + 1)
  }, [])

  // Path input.
  const [pathInput, setPathInput] = useState(fm.dir)
  useEffect(() => { setPathInput(fm.dir) }, [fm.dir])

  const submitPath = useCallback(() => {
    const raw = pathInput.trim()
    if (raw === '' || raw === fm.dir) return
    const path = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
      ? raw
      : fm.dir === '' ? raw : `${fm.dir.replace(/[\\/]+$/, '')}/${raw}`
    navigateTo(path)
  }, [pathInput, fm.dir, navigateTo])

  // Selection.
  const selectedPath = fm.selectedPath
  const setSelectedPath = useCallback((path: string | null) => {
    fmStore.update(s => { s.selectedPath = path })
  }, [fmStore])

  const openEntry = useCallback((entry: FsEntry) => {
    if (entry.isDir) {
      navigateTo(entry.path)
    } else {
      setSelectedPath(entry.path)
    }
  }, [navigateTo, setSelectedPath])

  // Sort + filter.
  const entries = useMemo(() => {
    const source = level.entries ?? []
    const visible = fm.showHidden ? source : source.filter(entry => !entry.hidden)
    return [...visible].sort((a, b) => {
      const result = compareForSort(a, b, fm.sortKey)
      return fm.sortAsc ? result : -result
    })
  }, [level.entries, fm.showHidden, fm.sortKey, fm.sortAsc])

  const cycleSort = useCallback((key: FileManagerSortKey) => {
    fmStore.update(s => {
      if (s.sortKey === key) s.sortAsc = !s.sortAsc
      else {
        s.sortKey = key
        s.sortAsc = key === 'name'
      }
    })
  }, [fmStore])

  // Quick-access dropdown (recent + favorite directories).
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const quickButtonRef = useRef<HTMLButtonElement | null>(null)
  const isFavorite = fm.dir !== '' && fm.favoriteDirs.includes(fm.dir)
  const quickItems = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = [{
      id: 'toggle-favorite',
      label: isFavorite ? t('fmUnfavorite') : t('fmFavorite'),
      icon: <IconFolderOpenOutline16 size={14} />,
    }]
    if (fm.favoriteDirs.length > 0) {
      items.push({ type: 'label', id: 'fav-label', text: t('fmFavorites') })
      for (const dir of fm.favoriteDirs) {
        items.push({ id: `fav:${dir}`, label: baseName(dir), icon: <IconFolderOpen16 size={14} /> })
      }
    }
    if (fm.recentDirs.length > 0) {
      items.push({ type: 'label', id: 'recent-label', text: t('fmRecent') })
      for (const dir of fm.recentDirs) {
        items.push({ id: `recent:${dir}`, label: baseName(dir), icon: <IconFolderOpen16 size={14} /> })
      }
    }
    return items
  }, [isFavorite, fm.favoriteDirs, fm.recentDirs, localeRevision])

  // Context menu.
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  const openRowMenu = (event: ReactMouseEvent, entry: FsEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedPath(entry.path)
    setRowMenu({ path: entry.path, isDir: entry.isDir, x: event.clientX, y: event.clientY })
  }

  // Dialogs.
  const [renameTarget, setRenameTarget] = useState<{ path: string; isDir: boolean } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDir: boolean } | null>(null)
  const [createTarget, setCreateTarget] = useState<'file' | 'dir' | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const startRename = (target: { path: string; isDir: boolean }): void => {
    setRenameTarget(target)
    setRenameValue(baseName(target.path))
    setDialogError(null)
  }

  const submitRename = async (): Promise<void> => {
    const target = renameTarget
    if (target === null || dialogBusy) return
    const name = renameValue.trim()
    if (name === '' || name === baseName(target.path)) {
      setRenameTarget(null)
      return
    }
    setDialogBusy(true)
    setDialogError(null)
    try {
      await api.fsRename({ sessionId: sessionId ?? '', cwd }, target.path, name)
      setRenameTarget(null)
      refresh()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const submitDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (target === null || dialogBusy) return
    setDialogBusy(true)
    setDialogError(null)
    try {
      await api.fsDelete({ sessionId: sessionId ?? '', cwd }, target.path)
      setDeleteTarget(null)
      if (selectedPath === target.path) setSelectedPath(null)
      refresh()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const submitCreate = async (): Promise<void> => {
    if (createTarget === null || dialogBusy) return
    const name = createValue.trim()
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      setDialogError(t('fmInvalidName'))
      return
    }
    const target = `${fm.dir.replace(/[\\/]+$/, '')}/${name}`
    setDialogBusy(true)
    setDialogError(null)
    try {
      if (createTarget === 'dir') {
        await api.fsMkdir({ sessionId: sessionId ?? '', cwd }, target)
      } else {
        await api.fsCreate({ sessionId: sessionId ?? '', cwd }, target)
      }
      setCreateTarget(null)
      refresh()
      // Open the new file in preview after the refresh re-lists.
      if (createTarget === 'file') setSelectedPath(target)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const closeDialog = (): void => {
    if (dialogBusy) return
    setRenameTarget(null)
    setDeleteTarget(null)
    setCreateTarget(null)
    setDialogError(null)
  }

  const copyPath = (text: string): void => {
    void writeClipboard(text)
  }

  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId: sessionId ?? '', cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const menuItems: MenuEntry[] = []
  if (rowMenu !== null && !rowMenu.isDir) {
    menuItems.push({ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> })
  }
  menuItems.push({ id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={14} /> })
  menuItems.push({ id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true })
  menuItems.push({ type: 'separator', id: 'fm-sep' })
  menuItems.push({ id: 'copyAbs', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> })

  // Maximize / restore.
  const toggleMaximize = useCallback(() => {
    fmStore.update(s => {
      if (s.maximized) {
        const rect = s.restoreRect
        if (rect !== null) {
          s.width = Math.max(FILE_MANAGER_MIN_WIDTH, Math.min(rect.width, window.innerWidth))
          s.height = Math.max(FILE_MANAGER_MIN_HEIGHT, Math.min(rect.height, window.innerHeight))
          s.x = Math.min(Math.max(rect.x, 0), Math.max(0, window.innerWidth - s.width))
          s.y = Math.min(Math.max(rect.y, 0), Math.max(0, window.innerHeight - s.height))
        }
        s.maximized = false
        s.restoreRect = null
      } else {
        s.restoreRect = { x: s.x, y: s.y, width: s.width, height: s.height }
        s.x = 0
        s.y = 0
        s.width = window.innerWidth
        s.height = window.innerHeight
        s.maximized = true
      }
    })
  }, [fmStore])

  // Preview-pane ratio + full preview.
  const clampPreviewRatio = (value: number): number =>
    Math.min(FILE_MANAGER_PREVIEW_RATIO_MAX, Math.max(FILE_MANAGER_PREVIEW_RATIO_MIN, value))
  const setPreviewRatio = useCallback((ratio: number) => {
    fmStore.update(s => { s.previewRatio = clampPreviewRatio(ratio) })
  }, [fmStore])
  const togglePreviewFull = useCallback(() => {
    fmStore.update(s => { s.previewFull = !s.previewFull })
  }, [fmStore])
  const [resizingPreview, setResizingPreview] = useState(false)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const previewDrag = useRef({ startX: 0, startRatio: 0.5 })

  const onPreviewDividerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    previewDrag.current = { startX: event.clientX, startRatio: fm.previewRatio }
    setResizingPreview(true)
  }

  const onPreviewDividerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const width = mainRef.current?.getBoundingClientRect().width ?? window.innerWidth
    const { startX, startRatio } = previewDrag.current
    const ratio = clampPreviewRatio(startRatio + (startX - event.clientX) / width)
    // Soft snap back to the default half-screen split.
    setPreviewRatio(Math.abs(ratio - 0.5) < 0.03 ? 0.5 : ratio)
  }

  const onPreviewDividerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setResizingPreview(false)
  }

  // Esc: leave full preview first, otherwise hide the window (dialogs own
  // their own Escape handling and are skipped).
  useEffect(() => {
    if (!fm.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.isComposing || event.keyCode === 229) return
      if (event.target instanceof Element) {
        if (event.target.closest('input, textarea, select') !== null || (event.target as HTMLElement).isContentEditable) return
      }
      if (renameTarget !== null || deleteTarget !== null || createTarget !== null || rowMenu !== null || quickMenuOpen) return
      if (fm.previewFull) {
        fmStore.update(s => { s.previewFull = false })
        return
      }
      fmStore.setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [fm.open, fm.previewFull, fmStore, renameTarget, deleteTarget, createTarget, rowMenu, quickMenuOpen])

  // Window drag + resize.
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 })
  const [dragging, setDragging] = useState(false)
  const resizeRef = useRef({ mode: '', startX: 0, startY: 0, origX: 0, origY: 0, origW: 0, origH: 0 })
  const [resizing, setResizing] = useState(false)

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Let buttons inside the title bar (the close control) keep their click.
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    if (fm.maximized) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: fm.x, origY: fm.y }
    setDragging(true)
  }

  const onTitlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const { startX, startY, origX, origY } = dragRef.current
    const maxX = Math.max(0, window.innerWidth - fm.width)
    const maxY = Math.max(0, window.innerHeight - fm.height)
    const nextX = Math.min(maxX, Math.max(0, origX + (event.clientX - startX)))
    const nextY = Math.min(maxY, Math.max(0, origY + (event.clientY - startY)))
    fmStore.update(s => { s.x = nextX; s.y = nextY })
  }

  const onTitlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
  }

  const startResize = (mode: string) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = {
      mode, startX: event.clientX, startY: event.clientY,
      origX: fm.x, origY: fm.y, origW: fm.width, origH: fm.height,
    }
    setResizing(true)
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const r = resizeRef.current
    const dx = event.clientX - r.startX
    const dy = event.clientY - r.startY
    fmStore.update(s => {
      if (r.mode.includes('e')) {
        s.width = Math.max(FILE_MANAGER_MIN_WIDTH, Math.min(window.innerWidth - s.x, r.origW + dx))
      }
      if (r.mode.includes('s')) {
        s.height = Math.max(FILE_MANAGER_MIN_HEIGHT, Math.min(window.innerHeight - s.y, r.origH + dy))
      }
      if (r.mode.includes('w')) {
        const width = Math.max(FILE_MANAGER_MIN_WIDTH, Math.min(r.origX + r.origW, r.origW - dx))
        s.x = r.origX + (r.origW - width)
        s.width = width
      }
      if (r.mode.includes('n')) {
        const height = Math.max(FILE_MANAGER_MIN_HEIGHT, Math.min(r.origY + r.origH, r.origH - dy))
        s.y = r.origY + (r.origH - height)
        s.height = height
      }
    })
  }

  const onResizeUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setResizing(false)
  }

  const selectedEntry = useMemo(
    () => entries.find(entry => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  )
  const selectedSize = selectedEntry?.size ?? 0
  const selectedIsDir = selectedEntry?.isDir === true

  const rowClass = (entry: FsEntry): string => clsx(
    css.row,
    entry.hidden && fm.showHidden && css.rowHidden,
    entry.path === selectedPath && css.rowSelected,
  )

  const renderRow = (entry: FsEntry): ReactNode => {
    const isDir = entry.isDir
    const icon = isDir
      ? <IconFolderClose16 size={14} />
      : <IconCodeOutline16 size={14} />
    return (
      <div
        key={entry.path}
        role="button"
        tabIndex={0}
        className={rowClass(entry)}
        title={entry.path}
        onClick={() => { setSelectedPath(entry.path) }}
        onDoubleClick={() => { openEntry(entry) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            openEntry(entry)
          }
          if (event.key === 'Backspace' && isDir) {
            event.preventDefault()
            goUp()
          }
        }}
        onContextMenu={(event) => { openRowMenu(event, entry) }}
      >
        {icon}
        <span className={css.name}>{entry.name}</span>
        <span className={css.size}>{isDir ? '--' : formatSize(entry.size)}</span>
        <span className={css.mtime}>{formatMtime(entry.mtimeMs)}</span>
      </div>
    )
  }

  return (
    <>
      {/* Launch button: a permanent top-right control next to the sidebar's panel cluster. */}
      <button
        type="button"
        className={clsx(css.toggleButton, fm.open && css.toggleButtonActive)}
        aria-label={t('fmTitle')}
        title={t('fmTitle')}
        onClick={() => { fmStore.toggle() }}
      >
        <IconFolderOpenOutline16 />
      </button>

      {fm.open && (
        <div
          className={clsx(css.overlay, fm.maximized && css.overlayMaximized)}
          style={fm.maximized ? { left: 0, top: 0, width: '100vw', height: '100vh' } : { left: fm.x, top: fm.y, width: fm.width, height: fm.height }}
          data-dragging={dragging || resizing || resizingPreview || undefined}
        >
          {/* Title bar: drag surface + close. */}
          <div
            className={css.titleBar}
            onPointerDown={onTitlePointerDown}
            onPointerMove={onTitlePointerMove}
            onPointerUp={onTitlePointerUp}
            onDoubleClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button') === null) toggleMaximize()
            }}
          >
            <span className={css.titleIcon}><IconFolderOpenOutline16 size={14} /></span>
            <span className={css.titleText}>{fm.dir === '' ? t('fmTitle') : baseName(fm.dir)}</span>
            <button
              type="button"
              className={css.windowButton}
              aria-label={fm.maximized ? t('fmRestore') : t('fmMaximize')}
              title={fm.maximized ? t('fmRestore') : t('fmMaximize')}
              onClick={toggleMaximize}
            >
              {fm.maximized ? <RestoreGlyph /> : <IconFullscreenOutline16 size={14} />}
            </button>
            <button
              type="button"
              className={css.windowButton}
              aria-label={t('close')}
              title={t('close')}
              onClick={() => { fmStore.setOpen(false) }}
            >
              <IconCloseFill14 />
            </button>
          </div>

          {/* Path / toolbar. */}
          <div className={css.toolbar}>
            <button type="button" className={css.toolButton} aria-label={t('fmBack')} title={t('fmBack')} onClick={goBack} disabled={backStack.current.length === 0}>
              <IconChevronLeftOutline14 />
            </button>
            <button type="button" className={css.toolButton} aria-label={t('fmForward')} title={t('fmForward')} onClick={goForward} disabled={forwardStack.current.length === 0}>
              <IconChevronRightOutline14 />
            </button>
            <button type="button" className={css.toolButton} aria-label={t('parent')} title={t('parent')} onClick={goUp}>
              <IconChevronUpOutline14 />
            </button>
            <button type="button" className={css.toolButton} aria-label={t('refresh')} title={t('refresh')} onClick={refresh}>
              <IconRefreshOutline14 />
            </button>
            <button
              ref={quickButtonRef}
              type="button"
              className={css.textButton}
              onClick={() => { setQuickMenuOpen(true) }}
            >
              {t('fmQuickAccess')}
            </button>
            <div className={css.pathInput}>
              <Input
                value={pathInput}
                placeholder={t('fmPathPlaceholder')}
                onChange={(event) => { setPathInput(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitPath()
                  if (event.key === 'Escape') setPathInput(fm.dir)
                }}
              />
            </div>
            <button
              type="button"
              className={css.toolButton}
              aria-label={t('hiddenFiles')}
              title={t('hiddenFiles')}
              onClick={() => { fmStore.update(s => { s.showHidden = !s.showHidden }) }}
              data-active={fm.showHidden || undefined}
            >
              <IconCodeOutline16 size={14} />
            </button>
            <button
              type="button"
              className={css.toolButton}
              aria-label={t('fmPreview')}
              title={t('fmPreview')}
              onClick={() => { fmStore.update(s => { s.previewOpen = !s.previewOpen }) }}
            >
              <IconFolderOpen16 size={14} />
            </button>
          </div>

          {/* Main: list + preview. */}
          <div className={css.main} ref={mainRef}>
            {fm.previewFull === false && (
              <div className={css.listPane}>
                <div className={css.columnHeader}>
                  <div className={css.colName} onClick={() => { cycleSort('name') }}>{t('fmName')}</div>
                  <div className={css.colSize} onClick={() => { cycleSort('size') }}>{t('fmSize')}</div>
                  <div className={css.colMtime} onClick={() => { cycleSort('mtime') }}>{t('fmMtime')}</div>
                </div>
                <div className={css.fileList}>
                  {sessionId === undefined && <div className={css.empty}>{t('noSession')}</div>}
                  {sessionId !== undefined && level.error !== undefined && <div className={css.empty}>{level.error}</div>}
                  {sessionId !== undefined && level.error === undefined && level.entries === undefined && <div className={css.empty}>{t('loading')}</div>}
                  {sessionId !== undefined && level.entries !== undefined && entries.length === 0 && <div className={css.empty}>{t('fmEmpty')}</div>}
                  {entries.map(renderRow)}
                  {level.truncated === true && <div className={css.empty}>{t('fmTruncated')}</div>}
                </div>
                <div className={css.statusBar}>
                  <span>{t('fmCount', { count: entries.length })}</span>
                  {selectedPath !== null && <span>{t('fmSelected', { path: baseName(selectedPath), size: formatSize(selectedSize) })}</span>}
                  <span className={css.statusSpacer} />
                  <button type="button" className={css.statusButton} onClick={() => { setCreateTarget('file'); setCreateValue(''); setDialogError(null) }}>
                    <IconPlusOutline16 size={14} />
                    <span>{t('newFile')}</span>
                  </button>
                  <button type="button" className={css.statusButton} onClick={() => { setCreateTarget('dir'); setCreateValue(''); setDialogError(null) }}>
                    <IconFolderOpen16 size={14} />
                    <span>{t('fmNewFolder')}</span>
                  </button>
                </div>
              </div>
            )}
            {fm.previewOpen && fm.previewFull === false && (
              <div
                className={clsx(css.previewDivider, resizingPreview && css.previewDividerActive)}
                onPointerDown={onPreviewDividerDown}
                onPointerMove={onPreviewDividerMove}
                onPointerUp={onPreviewDividerUp}
              />
            )}
            {fm.previewOpen && (
              <div
                className={css.previewPane}
                style={fm.previewFull ? undefined : { flex: `0 0 ${Math.round(fm.previewRatio * 1000) / 10}%` }}
              >
                <div className={css.previewHeader}>
                  <span className={css.previewTitle} title={selectedPath ?? undefined}>
                    {selectedPath === null ? t('fmPreview') : baseName(selectedPath)}
                  </span>
                  <span className={css.previewActions}>
                    {fm.previewFull === false && (
                      <>
                        <button type="button" className={css.ratioButton} onClick={() => { setPreviewRatio(1 / 3) }}>1/3</button>
                        <button type="button" className={css.ratioButton} onClick={() => { setPreviewRatio(0.5) }}>1/2</button>
                        <button type="button" className={css.ratioButton} onClick={() => { setPreviewRatio(2 / 3) }}>2/3</button>
                      </>
                    )}
                    <button
                      type="button"
                      className={css.ratioButton}
                      aria-label={fm.previewFull ? t('fmExitFullPreview') : t('fmFullPreview')}
                      title={fm.previewFull ? t('fmExitFullPreview') : t('fmFullPreview')}
                      onClick={togglePreviewFull}
                    >
                      {fm.previewFull ? <RestoreGlyph /> : <IconFullscreenOutline16 size={12} />}
                    </button>
                  </span>
                </div>
                <div className={css.previewBody}>
                  {selectedPath === null || selectedIsDir ? (
                    <div className={css.empty}>{t('fmSelectFile')}</div>
                  ) : sessionId === undefined ? (
                    <div className={css.empty}>{t('noSession')}</div>
                  ) : (
                    <FilePreviewHost
                      ctx={ctx}
                      store={previewStore}
                      scope={{ sessionId, cwd }}
                      path={selectedPath}
                      title={baseName(selectedPath)}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Resize handles. */}
          {fm.maximized === false && (
            <>
              <div className={css.resizeN} onPointerDown={startResize('n')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeS} onPointerDown={startResize('s')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeE} onPointerDown={startResize('e')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeW} onPointerDown={startResize('w')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeNe} onPointerDown={startResize('ne')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeNw} onPointerDown={startResize('nw')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeSe} onPointerDown={startResize('se')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
              <div className={css.resizeSw} onPointerDown={startResize('sw')} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
            </>
          )}
        </div>
      )}

      {/* Quick-access dropdown (recent + favorites). */}
      <Menu
        open={quickMenuOpen}
        onClose={() => { setQuickMenuOpen(false) }}
        items={quickItems}
        onSelect={(id) => {
          setQuickMenuOpen(false)
          if (id === 'toggle-favorite') {
            fmStore.toggleFavorite(fm.dir)
            return
          }
          if (id.startsWith('fav:') || id.startsWith('recent:')) {
            const path = id.slice(id.indexOf(':') + 1)
            navigateTo(path)
          }
        }}
        portal
        align="start"
        getAnchorRect={() => (quickButtonRef.current === null ? null : quickButtonRef.current.getBoundingClientRect())}
        anchor={<span />}
      />

      {/* Context menu. */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={menuItems}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'rename') {
            startRename(target)
            return
          }
          if (id === 'delete') {
            setDeleteTarget(target)
            setDialogError(null)
            return
          }
          if (id === 'copyAbs') copyPath(target.path)
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Rename dialog. */}
      <Modal
        open={renameTarget !== null}
        onClose={closeDialog}
        title={t('renameTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeDialog} disabled={dialogBusy}>{t('cancel')}</Button>
            <Button variant="primary" disabled={dialogBusy || renameValue.trim() === ''} onClick={() => { void submitRename() }}>
              {t('rename')}
            </Button>
          </>
        )}
      >
        <Input
          autoFocus
          value={renameValue}
          placeholder={t('renamePlaceholder')}
          onChange={(event) => { setRenameValue(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && renameValue.trim() !== '') void submitRename()
            if (event.key === 'Escape') closeDialog()
          }}
        />
        {dialogError !== null && <div className={css.dialogError}>{dialogError}</div>}
      </Modal>

      {/* Delete confirmation dialog. */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDialog}
        title={t('deleteTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeDialog} disabled={dialogBusy}>{t('cancel')}</Button>
            <Button variant="primary" disabled={dialogBusy} onClick={() => { void submitDelete() }}>
              {t('delete')}
            </Button>
          </>
        )}
      >
        <p className={css.confirmDesc}>
          {deleteTarget === null ? '' : deleteTarget.isDir
            ? t('deleteDirDesc', { path: deleteTarget.path })
            : t('deleteFileDesc', { path: deleteTarget.path })}
        </p>
        {dialogError !== null && <div className={css.dialogError}>{dialogError}</div>}
      </Modal>

      {/* New file / folder dialog. */}
      <Modal
        open={createTarget !== null}
        onClose={closeDialog}
        title={createTarget === 'dir' ? t('fmNewFolder') : t('newFile')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeDialog} disabled={dialogBusy}>{t('cancel')}</Button>
            <Button variant="primary" disabled={dialogBusy || createValue.trim() === ''} onClick={() => { void submitCreate() }}>
              {t('create')}
            </Button>
          </>
        )}
      >
        <Input
          autoFocus
          value={createValue}
          placeholder={createTarget === 'dir' ? t('fmNewFolderPlaceholder') : t('fmNewFilePlaceholder')}
          onChange={(event) => { setCreateValue(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && createValue.trim() !== '') void submitCreate()
            if (event.key === 'Escape') closeDialog()
          }}
        />
        {dialogError !== null && <div className={css.dialogError}>{dialogError}</div>}
      </Modal>
    </>
  )
}
