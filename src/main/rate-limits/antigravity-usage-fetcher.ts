import { execFile } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const COMMAND_TIMEOUT_MS = 4_000
const FETCH_TIMEOUT_MS = 5_000
const LOG_PREFIX_BYTES = 16 * 1024
const SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const AGY_LOG_DIR = path.join(homedir(), '.gemini', 'antigravity-cli', 'log')

export type AgyQuotaEndpoint = {
  pid: number
  port: number
  csrfToken: string | null
}

type AgySummaryBucket = {
  bucketId?: unknown
  window?: unknown
  remainingFraction?: unknown
  resetTime?: unknown
}

type AgySummaryGroup = {
  displayName?: unknown
  buckets?: unknown
}

type AgySummaryResponse = {
  response?: {
    groups?: unknown
  }
}

type LsofListener = {
  pid: number
  processName: string
  port: number
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  windows?: { session: RateLimitWindow; weekly: RateLimitWindow }
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: windows?.session ?? null,
    weekly: windows?.weekly ?? null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'live-session',
      credentialSource: 'agy-local-service',
      authProvenance: 'antigravity',
      ...(status === 'unavailable' ? { failureKind: 'cli-unavailable' as const } : {})
    }
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
    )
  }
}

async function readFilePrefix(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(LOG_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function parseAgyLogEndpoint(log: string): AgyQuotaEndpoint | null {
  const pid = Number.parseInt(
    log.match(/Starting language server process with pid\s+(\d+)/)?.[1] ?? '',
    10
  )
  const port = Number.parseInt(
    log.match(/Language server listening on (?:random|fixed) port at\s+(\d+)\s+for HTTP\b/)?.[1] ??
      '',
    10
  )
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  return { pid, port, csrfToken: null }
}

export function parseLsofListeners(output: string): LsofListener[] {
  const listeners: LsofListener[] = []
  let pid: number | null = null
  let processName = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10)
      processName = ''
      continue
    }
    if (line.startsWith('c')) {
      processName = line.slice(1)
      continue
    }
    if (!line.startsWith('n') || !pid || !processName) {
      continue
    }
    const port = Number.parseInt(line.match(/:(\d+)(?:\s+\(LISTEN\))?$/)?.[1] ?? '', 10)
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      listeners.push({ pid, processName, port })
    }
  }
  return listeners
}

export function parseCsrfToken(commandLine: string): string | null {
  return commandLine.match(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/)?.[1] ?? null
}

async function discoverLogEndpoints(): Promise<AgyQuotaEndpoint[]> {
  try {
    const names = (await readdir(AGY_LOG_DIR))
      .filter((name) => /^cli-\d{8}_\d{6}\.log$/.test(name))
      .sort()
      .toReversed()
      .slice(0, 8)
    const endpoints: AgyQuotaEndpoint[] = []
    for (const name of names) {
      const endpoint = parseAgyLogEndpoint(await readFilePrefix(path.join(AGY_LOG_DIR, name)))
      if (endpoint && isProcessAlive(endpoint.pid)) {
        endpoints.push(endpoint)
      }
    }
    return endpoints
  } catch {
    return []
  }
}

async function discoverLsofEndpoints(): Promise<AgyQuotaEndpoint[]> {
  if (process.platform === 'win32') {
    return []
  }
  try {
    const listeners = parseLsofListeners(
      await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    ).filter(({ processName }) => /^(agy|language_?(?:server)?)$/i.test(processName))
    const commandLines = new Map<number, string>()
    for (const pid of new Set(listeners.map((listener) => listener.pid))) {
      commandLines.set(pid, await runCommand('ps', ['-p', String(pid), '-o', 'command=']))
    }
    return listeners.flatMap<AgyQuotaEndpoint>(({ pid, processName, port }) => {
      const commandLine = commandLines.get(pid) ?? ''
      if (/^agy$/i.test(processName)) {
        return [{ pid, port, csrfToken: null }]
      }
      if (
        !commandLine.includes('language_server') ||
        !commandLine.toLowerCase().includes('antigravity')
      ) {
        return []
      }
      const csrfToken = parseCsrfToken(commandLine)
      return csrfToken ? [{ pid, port, csrfToken }] : []
    })
  } catch {
    return []
  }
}

export async function discoverAgyQuotaEndpoints(): Promise<AgyQuotaEndpoint[]> {
  const endpoints = [...(await discoverLogEndpoints()), ...(await discoverLsofEndpoints())]
  const seen = new Set<string>()
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.pid}:${endpoint.port}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function isSummaryBucket(value: unknown): value is AgySummaryBucket {
  if (!value || typeof value !== 'object') {
    return false
  }
  const bucket = value as AgySummaryBucket
  return (
    typeof bucket.window === 'string' &&
    typeof bucket.remainingFraction === 'number' &&
    Number.isFinite(bucket.remainingFraction) &&
    typeof bucket.resetTime === 'string'
  )
}

function toWindow(bucket: AgySummaryBucket, windowMinutes: number): RateLimitWindow {
  const remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction as number))
  const resetsAt = Date.parse(bucket.resetTime as string)
  return {
    usedPercent: (1 - remainingFraction) * 100,
    windowMinutes,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: null
  }
}

export function parseAgyQuotaSummary(
  data: unknown
): { session: RateLimitWindow; weekly: RateLimitWindow } | null {
  const groups = (data as AgySummaryResponse | null)?.response?.groups
  if (!Array.isArray(groups)) {
    return null
  }
  const geminiGroup = groups.find((group): group is AgySummaryGroup => {
    if (!group || typeof group !== 'object') {
      return false
    }
    const candidate = group as AgySummaryGroup
    return (
      candidate.displayName === 'Gemini Models' ||
      (Array.isArray(candidate.buckets) &&
        candidate.buckets.some((bucket) => {
          const bucketId =
            bucket && typeof bucket === 'object' ? (bucket as AgySummaryBucket).bucketId : null
          return typeof bucketId === 'string' && bucketId.startsWith('gemini-')
        }))
    )
  })
  if (!geminiGroup || !Array.isArray(geminiGroup.buckets)) {
    return null
  }
  const buckets = geminiGroup.buckets.filter(isSummaryBucket)
  const fiveHour = buckets.find((bucket) => bucket.window === '5h')
  const weekly = buckets.find((bucket) => bucket.window === 'weekly')
  if (!fiveHour || !weekly) {
    return null
  }
  return {
    session: toWindow(fiveHour, 300),
    weekly: toWindow(weekly, 10_080)
  }
}

async function fetchSummary(endpoint: AgyQuotaEndpoint): Promise<unknown> {
  const response = await net.fetch(`http://127.0.0.1:${endpoint.port}${SUMMARY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.csrfToken ? { 'x-codeium-csrf-token': endpoint.csrfToken } : {})
    },
    body: '{}',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  return response.ok ? await response.json() : null
}

export async function fetchAntigravityRateLimits(
  discoverEndpoints: () => Promise<AgyQuotaEndpoint[]> = discoverAgyQuotaEndpoints
): Promise<ProviderRateLimits> {
  try {
    const endpoints = await discoverEndpoints()
    if (endpoints.length === 0) {
      return result('unavailable', 'Agy local usage service is not running')
    }
    for (const endpoint of endpoints) {
      try {
        const windows = parseAgyQuotaSummary(await fetchSummary(endpoint))
        if (windows) {
          return result('ok', null, windows)
        }
      } catch {
        // Agy exposes adjacent HTTPS and HTTP listeners; only the HTTP endpoint answers here.
      }
    }
    return result('error', 'Agy model quota summary is unavailable')
  } catch (error) {
    return result('error', error instanceof Error ? error.message : 'Unknown Agy usage error')
  }
}
