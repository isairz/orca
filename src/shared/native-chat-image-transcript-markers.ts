import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/
const IMAGE_PROMPT_MARKERS = /\[Image #\d+\]/g
const IMAGE_PROMPT_MARKER_AT_START = /^[^\S\r\n]*\[Image #\d+\]/
const IMAGE_PROMPT_MARKER_AT_END = /\[Image #\d+\][^\S\r\n]*$/
const HORIZONTAL_WHITESPACE_START = /^[^\S\r\n]+/
const HORIZONTAL_WHITESPACE_END = /[^\S\r\n]+$/

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

export function isImageSourceUserTurn(message: NativeChatMessage): boolean {
  return message.role === 'user' && imageSourcePaths(message).length > 0
}

export function stripImagePromptMarker(text: string): string {
  const stripped = text.replace(IMAGE_PROMPT_MARKERS, '')
  if (stripped === text) {
    return text
  }
  let result = IMAGE_PROMPT_MARKER_AT_START.test(text)
    ? stripped.replace(HORIZONTAL_WHITESPACE_START, '')
    : stripped
  if (IMAGE_PROMPT_MARKER_AT_END.test(text)) {
    result = result.replace(HORIZONTAL_WHITESPACE_END, '')
  }
  return result
}

export function normalizeNativeChatUserText(text: string): string {
  return stripImagePromptMarker(text).trim().replace(/\s+/g, ' ')
}

export function normalizedNativeChatUserMessageText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const normalized = normalizeNativeChatUserText(
    message.blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join(' ')
  )
  return normalized || null
}

function stripImagePromptMarkersFromTextBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatBlock[] {
  let sawText = false
  let next: NativeChatBlock[] | null = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (!isTextBlock(block)) {
      next?.push(block)
      continue
    }
    const isFirstText = !sawText
    sawText = true
    const text = stripImagePromptMarker(block.text)
    if (!text.trim() && (text !== block.text || isFirstText)) {
      next ??= blocks.slice(0, index)
      continue
    }
    if (text !== block.text) {
      next ??= blocks.slice(0, index)
      next.push({ ...block, text })
      continue
    }
    next?.push(block)
  }
  return next ?? (blocks as NativeChatBlock[])
}

export function hasImagePromptMarker(message: NativeChatMessage): boolean {
  return message.blocks.some((block) => isTextBlock(block) && IMAGE_PROMPT_MARKER.test(block.text))
}

function imagePromptMarkerStartsMessage(message: NativeChatMessage): boolean {
  const first = message.blocks[0]
  return isTextBlock(first) && IMAGE_PROMPT_MARKER_AT_START.test(first.text)
}

function imageSourcePaths(message: NativeChatMessage): string[] {
  if (message.blocks.length === 0) {
    return []
  }
  const paths: string[] = []
  for (const block of message.blocks) {
    if (!isTextBlock(block)) {
      return []
    }
    const path = imageSourcePathFromText(block.text)
    if (!path) {
      return []
    }
    paths.push(path)
  }
  return paths
}

function imageRefBlocks(paths: readonly string[]): NativeChatBlock[] {
  return paths.map((path) => ({ type: 'image-ref' as const, path }))
}

/** Claude records image paths as source turns followed by a prompt carrying
 *  image markers. Merge the whole run back into one native user turn. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  let normalized: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'user') {
      normalized?.push(message)
      continue
    }
    const next = messages[index + 1]
    const nextImagePaths = next?.role === 'user' ? imageSourcePaths(next) : []
    if (
      imagePromptMarkerStartsMessage(message) &&
      next?.source === message.source &&
      nextImagePaths.length > 0
    ) {
      normalized ??= messages.slice(0, index)
      normalized.push({
        ...message,
        blocks: [
          ...imageRefBlocks(nextImagePaths),
          ...stripImagePromptMarkersFromTextBlocks(message.blocks)
        ]
      })
      index += 1
      continue
    }
    const currentImagePaths = imageSourcePaths(message)
    if (currentImagePaths.length > 0) {
      normalized ??= messages.slice(0, index)
      const imagePaths = [...currentImagePaths]
      let nextIndex = index + 1
      while (nextIndex < messages.length) {
        const candidate = messages[nextIndex]!
        const candidatePaths = imageSourcePaths(candidate)
        if (
          candidate.role !== 'user' ||
          candidate.source !== message.source ||
          candidatePaths.length === 0
        ) {
          break
        }
        imagePaths.push(...candidatePaths)
        nextIndex += 1
      }
      const prompt = messages[nextIndex]
      if (
        prompt?.role === 'user' &&
        prompt.source === message.source &&
        hasImagePromptMarker(prompt)
      ) {
        normalized.push({
          ...prompt,
          blocks: [
            ...imageRefBlocks(imagePaths),
            ...stripImagePromptMarkersFromTextBlocks(prompt.blocks)
          ]
        })
        index = nextIndex
        continue
      }
      normalized.push({
        ...message,
        blocks: imageRefBlocks(currentImagePaths)
      })
      continue
    }
    const blocks = stripImagePromptMarkersFromTextBlocks(message.blocks)
    if (blocks === message.blocks) {
      normalized?.push(message)
    } else {
      normalized ??= messages.slice(0, index)
      normalized.push({ ...message, blocks })
    }
  }
  return normalized ?? (messages as NativeChatMessage[])
}
