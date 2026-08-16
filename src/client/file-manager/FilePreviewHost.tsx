/**
 * Preview host for the floating file manager. Reuses the exact viewer
 * registry + load planning as the sidebar editor (EditorHost), but renders
 * WITHOUT creating a sidebar tab and without the editor header chrome. The
 * floating window owns selection; this component only shows the file.
 */
import { createElement, useEffect, useState } from 'react'
import type { Context } from '../../context-types.ts'
import { api, htmlUrl, mediaUrl, type SessionScope } from '../api.ts'
import { BinaryDownload } from '../binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from '../editor-load.ts'
import { t } from '../locales.ts'
import type { FileViewerDescriptor } from '../service.ts'
import type { SidebarStore } from '../state.ts'
import css from '../sidebar.module.css'

type FilePreviewLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }
  | { status: 'htmlRaw'; url: string }
  | { status: 'empty' }

export function FilePreviewHost(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
}) {
  const { ctx, store, scope, path, title } = props
  const [load, setLoad] = useState<FilePreviewLoad>({ status: 'empty' })

  useEffect(() => {
    if (path === '') {
      setLoad({ status: 'empty' })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const isHtmlPath = (): boolean => /\.(?:html?|xhtml)$/i.test(path)
    // HTML must always have a preview surface: if the viewer registry has no
    // renderer (or the file looks binary to the NUL probe), fall back to a
    // direct same-origin iframe through the unsafe HTML route.
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          if (isHtmlPath()) {
            setLoad({ status: 'htmlRaw', url: htmlUrl(scope, path, true) })
            return
          }
          setLoad({ status: 'binary' })
          return
        case 'render':
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            if (result.kind === 'binary' && isHtmlPath()) {
              setLoad({ status: 'htmlRaw', url: htmlUrl(scope, path, true) })
              return
            }
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true }
  }, [scope.sessionId, scope.cwd, path, ctx])

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={path}>{title}</span>
      </div>
      {load.status === 'empty' && <div className={css.editorPlaceholder}>{t('fmSelectFile')}</div>}
      {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
      {load.status === 'binary' && <BinaryDownload scope={scope} path={path} />}
      {load.status === 'htmlRaw' && (
        <iframe
          className={css.editorHtml}
          src={load.url}
          sandbox={undefined}
          referrerPolicy="no-referrer"
          title={title}
        />
      )}
      {load.status === 'ready' && createElement(load.viewer.component, {
        ctx, store, scope, path, title,
        viewerId: load.viewer.id,
        content: load.content,
        truncated: load.truncated,
        mediaUrl: load.mediaUrl,
        customData: load.customData,
      })}
    </div>
  )
}
