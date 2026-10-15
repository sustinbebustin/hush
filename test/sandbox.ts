import { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Kind } from "../src/shared/Kind.js"
import type { LeakTarget, Observed } from "./leaks.js"
import { type Proxy, start as startProxy } from "./proxy.js"

// The test seam: the real CLI as a subprocess against a real Server subprocess.
// The CLI gets a temporary HOME and a PATH whose only entry holds `sh`, `cat` and any fake a test adds with
// `tool`, so no test can reach a real Server, clipboard or tool. No production code has a test hook.

export const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim()

const repository = join(import.meta.dirname, "..")
const runTimeoutMs = 15_000
const startTimeoutMs = 15_000

// One line of the Server's request log.
export interface Call {
  readonly method: string
  readonly path: string
  readonly status: number
}

export interface Result {
  readonly code: number
  readonly stdout: string
  // stdout as bytes, for output that is not text (`server backup -`).
  readonly stdoutBytes: Buffer
  readonly stderr: string
}

// Whether `tty` runs work here: they need util-linux `script`, and macOS ships BSD `script`, whose flags differ.
export const onPty = process.platform === "linux"

// Whether Server behaviour is under test here: a macOS Server is unsupported (README), and there its
// `VACUUM INTO`, bind error codes and files under HOME differ.
export const serverSupported = process.platform === "linux"

// One step of typing at a pty: wait until `after` appears in the output (past the previous step's match), then
// send `keys`. Waiting for each prompt keeps keys from reaching the pty before raw mode, when it would echo them.
export interface Keystrokes {
  readonly after: string
  readonly keys: string
}

// A run on a pty from util-linux `script -qec` (Linux only, so these tests skip elsewhere). stdin,
// stdout and stderr are the pty: `stdout` holds everything it showed, prompts and stderr included, with `\r\n`
// line ends, and `stderr` holds only `script`'s own.
export interface Tty {
  readonly keys: ReadonlyArray<Keystrokes>
  // Runs `stty -a` on the pty after the CLI exits, so the output shows the terminal mode it left.
  readonly sttyAfter?: boolean
}

export type RunOptions = {
  readonly env?: Record<string, string>
  // stdout is where a secret belongs (`read`, a `--print` receipt), so the leak scan leaves it out.
  readonly secretStdout?: boolean
} & (
  | { readonly input?: string | Uint8Array; readonly tty?: undefined }
  | { readonly tty: Tty; readonly input?: undefined }
)

// What `seed` creates through the CLI: Init with a first Vault and a saved Token, then each Item by `create`.
export interface Seed {
  readonly vault?: string
  readonly label?: string
  readonly items?: ReadonlyArray<{
    readonly kind: Kind
    readonly title: string
    // The primary Field's value, piped to `create --stdin`.
    readonly value: string
    // Plain Fields by label, passed as `--<label>` flags.
    readonly plain?: Readonly<Record<string, string>>
  }>
}

export interface Seeded {
  readonly vault: string
  readonly label: string
  // The saved Token, for `HUSH_TOKEN` runs and as a leak sentinel.
  readonly token: string
  // The receipt `ref` of each Item, in order.
  readonly references: ReadonlyArray<string>
}

// The Passphrase `seed` initialises with: the leak scan's Passphrase sentinel.
export const seedPassphrase = "fictional passphrase sentinel 7Qx"

// The CLI half of the seam, for tests that need no Server.
export interface Cli {
  // Temporary HOME of every CLI run.
  readonly home: string
  readonly run: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<Result>
  // `sh -c <script>` spawned exactly as `run` spawns the CLI, for the harness self-tests.
  readonly shell: (script: string) => Promise<Result>
  // Puts a fake tool on the CLI's PATH, such as `pbpaste`: an executable `sh` script.
  readonly tool: (name: string, script: string) => Promise<void>
  readonly close: () => Promise<void>
}

// One entry of the startup line's `addresses`, in bind order.
export interface Address {
  readonly ip: string
  readonly port: number
}

export interface SandboxOptions {
  // Extra `hush server` arguments, e.g. `--listen`.
  readonly serverArgs?: ReadonlyArray<string>
  // `0` starts the Server with `--port 0`, for a test of what the OS picks; a restart may then find the port taken.
  readonly port?: 0
}

export interface Sandbox {
  readonly home: string
  // Where tests write backups: every file in it is scanned as `database`, as snapshots in the state dir are.
  readonly backupDir: string
  readonly server: {
    // The loopback listener's origin.
    readonly url: string
    // Every listener of the current Server process, from its startup line.
    readonly addresses: () => ReadonlyArray<Address>
    readonly stateDir: string
    readonly initCode: () => Promise<string | undefined>
    // Starts the Server again on the same port, so `url` and every origin-keyed Token stay valid.
    readonly restart: () => Promise<void>
    readonly stop: () => Promise<void>
    // Everything the Server has written to stdout and stderr, across restarts.
    readonly output: () => string
  }
  // `calls` holds the Server requests made during this run.
  readonly run: (
    args: ReadonlyArray<string>,
    options?: RunOptions,
  ) => Promise<Result & { readonly calls: ReadonlyArray<Call> }>
  // The whole request log so far.
  readonly calls: () => Promise<ReadonlyArray<Call>>
  readonly tool: Cli["tool"]
  // Init, a first Vault, its saved Token and Items through the CLI with `--passphrase-stdin`. More Vaults
  // come from `vault create`, more Tokens from `token issue`.
  readonly seed: (spec?: Seed) => Promise<Seeded>
  // Raw HTTP to the Server, for guard, gate, limit and backoff tests.
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  // The loopback test proxy (test/proxy.ts) in front of the Server, for fault injection: pass `proxy.url` as
  // `HUSH_SERVER` (with `HUSH_TOKEN`, since saved Tokens are keyed by origin).
  readonly proxy: Proxy
  readonly observable: (targets?: ReadonlyArray<LeakTarget>) => Promise<ReadonlyArray<Observed>>
  // A second connection to the Server's database, closed before `f`'s result is returned: an open reader
  // makes the Server's `wal_checkpoint(TRUNCATE)` report busy.
  readonly inspect: <A>(f: (db: Database) => A) => Promise<A>
  readonly close: () => Promise<void>
}

// The absolute path of a host tool, for the pty wrapper; the CLI's own PATH cannot find it.
const hostTool = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()

const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`

// `command` under `script -qec`, which gives it a pty as its controlling terminal and exits with its status.
const underScript = (command: ReadonlyArray<string>, tty: Tty): readonly [string, ...Array<string>] => {
  const line = command.map(shellQuote).join(" ")
  const script = tty.sttyAfter === true ? `${line}; code=$?; ${shellQuote(hostTool("stty"))} -a; exit $code` : line

  return [hostTool("script"), "-qec", script, "/dev/null"]
}

const spawnDetached = ({
  home,
  bin,
  command,
  options,
}: {
  readonly home: string
  readonly bin: string
  readonly command: readonly [string, ...Array<string>]
  readonly options: RunOptions
}): Promise<Result> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = options.tty === undefined ? command : underScript(command, options.tty)
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: bin }

    // `script` runs its command with `$SHELL`, else the login shell; the sandbox's `sh` keeps it portable.
    if (options.tty !== undefined) env.SHELL = join(bin, "sh")

    // A new session (detached) has no controlling terminal, so `/dev/tty` fails as it does in CI.
    const child = spawn(file, args, {
      cwd: repository,
      env: { ...env, ...options.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    // Keystrokes not yet sent, and where in stdout the next one's prompt is looked for.
    let pending = options.tty?.keys ?? []
    let searchFrom = 0

    const type = () => {
      let step = pending[0]

      while (step !== undefined) {
        const found = stdout.indexOf(step.after, searchFrom)

        if (found === -1) return
        searchFrom = found + step.after.length
        child.stdin.write(step.keys)
        pending = pending.slice(1)
        step = pending[0]
      }
    }

    const chunks: Array<Buffer> = []
    const decoder = new TextDecoder()
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      stdout += decoder.decode(chunk, { stream: true })
      type()
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))

    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      reject(new Error(`${command.join(" ")} timed out after ${runTimeoutMs} ms\nstdout: ${stdout}`))
    }, runTimeoutMs)

    child.on("error", reject)
    child.on("close", (code, signal) => {
      clearTimeout(timer)

      if (code === null) reject(new Error(`${command.join(" ")} was killed by ${signal}`))
      else if (pending.length > 0) reject(new Error(`exited before the prompt ${pending[0]?.after}\nstdout: ${stdout}`))
      else resolve({ code, stdout: stdout + decoder.decode(), stdoutBytes: Buffer.concat(chunks), stderr })
    })
    child.stdin.on("error", () => {}) // the CLI may exit before reading input

    // On a pty, stdin stays open until the CLI exits: `script` would pass its end on as an end of input.
    if (options.tty === undefined) child.stdin.end(options.input ?? "")
    else child.on("exit", () => child.stdin.end())
  })

const makeCli = async (): Promise<Cli & { readonly root: string; readonly bin: string }> => {
  const root = await mkdtemp(join(tmpdir(), "hush-test-"))
  const home = join(root, "home")
  const bin = join(root, "bin")
  await mkdir(home)
  await mkdir(bin)

  for (const command of ["sh", "cat"]) await symlink(`/bin/${command}`, join(bin, command))

  return {
    root,
    bin,
    home,
    run: (args, options = {}) => spawnDetached({ home, bin, command: [bun, "run", "bin/hush", ...args], options }),
    shell: (script) => spawnDetached({ home, bin, command: [join(bin, "sh"), "-c", script], options: {} }),
    tool: (name, script) => writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 }),
    close: () => rm(root, { recursive: true, force: true }),
  }
}

export const cli = async (): Promise<Cli> => {
  const { home, run, shell, tool, close } = await makeCli()

  return { home, run, shell, tool, close }
}

// Harness sync requests are left out of the call record.
const syncPrefix = "/__harness-sync/"

const RequestLine = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literal("request"),
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
  }),
)

// Every stderr line that is a request-log entry; other log lines and stray output are skipped.
const parseCalls = (stderr: string): ReadonlyArray<Call> =>
  stderr.split("\n").flatMap((line) =>
    Option.match(Schema.decodeUnknownOption(RequestLine)(line), {
      onNone: () => [],
      onSome: ({ method, path, status }) => [{ method, path, status }],
    }),
  )

const StartupLine = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literal("listening"),
    addresses: Schema.NonEmptyArray(Schema.Struct({ ip: Schema.String, port: Schema.Number })),
  }),
)

interface RunningServer {
  readonly child: ChildProcess
  // The first is 127.0.0.1 unless a wildcard replaced it.
  readonly addresses: readonly [Address, ...Array<Address>]
  readonly stderr: () => string
  readonly exited: Promise<void>
}

// Starts `hush server` and resolves once its startup line names the addresses. Any other outcome rejects loudly,
// including a `ListenAddressInUse` line on restart: the harness never picks another port,
// since saved Tokens are keyed by origin and must still apply after a restart.
const startServer = ({
  stateDir,
  home,
  port,
  args,
  record,
}: {
  readonly stateDir: string
  readonly home: string
  readonly port: number
  readonly args: ReadonlyArray<string>
  // Receives everything the Server writes to stdout and stderr.
  readonly record: (chunk: string) => void
}): Promise<RunningServer> =>
  new Promise((resolve, reject) => {
    const command = ["run", "bin/hush", "server", "--state-dir", stateDir, "--port", String(port), ...args]

    const child = spawn(bun, command, {
      cwd: repository,
      env: { HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let started = false
    const exited = new Promise<void>((done) => child.on("close", () => done()))

    const fail = (reason: string) => {
      if (started) return
      started = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      reject(new Error(`hush server did not start: ${reason}\nstdout: ${stdout}\nstderr: ${stderr}`))
    }

    const timer = setTimeout(() => fail(`no startup line within ${startTimeoutMs} ms`), startTimeoutMs)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
      record(chunk)
    })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
      record(chunk)

      if (started || !stdout.includes("\n")) return
      const line = Schema.decodeUnknownOption(StartupLine)(stdout.slice(0, stdout.indexOf("\n")))

      if (Option.isNone(line)) return fail("the first stdout line is not a startup line")
      started = true
      clearTimeout(timer)
      resolve({ child, addresses: line.value.addresses, stderr: () => stderr, exited })
    })
    child.on("close", (code) => fail(`exited with ${code}`))
  })

// Sandbox ports come from below the OS ephemeral ranges (Linux 32768-60999, macOS 49152-65535), in a block of their
// own per vitest worker. A port freed by `restart` is then not handed to another process's outgoing connection or
// `--port 0` listener before this Server binds it again.
const firstPort = 20_000
const portBlock = 256
const portBlocks = Math.floor((32_768 - firstPort) / portBlock)
const poolId = Number(process.env.VITEST_POOL_ID)
const blockStart = firstPort + ((Number.isInteger(poolId) ? poolId : 0) % portBlocks) * portBlock

// A random start in the block keeps two suites running at once (agent worktrees) apart most of the time.
let portsUsed = Math.floor(Math.random() * portBlock)

// The first start: the next port of this worker's block, skipping any another process already holds.
const startOnFreePort = async (start: (port: number) => Promise<RunningServer>): Promise<RunningServer> => {
  for (let attempt = 1; ; attempt += 1) {
    const port = blockStart + (portsUsed % portBlock)
    portsUsed += 1

    try {
      return await start(port)
    } catch (error) {
      if (attempt >= portBlock || !(error instanceof Error) || !error.message.includes("is already in use")) throw error
    }
  }
}

// The file's text, or nothing when it does not exist.
const fileText = async (path: string): Promise<ReadonlyArray<string>> =>
  readFile(path, "utf8").then(
    (text) => [text],
    () => [],
  )

export const sandbox = async ({ serverArgs = [], port: requestedPort }: SandboxOptions = {}): Promise<Sandbox> => {
  const base = await makeCli()
  const stateDir = join(base.root, "state")
  const serverHome = join(base.root, "server-home")
  const backupDir = join(base.root, "backups")
  await mkdir(serverHome)
  await mkdir(backupDir)
  let output = ""

  const record = (chunk: string) => {
    output += chunk
  }

  // Request logs of earlier Server processes, so `calls()` spans restarts.
  let previousStderr = ""
  const start = (port: number) => startServer({ stateDir, home: serverHome, port, args: serverArgs, record })
  let server: RunningServer | undefined = await (requestedPort === undefined ? startOnFreePort(start) : start(0))
  let addresses = server.addresses
  const port = addresses[0].port
  const url = `http://127.0.0.1:${port}`
  let syncs = 0
  const cliOutput: Array<string> = []
  // The stdout of every `hush audit` run: the Audit Log as its reader shows it.
  const auditOutput: Array<string> = []

  const stop = async () => {
    if (server === undefined) return
    const stopping = server
    server = undefined
    stopping.child.kill("SIGTERM")
    await stopping.exited
    previousStderr += stopping.stderr()
  }

  // Every request the CLI made is logged once its response is sent; a sync request answered after the CLI
  // exits proves those lines have reached the log.
  const settledCalls = async (): Promise<ReadonlyArray<Call>> => {
    const running = server

    if (running === undefined) return parseCalls(previousStderr)
    const marker = `${syncPrefix}${(syncs += 1)}`
    await fetch(`${url}${marker}`).then((response) => response.body?.cancel())

    while (!running.stderr().includes(`"path":"${marker}"`)) await new Promise((wait) => setTimeout(wait, 5))

    return parseCalls(previousStderr + running.stderr()).filter(({ path }) => !path.startsWith(syncPrefix))
  }

  const observe = async (target: LeakTarget): Promise<ReadonlyArray<Observed>> => {
    switch (target) {
      case "cli":
        return [{ target, text: cliOutput.join("\n") }]
      case "server":
        return [{ target, text: output }]
      case "config":
        return (await fileText(join(base.home, ".config", "hush", "config.json"))).map((text) => ({ target, text }))
      case "tokenFile":
        return (await fileText(join(base.home, ".config", "hush", "tokens.json"))).map((text) => ({ target, text }))
      case "database": {
        // Raw bytes decoded as UTF-8: decoding is self-synchronising, so a sentinel's bytes survive intact.
        const files = [
          ...(await readdir(stateDir))
            .filter((name) => name.startsWith("hush.db") || (name.startsWith("backup-") && name.endsWith(".db")))
            .map((name) => join(stateDir, name)),
          ...(await readdir(backupDir)).map((name) => join(backupDir, name)),
        ]

        return Promise.all(files.map(async (path) => ({ target, text: await readFile(path, "utf8") })))
      }

      case "proxy":
        return [{ target, text: proxy.log().join("\n") }]
      case "audit":
        return auditOutput.map((text) => ({ target, text }))
    }
  }

  const run = async (args: ReadonlyArray<string>, options: RunOptions = {}) => {
    const before = (await settledCalls()).length
    const result = await base.run(args, { ...options, env: { HUSH_SERVER: url, ...options.env } })
    cliOutput.push(options.secretStdout === true ? "" : result.stdout, result.stderr)

    if (args[0] === "audit") auditOutput.push(result.stdout)

    return { ...result, calls: (await settledCalls()).slice(before) }
  }

  // Each step must succeed: a seed that fails is a broken test setup, reported with the CLI's own message.
  const step = async (args: ReadonlyArray<string>, input: string) => {
    const result = await run(args, { input })

    if (result.code !== 0) throw new Error(`seed: hush ${args.join(" ")} failed: ${result.stderr}`)

    return result
  }

  const seed = async ({ vault = "Personal", label = "agent on box", items = [] }: Seed = {}): Promise<Seeded> => {
    const code = (await fileText(join(stateDir, "init-code")))[0]

    if (code === undefined) throw new Error("seed: the Server is not Uninitialised (no init-code file)")
    await step(["init", "--vault", vault, "--label", label, "--passphrase-stdin"], `${code}\n${seedPassphrase}\n`)
    const saved: unknown = JSON.parse((await fileText(join(base.home, ".config", "hush", "tokens.json")))[0] ?? "")

    const token = Schema.decodeUnknownSync(
      Schema.Struct({ tokens: Schema.Tuple([Schema.Struct({ server: Schema.Literal(url), token: Schema.String })]) }),
    )(saved).tokens[0].token

    const references: Array<string> = []

    for (const item of items) {
      const plain = Object.entries(item.plain ?? {}).flatMap(([name, text]) => [`--${name}`, text])

      const created = await step(
        ["create", item.kind, "--title", item.title, "--vault", vault, "--stdin", ...plain],
        `${item.value}\n`,
      )

      references.push(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ref: Schema.String })))(created.stdout).ref,
      )
    }

    return { vault, label, token, references }
  }

  const proxy = await startProxy(url)

  return {
    home: base.home,
    backupDir,
    server: {
      url,
      addresses: () => addresses,
      stateDir,
      initCode: async () => (await fileText(join(stateDir, "init-code")))[0],
      restart: async () => {
        await stop()
        server = await start(port)
        addresses = server.addresses
      },
      stop,
      output: () => output,
    },
    run,
    calls: settledCalls,
    tool: base.tool,
    seed,
    fetch: (path, init) => fetch(`${url}${path}`, init),
    proxy,
    observable: async (targets = ["cli", "server", "proxy", "audit", "config", "database", "tokenFile"]) =>
      (await Promise.all(targets.map(observe))).flat(),
    inspect: async (f) => {
      const db = new Database(join(stateDir, "hush.db"))

      try {
        return f(db)
      } finally {
        db.close()
      }
    },
    close: async () => {
      await proxy.close()
      await stop()
      await base.close()
    },
  }
}
