import { describe, expect, it } from 'vitest'
import { mergeCodexImagePaths, parseLeadingCodexImagePaths } from './codex-image-path-parser'

describe('parseLeadingCodexImagePaths', () => {
  it('splits concatenated POSIX and Windows image paths from the prompt', () => {
    expect(parseLeadingCodexImagePaths('/tmp/first.pngC:\\Temp\\second.jpgcompare these')).toEqual({
      imagePaths: ['/tmp/first.png', 'C:\\Temp\\second.jpg'],
      query: 'compare these'
    })
  })

  it('splits concatenated root-level POSIX image paths', () => {
    expect(parseLeadingCodexImagePaths('/a.png/b.pngcompare')).toEqual({
      imagePaths: ['/a.png', '/b.png'],
      query: 'compare'
    })
  })

  it('keeps extension-like directory names inside one image path', () => {
    expect(parseLeadingCodexImagePaths('/tmp/screens.png-copy/real.jpgcompare this')).toEqual({
      imagePaths: ['/tmp/screens.png-copy/real.jpg'],
      query: 'compare this'
    })
  })

  it('does not treat a whitespace-delimited image path mention as an attachment', () => {
    const text = '/tmp/example.png is the image to inspect'
    expect(parseLeadingCodexImagePaths(text)).toEqual({ imagePaths: [], query: text })
  })
})

describe('mergeCodexImagePaths', () => {
  it('preserves duplicate attachments while collapsing the same evidence across schemas', () => {
    expect(mergeCodexImagePaths(['/tmp/a.png', '/tmp/a.png'], ['/tmp/a.png'])).toEqual([
      '/tmp/a.png',
      '/tmp/a.png'
    ])
    expect(mergeCodexImagePaths(['/tmp/a.png'], ['/tmp/a.png', '/tmp/a.png'])).toEqual([
      '/tmp/a.png',
      '/tmp/a.png'
    ])
  })
})
