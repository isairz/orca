import { IMAGE_FILE_EXTENSIONS } from '../../shared/image-file-extensions'

export type ParsedCodexImagePrefix = {
  imagePaths: string[]
  query: string
}

export function parseLeadingCodexImagePaths(text: string): ParsedCodexImagePrefix {
  const imagePaths: string[] = []
  let query = text
  while (isAbsolutePathStart(query)) {
    const imageEnd = firstImageExtensionEnd(query)
    if (imageEnd === null) {
      break
    }
    imagePaths.push(query.slice(0, imageEnd))
    query = query.slice(imageEnd)
  }
  return { imagePaths, query }
}

export function mergeCodexImagePaths(
  localImagePaths: readonly string[],
  parsedImagePaths: readonly string[]
): string[] {
  const remainingLocalCounts = new Map<string, number>()
  for (const path of localImagePaths) {
    remainingLocalCounts.set(path, (remainingLocalCounts.get(path) ?? 0) + 1)
  }
  const merged = [...localImagePaths]
  for (const path of parsedImagePaths) {
    const remaining = remainingLocalCounts.get(path) ?? 0
    if (remaining > 0) {
      remainingLocalCounts.set(path, remaining - 1)
    } else {
      merged.push(path)
    }
  }
  return merged
}

function isAbsolutePathStart(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(value) ||
    /^[\\/]{2}[^\\/\r\n]+[\\/][^\\/\r\n]+[\\/]/.test(value)
  )
}

function firstImageExtensionEnd(value: string): number | null {
  const lower = value.toLowerCase()
  for (let index = 0; index < lower.length; index += 1) {
    for (const extension of IMAGE_FILE_EXTENSIONS) {
      if (!lower.startsWith(extension, index)) {
        continue
      }
      const end = index + extension.length
      const next = value[end]
      if (next === '/' || next === '\\') {
        if (startsWithNestedAbsoluteImagePath(value.slice(end))) {
          return end
        }
        continue
      }
      if (next === '.' || next === '-' || next === '_') {
        continue
      }
      // Codex concatenates attachments without separators; whitespace marks a path mentioned in prose.
      return next === undefined || !/\s/.test(next) ? end : null
    }
  }
  return null
}

function startsWithNestedAbsoluteImagePath(value: string): boolean {
  if (value.startsWith('\\\\')) {
    return firstImageExtensionEnd(value) !== null
  }
  return value.startsWith('/') && firstImageExtensionEnd(value) !== null
}
