import { useCallback, useEffect } from 'react'
import {
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropPayload
} from '../../../../shared/native-file-drop'

export function useNativeChatFileAttachmentActions(
  terminalTabId: string,
  paneKey: string,
  attachExternalPaths: (paths: string[]) => void
): { pickAttachment: () => void } {
  useEffect(
    () =>
      window.api.ui.onFileDrop((payload) => {
        if (nativeChatFileDropTargetsPane(payload, terminalTabId, paneKey)) {
          attachExternalPaths(payload.paths)
        }
      }),
    [attachExternalPaths, paneKey, terminalTabId]
  )

  const pickAttachment = useCallback(() => {
    void (async () => {
      const filePath = await window.api.shell.pickAttachment()
      if (filePath) {
        attachExternalPaths([filePath])
      }
    })()
  }, [attachExternalPaths])

  return { pickAttachment }
}

export function nativeChatFileDropTargetsPane(
  payload: NativeFileDropPayload,
  terminalTabId: string,
  paneKey: string
): payload is Extract<NativeFileDropPayload, { target: typeof NATIVE_FILE_DROP_TARGET.composer }> {
  if (payload.target !== NATIVE_FILE_DROP_TARGET.composer) {
    return false
  }
  const panePrefix = `${terminalTabId}:`
  const paneLeafId = paneKey.startsWith(panePrefix) ? paneKey.slice(panePrefix.length) : ''
  return (
    paneLeafId.length > 0 && payload.tabId === terminalTabId && payload.paneLeafId === paneLeafId
  )
}
