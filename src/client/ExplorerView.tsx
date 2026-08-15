/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu to copy the relative or absolute path, download a
 * file, rename it, or delete it (files and directories; destructive actions
 * are confirmed in a modal).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconEditOutline16,
  IconFolderClose16, IconFolderOpen16, IconRefreshOutline16, IconTrashOutline16, Input, Menu, Modal,
  writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onReferenceFile } = props

  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; isRoot: boolean; x: number; y: number } | null>(null)
  /** The pending rename operation (opened from the row context menu). */
  const [renameTarget, setRenameTarget] = useState<{ path: string; isDir: boolean } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** The pending delete operation (opened from the row context menu). */
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDir: boolean } | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  /** Clear every cached level and force the visible set to reload. */
  const refreshTree = useCallback(() => {
    dataRef.current = {}
    setData({})
    setRefreshTick(tick => tick + 1)
  }, [])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh button wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (ok === false) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean, isRoot = false): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, isRoot, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

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
      await api.fsRename({ sessionId, cwd }, target.path, name)
      setRenameTarget(null)
      refreshTree()
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
      await api.fsDelete({ sessionId, cwd }, target.path)
      setDeleteTarget(null)
      refreshTree()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const closeRename = (): void => {
    if (dialogBusy) return
    setRenameTarget(null)
    setDialogError(null)
  }

  const closeDelete = (): void => {
    if (dialogBusy) return
    setDeleteTarget(null)
    setDialogError(null)
  }

  const root = cwd

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              <span className={css.explorerName}>{entry.name}</span>
              {rowActions(entry)}
            </div>
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
        >
          <IconCodeOutline16 size={14} />
          <span className={css.explorerName}>{entry.name}</span>
          {rowActions(entry)}
        </div>
      )
    })
  }

  const menuItems: MenuEntry[] = []
  if (rowMenu !== null && rowMenu.isDir === false) {
    menuItems.push({ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> })
  }
  if (rowMenu !== null && rowMenu.isRoot === false) {
    menuItems.push({ id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={14} /> })
    menuItems.push({ type: 'separator', id: 'fs-sep' })
    menuItems.push({ id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true })
  }
  menuItems.push({ id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> })
  menuItems.push({ id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> })

  const deleteDescription = deleteTarget === null
    ? ''
    : deleteTarget.isDir
      ? t('deleteDirDesc', { path: relativeTo(cwd ?? '', deleteTarget.path) })
      : t('deleteFileDesc', { path: relativeTo(cwd ?? '', deleteTarget.path) })

  return (
    <div className={css.explorer}>
      <div className={css.explorerHeader}>
        <span className={css.explorerRoot} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refreshTree}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className={css.explorerBody}>
        {root === undefined ? (
          <div className={css.explorerEmpty}>{t('noSession')}</div>
        ) : (
          <>
            <div
              className={css.explorerRow}
              style={{ paddingLeft: 6 }}
              onContextMenu={(event) => { openRowMenu(event, root, true, true) }}
            >
              <IconFolderOpen16 size={14} />
              <span className={css.explorerName}>{baseName(root)}</span>
              {copiedPath === root
                ? <span className={css.explorerCopied}>{t('copied')}</span>
                : (
                  <button
                    type="button"
                    className={css.explorerRef}
                    aria-label={t('referenceFile')}
                    title={t('referenceFile')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onReferenceFile(root)
                    }}
                  >
                    {t('referenceFile')}
                  </button>
                )}
            </div>
            {data[root] !== undefined && renderLevel(root, 1)}
          </>
        )}
      </div>
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the explorer's overflow clip cannot crop it).
      */}
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
            setDeleteTarget({ path: target.path, isDir: target.isDir })
            setDialogError(null)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Rename dialog. */}
      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        title={t('renameTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeRename} disabled={dialogBusy}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={dialogBusy || renameValue.trim() === ''}
              onClick={() => { void submitRename() }}
            >
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
            if (event.key === 'Escape') closeRename()
          }}
        />
        {dialogError !== null && <div className={css.explorerDialogError}>{dialogError}</div>}
      </Modal>

      {/* Delete confirmation dialog. */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        title={t('deleteTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeDelete} disabled={dialogBusy}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={dialogBusy}
              onClick={() => { void submitDelete() }}
            >
              {t('delete')}
            </Button>
          </>
        )}
      >
        <p className={css.explorerConfirmDesc}>{deleteDescription}</p>
        {dialogError !== null && <div className={css.explorerDialogError}>{dialogError}</div>}
      </Modal>
    </div>
  )
}
