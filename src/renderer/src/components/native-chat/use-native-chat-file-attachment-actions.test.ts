import { describe, expect, it } from 'vitest'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import { nativeChatFileDropTargetsPane } from './use-native-chat-file-attachment-actions'

describe('nativeChatFileDropTargetsPane', () => {
  const payload = {
    paths: ['/tmp/image.png'],
    target: NATIVE_FILE_DROP_TARGET.composer,
    tabId: 'tab-a',
    paneLeafId: 'leaf-a'
  }

  it('routes a composer drop only to its owning tab and pane', () => {
    expect(nativeChatFileDropTargetsPane(payload, 'tab-a', 'tab-a:leaf-a')).toBe(true)
    expect(nativeChatFileDropTargetsPane(payload, 'tab-b', 'tab-b:leaf-b')).toBe(false)
    expect(nativeChatFileDropTargetsPane(payload, 'tab-a', 'tab-a:leaf-b')).toBe(false)
  })

  it('rejects unscoped composer drops instead of broadcasting them to every open tab', () => {
    expect(
      nativeChatFileDropTargetsPane(
        { paths: ['/tmp/image.png'], target: NATIVE_FILE_DROP_TARGET.composer },
        'tab-a',
        'tab-a:leaf-a'
      )
    ).toBe(false)
  })
})
