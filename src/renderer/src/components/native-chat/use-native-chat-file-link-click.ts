import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import type {
  CommentMarkdownFilePathSpans,
  CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { isFilePathCodeSpan } from '@/lib/file-path-code-span'
import { isPathInsideWorktree } from '@/lib/terminal-links'
import { translate } from '@/i18n/i18n'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'

// Why: chat text is agent-authored and can carry injected content, so a click
// must not reach openDetectedFilePath's ambient self-grant
// (src/main/ipc/filesystem-auth.ts authorizes any path it is handed). Confining
// chat opens to the worktree keeps a crafted message from opening ~/.ssh/id_rsa.
function openWorktreeFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext,
  options: { openWithSystemDefault: boolean; reportFailure: boolean }
): boolean {
  const target = resolveNativeChatFileLink(href, context)
  if (!target) {
    if (options.reportFailure) {
      toast.error(
        translate('components.native-chat.fileLinkUnresolved', 'Could not resolve that file path')
      )
    }
    return false
  }
  if (!isPathInsideWorktree(target.absolutePath, context.worktreePath)) {
    toast.error(
      translate(
        'components.native-chat.fileLinkOutsideWorktree',
        'That file is outside the workspace'
      )
    )
    return true
  }
  openDetectedFilePath(target.absolutePath, target.line, target.column, {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    openWithSystemDefault: options.openWithSystemDefault
  })
  return true
}

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      // A non-file href (http, mailto) resolves to null here and must fall
      // through to the anchor's default handling, so it reports no failure.
      const claimed = openWorktreeFileLink(href, context, {
        openWithSystemDefault: event.shiftKey,
        reportFailure: false
      })
      if (!claimed) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [context]
  )
  return context ? openFileLink : undefined
}

export function useNativeChatFilePathSpans(
  context: NativeChatFileLinkContext | null
): CommentMarkdownFilePathSpans | undefined {
  const onOpen = useCallback<CommentMarkdownFilePathSpans['onOpen']>(
    (event, pathText) => {
      if (!context) {
        return
      }
      // The span was already classified as a path, so a miss here is a real
      // failure worth surfacing rather than a silent no-op.
      openWorktreeFileLink(pathText, context, {
        openWithSystemDefault: event.shiftKey,
        reportFailure: true
      })
    },
    [context]
  )
  return useMemo(
    () => (context ? { isFilePath: isFilePathCodeSpan, onOpen } : undefined),
    [context, onOpen]
  )
}
