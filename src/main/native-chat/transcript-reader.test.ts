import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatTranscript } from './transcript-reader'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

async function writeFixture(prefix: string, records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, jsonLines(records))
  return filePath
}

describe('readNativeChatTranscript (claude)', () => {
  it('decodes OpenClaude with the Claude transcript format', async () => {
    const filePath = await writeFixture('orca-native-chat-openclaude-', [
      {
        type: 'assistant',
        uuid: 'openclaude-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
      }
    ])

    await expect(
      readNativeChatTranscript('openclaude', 'session', { filePath })
    ).resolves.toMatchObject({ messages: [{ id: 'openclaude-assistant' }] })
  })

  it('returns ordered user/assistant/tool messages with no 5-message cap', async () => {
    const records: unknown[] = []
    // 4 user/assistant turns = 8 messages, well past the AI-Vault preview cap.
    for (let turn = 0; turn < 4; turn++) {
      records.push({
        type: 'user',
        uuid: `u-${turn}`,
        timestamp: `2026-06-01T10:0${turn}:00.000Z`,
        message: { role: 'user', content: `Prompt **${turn}**` }
      })
      records.push({
        type: 'assistant',
        uuid: `a-${turn}`,
        timestamp: `2026-06-01T10:0${turn}:30.000Z`,
        message: { role: 'assistant', content: [{ type: 'text', text: `Reply _${turn}_` }] }
      })
    }
    // A tool_use then a tool_result (carried on a user record).
    records.push({
      type: 'assistant',
      uuid: 'a-tool',
      timestamp: '2026-06-01T10:05:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
      }
    })
    records.push({
      type: 'user',
      uuid: 'u-toolresult',
      timestamp: '2026-06-01T10:05:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'file-a\nfile-b', is_error: false }]
      }
    })

    const filePath = await writeFixture('orca-native-chat-claude-', records)
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    expect('messages' in result).toBe(true)
    if (!('messages' in result)) {
      return
    }

    expect(result.messages.length).toBe(10)
    expect(result.messages.length).toBeGreaterThan(5)
    expect(result.messages[0]).toMatchObject({ role: 'user', source: 'transcript' })
    // Markdown text preserved verbatim.
    expect(result.messages[0].blocks[0]).toEqual({ type: 'text', text: 'Prompt **0**' })
    expect(result.messages[1].blocks[0]).toEqual({ type: 'text', text: 'Reply _0_' })

    const toolCall = result.messages.find((m) => m.blocks[0]?.type === 'tool-call')
    expect(toolCall?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'Bash',
      input: { command: 'ls' }
    })

    const toolResult = result.messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(toolResult?.blocks[0]).toEqual({ type: 'tool-result', output: 'file-a\nfile-b' })
  })

  it('drops structurally marked injected user turns but keeps their tool results', async () => {
    const filePath = await writeFixture('orca-native-chat-claude-meta-', [
      {
        type: 'user',
        uuid: 'u-real',
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'user', content: 'fix the login bug' }
      },
      {
        type: 'user',
        uuid: 'u-meta',
        isMeta: true,
        timestamp: '2026-06-01T10:00:01.000Z',
        message: {
          role: 'user',
          content: 'Another Claude session sent a message:\n<agent-message from="reviewer">hi'
        }
      },
      {
        type: 'user',
        uuid: 'u-compact',
        isCompactSummary: true,
        timestamp: '2026-06-01T10:00:02.000Z',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation.'
        }
      },
      {
        type: 'user',
        uuid: 'u-meta-toolresult',
        isMeta: true,
        timestamp: '2026-06-01T10:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ok', is_error: false }]
        }
      },
      {
        type: 'user',
        uuid: 'u-meta-mixed',
        isMeta: true,
        timestamp: '2026-06-01T10:00:04.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>hidden machinery' },
            { type: 'tool_result', content: 'mixed result', is_error: false }
          ]
        }
      }
    ])
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }
    expect(result.messages.map((m) => m.id)).toEqual([
      'u-real',
      'u-meta-toolresult',
      'u-meta-mixed'
    ])
    expect(result.messages[1].role).toBe('tool')
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'mixed result' }]
    })
  })

  it('restores multiple Claude image-only attachments from the paired meta record', async () => {
    const firstPath = '/Users/me/Desktop/first.png'
    const secondPath = '/Users/me/Desktop/second.png'
    const filePath = await writeFixture('orca-native-chat-claude-images-', [
      {
        type: 'user',
        uuid: 'u-images',
        timestamp: '2026-07-31T02:05:16.006Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Image #4] [Image #5]' },
            { type: 'image', source: { type: 'base64', data: 'omitted' } },
            { type: 'image', source: { type: 'base64', data: 'omitted' } }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u-image-paths',
        isMeta: true,
        timestamp: '2026-07-31T02:05:16.006Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `[Image: source: ${firstPath}]` },
            { type: 'text', text: `[Image: source: ${secondPath}]` }
          ]
        }
      }
    ])

    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: 'u-images',
      role: 'user',
      blocks: [{ type: 'text', text: '[Image #4] [Image #5]' }]
    })
    expect(result.messages[1]).toMatchObject({
      id: 'u-image-paths',
      role: 'user',
      blocks: [
        { type: 'text', text: `[Image: source: ${firstPath}]` },
        { type: 'text', text: `[Image: source: ${secondPath}]` }
      ]
    })
  })

  it('marks thinking-only assistant content as a reasoning surface', async () => {
    const filePath = await writeFixture('orca-native-chat-claude-think-', [
      {
        type: 'assistant',
        uuid: 'a-think',
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] }
      }
    ])
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }
    expect(result.messages[0].blocks[0]).toEqual({ type: 'text', text: 'pondering' })
  })
})

describe('readNativeChatTranscript (codex)', () => {
  it.each([
    '/Users/me/Desktop/My Screenshot.png',
    'C:\\Users\\me\\Desktop\\My Screenshot.webp',
    '\\\\server\\share\\My Screenshot.jpg'
  ])(
    'restores a pasted image and prompt from Codex user_message text for %s',
    async (imagePath) => {
      const filePath = await writeFixture('orca-native-chat-codex-image-', [
        {
          type: 'session_meta',
          timestamp: '2026-06-01T10:00:00.000Z',
          payload: { id: 'codex-sess', cwd: '/repo' }
        },
        {
          type: 'event_msg',
          timestamp: '2026-06-01T10:00:01.000Z',
          payload: {
            type: 'user_message',
            message: `${imagePath}what do you see?`,
            images: [],
            local_images: []
          }
        }
      ])

      const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
      if (!('messages' in result)) {
        throw new Error('expected messages')
      }

      expect(result.messages).toMatchObject([
        {
          role: 'user',
          blocks: [
            { type: 'image-ref', path: imagePath },
            { type: 'text', text: 'what do you see?' }
          ]
        }
      ])
    }
  )

  it('restores current Codex local_images with its prompt marker', async () => {
    const imagePath = '/tmp/orca-pr-attachment.png'
    const filePath = await writeFixture('orca-native-chat-codex-local-image-', [
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:00:01.000Z',
        payload: {
          type: 'user_message',
          message: '[Image #1] describe this',
          local_images: [imagePath]
        }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }

    expect(result.messages[0]?.blocks).toEqual([
      { type: 'image-ref', path: imagePath },
      { type: 'text', text: '[Image #1] describe this' }
    ])
  })

  it.each([['/tmp/second.jpg'], ['C:\\Temp\\second.jpg']])(
    'restores multiple pasted images from one Codex user_message: %s',
    async (secondPath) => {
      const firstPath = '/tmp/first.png'
      const filePath = await writeFixture('orca-native-chat-codex-images-', [
        {
          type: 'event_msg',
          timestamp: '2026-06-01T10:00:01.000Z',
          payload: {
            type: 'user_message',
            message: `${firstPath}${secondPath}compare these`
          }
        }
      ])

      const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
      if (!('messages' in result)) {
        throw new Error('expected messages')
      }

      expect(result.messages[0]?.blocks).toEqual([
        { type: 'image-ref', path: firstPath },
        { type: 'image-ref', path: secondPath },
        { type: 'text', text: 'compare these' }
      ])
    }
  )

  it('does not stop at an image extension inside a directory name', async () => {
    const imagePath = '/tmp/screens.png-copy/real.jpg'
    const filePath = await writeFixture('orca-native-chat-codex-image-directory-', [
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:00:01.000Z',
        payload: {
          type: 'user_message',
          message: `${imagePath}compare this`
        }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }

    expect(result.messages[0]?.blocks).toEqual([
      { type: 'image-ref', path: imagePath },
      { type: 'text', text: 'compare this' }
    ])
  })

  it.each([
    'Open /tmp/example.png and describe it',
    '/tmp/example.png is the image to inspect',
    '/tmp/example.png.bak is not an image attachment'
  ])('preserves an ordinary Codex prompt that mentions an image path: %s', async (text) => {
    const filePath = await writeFixture('orca-native-chat-codex-image-mention-', [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: { id: 'codex-sess', cwd: '/repo' }
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:00:01.000Z',
        payload: { type: 'user_message', message: text }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text }])
  })

  it('maps tool calls and results to tool-call/tool-result blocks', async () => {
    const filePath = await writeFixture('orca-native-chat-codex-', [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: { id: 'codex-sess', cwd: '/repo' }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Run the build' }]
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:02.000Z',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I will run it' }] }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:03.000Z',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"command":["bash","-lc","make"]}'
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:04.000Z',
        payload: {
          type: 'function_call_output',
          output: { content: 'build ok', success: true }
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:05.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
    if (!('messages' in result)) {
      throw new Error(`expected messages, got error`)
    }

    const roles = result.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'reasoning', 'assistant', 'tool', 'assistant'])

    const call = result.messages.find((m) => m.blocks[0]?.type === 'tool-call')
    expect(call?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'shell',
      input: '{"command":["bash","-lc","make"]}'
    })

    const toolResult = result.messages.find((m) => m.blocks[0]?.type === 'tool-result')
    expect(toolResult?.blocks[0]).toEqual({ type: 'tool-result', output: 'build ok' })

    const reasoning = result.messages.find((m) => m.role === 'reasoning')
    expect(reasoning?.blocks[0]).toEqual({ type: 'text', text: 'I will run it' })
  })
})

describe('readNativeChatTranscript (errors)', () => {
  // Why: ENOENT after a successful resolve is the same first-flush/rotation
  // race as an unresolved path (#8401) — it must stay retry-worthy.
  it('marks an ENOENT on a directly-passed path as notFound (vanished after resolve)', async () => {
    const result = await readNativeChatTranscript('claude', 'sess', {
      filePath: join(tmpdir(), 'orca-native-chat-does-not-exist.jsonl')
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBe(true)
    }
  })

  it('returns a real read error (no notFound) when the path exists but is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unreadable-'))
    tempRoots.push(root)
    // A directory instead of a file fails the read with a non-ENOENT error.
    const result = await readNativeChatTranscript('claude', 'sess', { filePath: root })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBeUndefined()
    }
  })

  // Why: a just-created Claude Code session's transcript can take up to minutes
  // to exist on disk (#8401) — the miss must be marked retry-worthy so callers
  // above (cache, watch, renderer) don't settle into a permanent error.
  it('marks an unresolved session as notFound so callers know to retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-noresolve-'))
    tempRoots.push(root)
    const result = await readNativeChatTranscript('claude', 'missing', {
      claudeProjectsDir: join(root, 'empty')
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBe(true)
    }
  })
})

describe('readNativeChatTranscriptTailFile', () => {
  it('keeps a missing tail retry-worthy for the live-session seed', async () => {
    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'sess',
      filePath: join(tmpdir(), 'orca-native-chat-tail-does-not-exist.jsonl'),
      limit: 40
    })

    expect(result).toMatchObject({ notFound: true })
  })

  it('windows to nothing for a non-positive limit instead of the whole tail', async () => {
    const decode = nativeChatLineDecoderForAgent('claude')!
    const filePath = await writeFixture('orca-native-chat-tail-limit-', [
      {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }
      },
      {
        type: 'assistant',
        uuid: 'a-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] }
      }
    ])

    const result = await readNativeChatTranscriptTailFile(filePath, 0, decode, true)

    expect(result.messages).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})
