#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const INTERNAL_ENV = 'ORCA_COMPUTER_HELPER_OWNER_BENCH_INTERNAL'
const EXPECTATION_ENV = 'ORCA_COMPUTER_HELPER_OWNER_BENCH_EXPECTATION'
const RESULT_PREFIX = 'ORCA_COMPUTER_HELPER_OWNER_BENCH_RESULT='
const DEFAULT_TRIALS = 3
const OWNER_HOLD_MS = 31_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const RETAIN_PROOF_MS = 3_000
const SAMPLE_COUNT = 5
const SAMPLE_INTERVAL_MS = 200
const MIB = 1024 * 1024
const scriptPath = import.meta.filename
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const sidecarPath = path.join(repoRoot, 'out', 'main', 'computer-sidecar.js')
const helperAppPath = path.join(
  repoRoot,
  'native',
  'computer-use-macos',
  '.build',
  'release',
  'Orca Computer Use.app'
)
const helperPath = path.join(helperAppPath, 'Contents', 'MacOS', 'orca-computer-use-macos')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function parseCpuTimeSeconds(value) {
  const [dayOrTime, clock] = value.includes('-') ? value.split('-', 2) : [null, value]
  const days = dayOrTime === null ? 0 : Number(dayOrTime)
  const parts = clock.split(':').map(Number)
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid process CPU time: ${value}`)
  }
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

function processSnapshot(pid) {
  const raw = execFileSync(
    'ps',
    ['-o', 'rss=', '-o', 'time=', '-o', 'command=', '-p', String(pid)],
    { encoding: 'utf8' }
  ).trim()
  const match = raw.match(/^(\d+)\s+(\S+)\s+(.+)$/)
  if (!match) {
    throw new Error(`Could not inspect process ${pid}: ${raw}`)
  }
  return {
    pid,
    rssBytes: Number(match[1]) * 1024,
    cpuTimeSeconds: parseCpuTimeSeconds(match[2]),
    command: match[3]
  }
}

async function sampleProcess(pid) {
  const samples = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(processSnapshot(pid))
    await sleep(SAMPLE_INTERVAL_MS)
  }
  return {
    rssBytes: median(samples.map((sample) => sample.rssBytes)),
    cpuTimeSeconds: samples.at(-1).cpuTimeSeconds,
    command: samples.at(-1).command
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return performance.now() - startedAt
    }
    await sleep(50)
  }
  return null
}

async function stopProcess(pid) {
  if (!pid || !isProcessAlive(pid)) {
    return
  }
  process.kill(pid, 'SIGTERM')
  if ((await waitForProcessExit(pid, 2_000)) !== null) {
    return
  }
  process.kill(pid, 'SIGKILL')
  await waitForProcessExit(pid, 2_000)
}

function startSidecar() {
  const child = fork(sidecarPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_COMPUTER_SIDECAR: '1',
      ORCA_COMPUTER_MACOS_HELPER_APP_PATH: helperAppPath
    }
  })
  const errors = []
  child.stderr?.on('data', (chunk) => errors.push(String(chunk)))
  return { child, errors }
}

function requestSidecar(sidecar, id, method) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Sidecar ${method} request timed out: ${sidecar.errors.join('')}`))
    }, 10_000)
    const onMessage = (message) => {
      if (message?.id !== id) {
        return
      }
      cleanup()
      if (message.ok) {
        resolve(message.result)
      } else {
        reject(new Error(`Sidecar ${method} failed: ${JSON.stringify(message.error)}`))
      }
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(
        new Error(
          `Sidecar exited during ${method}: ${JSON.stringify({ code, signal, stderr: sidecar.errors.join('') })}`
        )
      )
    }
    const cleanup = () => {
      clearTimeout(timeout)
      sidecar.child.off('message', onMessage)
      sidecar.child.off('exit', onExit)
    }
    sidecar.child.on('message', onMessage)
    sidecar.child.once('exit', onExit)
    sidecar.child.send({ id, method, params: {} })
  })
}

async function waitForHelper(sidecarPid) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    })
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (
        match &&
        Number(match[2]) === sidecarPid &&
        match[3].includes(helperPath) &&
        match[3].includes(' --agent ')
      ) {
        return { pid: Number(match[1]), command: match[3] }
      }
    }
    await sleep(50)
  }
  throw new Error(`Could not find helper owned by sidecar ${sidecarPid}`)
}

function socketPathFromCommand(command) {
  const match = command.match(/ --agent (.+?) --token-file /)
  if (!match) {
    throw new Error(`Could not read helper socket path from command: ${command}`)
  }
  return match[1]
}

function connectInvalidPeer(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Invalid-peer connection timed out'))
    }, 5_000)
    let buffer = ''
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('error', onError)
      socket.off('data', onData)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onData = (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        return
      }
      cleanup()
      const response = JSON.parse(buffer.slice(0, newline))
      if (response.ok !== false || response.error?.code !== 'permission_denied') {
        socket.destroy()
        reject(new Error(`Invalid peer was not rejected: ${JSON.stringify(response)}`))
        return
      }
      resolve(socket)
    }
    socket.setEncoding('utf8')
    socket.on('error', onError)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ id: 991, method: 'handshake', params: {}, token: 'invalid' })}\n`
      )
    })
  })
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false)
  ])
}

async function startAuthenticatedSession() {
  const sidecar = startSidecar()
  const capabilities = await requestSidecar(sidecar, 1, 'capabilities')
  if (capabilities?.protocolVersion !== 1) {
    throw new Error(`Unexpected helper handshake: ${JSON.stringify(capabilities)}`)
  }
  const helper = await waitForHelper(sidecar.child.pid)
  return { sidecar, helper }
}

async function verifyGracefulClose() {
  const { sidecar, helper } = await startAuthenticatedSession()
  try {
    const startedAt = performance.now()
    sidecar.child.disconnect()
    if (!(await waitForChildExit(sidecar.child, PROCESS_EXIT_TIMEOUT_MS))) {
      throw new Error('Sidecar did not exit after graceful IPC close')
    }
    const helperExitMs = await waitForProcessExit(helper.pid, PROCESS_EXIT_TIMEOUT_MS)
    if (helperExitMs === null) {
      throw new Error('Helper did not exit after graceful owner close')
    }
    return Math.round(performance.now() - startedAt)
  } finally {
    sidecar.child.kill('SIGKILL')
    await stopProcess(helper.pid)
  }
}

async function runInternalTrial(expectation) {
  const { app } = await import('electron')
  await app.whenReady()
  let sidecar
  let helper
  let invalidPeer
  try {
    const session = await startAuthenticatedSession()
    sidecar = session.sidecar
    helper = session.helper
    const authenticatedAt = performance.now()
    const initial = await sampleProcess(helper.pid)
    const remainingHoldMs = Math.max(0, OWNER_HOLD_MS - (performance.now() - authenticatedAt))
    await sleep(remainingHoldMs)
    const connected = await sampleProcess(helper.pid)
    const invalidSocketPath = socketPathFromCommand(helper.command)
    invalidPeer = await connectInvalidPeer(invalidSocketPath)
    const survivedClaimDeadline = performance.now() - authenticatedAt >= OWNER_HOLD_MS

    sidecar.child.kill('SIGKILL')
    await waitForChildExit(sidecar.child, PROCESS_EXIT_TIMEOUT_MS)
    const abruptExitMs = await waitForProcessExit(
      helper.pid,
      expectation === 'reaped' ? PROCESS_EXIT_TIMEOUT_MS : RETAIN_PROOF_MS
    )
    const helperExitedAfterAbruptLoss = abruptExitMs !== null
    if (expectation === 'reaped' && !helperExitedAfterAbruptLoss) {
      throw new Error('Expected helper to exit after abrupt authenticated owner loss')
    }
    if (expectation === 'retained' && helperExitedAfterAbruptLoss) {
      throw new Error('Expected baseline helper to remain after abrupt owner loss')
    }
    const postLossRssBytes = helperExitedAfterAbruptLoss ? 0 : processSnapshot(helper.pid).rssBytes
    await stopProcess(helper.pid)
    helper = null
    invalidPeer.destroy()
    invalidPeer = null

    const gracefulExitMs = await verifyGracefulClose()
    return {
      authenticated: true,
      survivedClaimDeadline,
      invalidPeerRejectedAndDidNotRetain: expectation === 'reaped',
      connectedRssBytes: connected.rssBytes,
      connectedCpuMilliseconds: Math.max(
        0,
        Math.round((connected.cpuTimeSeconds - initial.cpuTimeSeconds) * 1_000)
      ),
      cpuSampleMs: Math.round(performance.now() - authenticatedAt),
      helperExitedAfterAbruptLoss,
      abruptExitMs: abruptExitMs === null ? null : Math.round(abruptExitMs),
      postLossRssBytes,
      gracefulExitMs
    }
  } finally {
    invalidPeer?.destroy()
    sidecar?.child.kill('SIGKILL')
    await stopProcess(helper?.pid)
    app.quit()
  }
}

function parseArgs(argv) {
  const options = { expect: '', trials: DEFAULT_TRIALS, output: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--expect' || arg === '--trials' || arg === '--output') {
      if (!value) {
        throw new Error(`Missing value for ${arg}`)
      }
      options[arg.slice(2)] = arg === '--trials' ? Number(value) : value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!['retained', 'reaped'].includes(options.expect)) {
    throw new Error('--expect must be retained or reaped')
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error('--trials must be a positive integer')
  }
  return options
}

function electronPath() {
  const electronModulePath = fileURLToPath(import.meta.resolve('electron'))
  return execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(electronModulePath)}))`],
    { encoding: 'utf8' }
  )
}

function buildArtifacts() {
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  execFileSync('pnpm', ['build:computer-macos'], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
}

function artifactSha256(artifactPath) {
  return createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
}

function runTrial(executable, expectation) {
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'orca-helper-owner-bench-launcher-'))
  writeFileSync(
    path.join(launcherDir, 'package.json'),
    JSON.stringify({ name: 'orca-helper-owner-benchmark', main: 'main.cjs' })
  )
  writeFileSync(
    path.join(launcherDir, 'main.cjs'),
    `import(${JSON.stringify(pathToFileURL(scriptPath).href)}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})\n`
  )
  let result
  try {
    const env = {
      ...process.env,
      [INTERNAL_ENV]: '1',
      [EXPECTATION_ENV]: expectation
    }
    delete env.ELECTRON_RUN_AS_NODE
    result = spawnSync(executable, [launcherDir], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 60_000
    })
  } finally {
    rmSync(launcherDir, { recursive: true, force: true })
  }
  if (result.status !== 0) {
    throw new Error(
      `Electron trial failed (${result.error?.message ?? result.signal ?? result.status}):\n` +
        `${result.stderr || result.stdout}`
    )
  }
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(RESULT_PREFIX))
  if (!line) {
    throw new Error(`Electron trial did not report a result:\n${result.stdout}`)
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length))
}

function runBenchmark() {
  if (process.platform !== 'darwin') {
    throw new Error('The computer-use helper owner benchmark is macOS-only')
  }
  const options = parseArgs(process.argv.slice(2))
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  if (dirty) {
    throw new Error('Commit or stash changes before running the provenance-bound benchmark')
  }
  buildArtifacts()
  if (!existsSync(sidecarPath) || !existsSync(helperPath)) {
    throw new Error('Fresh production sidecar/helper build did not produce the expected artifacts')
  }
  const executable = electronPath()
  const results = Array.from({ length: options.trials }, () => runTrial(executable, options.expect))
  const rssBytes = results.map((result) => result.connectedRssBytes)
  const cpuMilliseconds = results.map((result) => result.connectedCpuMilliseconds)
  const postLossRssBytes = results.map((result) => result.postLossRssBytes)
  const report = {
    benchmark: 'macos-computer-helper-authenticated-owner-loss',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim(),
    artifacts: {
      sidecarSha256: artifactSha256(sidecarPath),
      helperSha256: artifactSha256(helperPath)
    },
    expectation: options.expect,
    trials: options.trials,
    ownerHoldMs: OWNER_HOLD_MS,
    authenticated: results.every((result) => result.authenticated),
    survivedClaimDeadline: results.every((result) => result.survivedClaimDeadline),
    invalidPeerRejectedAndDidNotRetain: results.every(
      (result) => result.invalidPeerRejectedAndDidNotRetain
    ),
    connectedRssMiB: rssBytes.map((value) => Number((value / MIB).toFixed(2))),
    medianConnectedRssMiB: Number((median(rssBytes) / MIB).toFixed(2)),
    connectedCpuMilliseconds: cpuMilliseconds,
    medianConnectedCpuMilliseconds: median(cpuMilliseconds),
    helperExitedAfterAbruptLoss: results.map((result) => result.helperExitedAfterAbruptLoss),
    abruptExitMs: results.map((result) => result.abruptExitMs),
    postLossRssMiB: postLossRssBytes.map((value) => Number((value / MIB).toFixed(2))),
    medianPostLossRssMiB: Number((median(postLossRssBytes) / MIB).toFixed(2)),
    gracefulExitMs: results.map((result) => result.gracefulExitMs)
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(serialized)
  if (options.output) {
    writeFileSync(path.resolve(options.output), serialized)
  }
}

if (process.env[INTERNAL_ENV] === '1') {
  const result = await runInternalTrial(process.env[EXPECTATION_ENV])
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
} else {
  runBenchmark()
}
