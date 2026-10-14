import { Result, Schema } from "effect"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { Listen } from "../src/server/Listen.js"
import { PlatformCause } from "../src/shared/PlatformCause.js"

// Manual check that hush works inside Claude Code's sandbox; never run by CI. The Owner runs it by hand before a
// release.
//
//   bun test/sandbox-spike.ts setup [--tailnet <ip>] [--binary <path>]
//     Outside any sandbox. Builds the compiled binary for this host unless `--binary` names one, starts a
//     throwaway Server on 127.0.0.1 (and, with `--tailnet`, a second one also listening on that tailnet address),
//     Inits each with a `Spike` Vault and one seed Item, and prints the Claude Code settings to apply by hand. It
//     changes no settings, writes nothing outside a temporary directory, and never passes `--allow-any-listen`.
//     Ctrl-C stops the Servers and deletes their state.
//
//   bun test/sandbox-spike.ts check [--binary <path>]
//     Inside Claude Code's sandbox, as a sandboxed Bash command, with HUSH_SERVER and HUSH_TOKEN from the settings
//     `env`. Runs `doctor`, `find`, `run` and `create --stdin` once under `bun run` and once with the compiled
//     binary, checks that the token file is denied, and reports whether HUSH_PROXY reached the command. Prints PASS,
//     FAIL or INFO per check with its evidence; exits 1 if any check failed.

const repository = join(import.meta.dirname, "..")
const commandTimeoutMs = 30_000
const startTimeoutMs = 15_000
const vault = "Spike"
const seed = { title: "Seed", value: "hush-spike-seed-value" } as const
const tokenFile = join(homedir(), ".config", "hush", "tokens.json")

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const exec = (command: ReadonlyArray<string>, env: Readonly<Record<string, string>>, input?: string) =>
  new Promise<Ran>((resolve, reject) => {
    const [file = "", ...args] = command
    const child = spawn(file, args, { env: { ...process.env, ...env }, cwd: repository, timeout: commandTimeoutMs })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input ?? "")
  })

const flag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const hostTarget = (): string | undefined => {
  const key = `${process.platform}-${process.arch}`
  return key === "linux-x64" || key === "linux-arm64" || key === "darwin-arm64" ? key : undefined
}

const defaultBinary = () => {
  const target = hostTarget()
  return target === undefined ? undefined : join(repository, "dist", `hush-${target}`)
}

// An IP literal as the host of a URL or an `allowedDomains` entry: IPv6 in brackets.
const hostPort = (ip: string, port: number) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`)

const StartupLine = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literal("listening"),
    addresses: Schema.Array(Schema.Struct({ ip: Schema.String, port: Schema.Number })),
    initCodeFile: Schema.String,
  }),
)

const InitReceipt = Schema.fromJsonString(Schema.Struct({ token: Schema.String }))

interface Started {
  readonly url: string
  readonly allowed: string
  readonly token: string
  readonly stop: () => void
}

// Starts a Server on a fresh state dir under `root` on any free port, then Inits it and creates the seed Item.
// `ip` is the address the CLI uses: 127.0.0.1, or the tailnet address it also listens on.
const startServer = async (root: string, name: string, ip: string): Promise<Started> => {
  const listen = ip === "127.0.0.1" ? [] : ["--listen", ip]
  const stateDir = join(root, name)
  const child = spawn(
    process.execPath,
    ["run", "bin/hush", "server", "--state-dir", stateDir, "--port", "0", ...listen],
    {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const stop = () => void child.kill("SIGTERM")
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = ""
    const timer = setTimeout(
      () => reject(new Error(`the ${name} Server printed no startup line within 15 s`)),
      startTimeoutMs,
    )
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      const end = stdout.indexOf("\n")
      if (end !== -1) {
        clearTimeout(timer)
        resolve(stdout.slice(0, end))
      }
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`the ${name} Server exited (${code}) before its startup line:\n${stderr}`))
    })
  })
  const startup = Schema.decodeUnknownSync(StartupLine)(line)
  const bound = startup.addresses.find((address) => address.ip === ip)
  if (bound === undefined) {
    stop()
    throw new Error(`the ${name} Server did not report a listener on ${ip}: ${line}`)
  }
  const url = `http://${hostPort(ip, bound.port)}`
  const home = join(root, `${name}-home`)
  const env = { HOME: home, HUSH_SERVER: url, HUSH_PROXY: "direct" }
  const hush = [process.execPath, "run", "bin/hush"]
  const succeeded = (ran: Ran, step: string) => {
    if (ran.code === 0) return ran
    stop()
    throw new Error(`${step} on the ${name} Server failed: ${ran.stderr}`)
  }
  const code = (await readFile(startup.initCodeFile, "utf8")).trim()
  const init = succeeded(
    await exec(
      [...hush, "init", "--vault", vault, "--label", "sandbox spike", "--print", "--passphrase-stdin"],
      env,
      `${code}\nsandbox spike passphrase ${crypto.randomUUID()}\n`,
    ),
    "hush init",
  )
  const token = Schema.decodeUnknownSync(InitReceipt)(init.stdout).token
  succeeded(
    await exec(
      [...hush, "create", "api-credential", "--title", seed.title, "--vault", vault, "--stdin"],
      { ...env, HUSH_TOKEN: token },
      `${seed.value}\n`,
    ),
    "creating the seed Item",
  )
  return { url, allowed: hostPort(ip, bound.port), token, stop }
}

// The settings of SECURITY.md's recipe for one Server, for `~/.claude/settings.json` (user settings).
const settingsFor = (server: Started) => ({
  env: { HUSH_TOKEN: server.token, HUSH_SERVER: server.url },
  permissions: { deny: ["Read(~/.config/hush/**)"] },
  sandbox: {
    enabled: true,
    filesystem: { denyRead: ["~/.config/hush/tokens.json"] },
    network: { allowedDomains: [server.allowed] },
  },
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const setup = async (args: ReadonlyArray<string>) => {
  const tailnet = flag(args, "--tailnet")
  if (tailnet !== undefined) {
    const parsed = Listen.parse("--listen", tailnet)
    if (Result.isFailure(parsed) || parsed.success.class !== "tailnet")
      throw new Error(`--tailnet ${tailnet} is not a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48)`)
  }
  const binary = flag(args, "--binary") ?? defaultBinary()
  if (flag(args, "--binary") === undefined) {
    const target = hostTarget()
    if (target === undefined) throw new Error(`no build target for ${process.platform}-${process.arch}; pass --binary`)
    console.log(`Building ${binary} ...`)
    const built = await exec(["sh", "scripts/build.sh", target], {})
    if (built.code !== 0) throw new Error(`the build failed:\n${built.stderr}`)
  }
  const root = await mkdtemp(join(tmpdir(), "hush-spike-"))
  const servers: Array<Started> = []
  const cleanup = async () => {
    for (const server of servers) server.stop()
    await rm(root, { recursive: true, force: true })
  }
  try {
    servers.push(await startServer(root, "loopback", "127.0.0.1"))
    if (tailnet !== undefined) servers.push(await startServer(root, "tailnet", tailnet))
  } catch (error) {
    await cleanup()
    throw error
  }

  const lines = [
    "",
    "Sandbox spike: Servers are running. Nothing below has been applied; apply it by hand.",
    "",
    `Compiled binary for \`check\`: ${binary}`,
    `Token file on this host (${tokenFile}): ${(await exists(tokenFile)) ? "present" : "absent, so `check` cannot tell denied from absent: save the spike Token first with `printf '%s\\n' <HUSH_TOKEN below> | HUSH_SERVER=<its url> hush token save --stdin`, and remove it afterwards with `HUSH_SERVER=<its url> hush token forget`"}`,
    "",
  ]
  for (const [index, server] of servers.entries())
    lines.push(
      `Server ${index + 1}: ${server.url}${index === 1 ? " (run `check` from a second tailnet node against this one)" : ""}`,
      "Merge into ~/.claude/settings.json (user settings) on the machine that runs `check`:",
      JSON.stringify(settingsFor(server), null, 2),
      '`sandbox.credentials.files` with `{ "path": "~/.config/hush/tokens.json", "mode": "deny" }` may replace `filesystem.denyRead`; run `check` once with each.',
      "",
    )
  lines.push(
    "Then, per Server:",
    "  1. Restart Claude Code so it reads the settings; `/sandbox` shows the sandbox is on.",
    `  2. Ask Claude to run \`bun test/sandbox-spike.ts check --binary ${binary}\` from ${repository} (a sandboxed Bash command, never excluded).`,
    `  3. Ask Claude to Read ${tokenFile}: the Read deny rule must refuse it.`,
    '  4. Add "HUSH_PROXY": "direct" to `env`, restart, run `check` again and record its HUSH_PROXY finding; then remove it.',
    "  5. Restore your settings. Ctrl-C here stops the Servers and deletes their state.",
    "",
  )
  console.log(lines.join("\n"))

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
  await cleanup()
  console.log("Servers stopped; state deleted.")
}

const DoctorReport = Schema.fromJsonString(
  Schema.Struct({
    server: Schema.NullOr(
      Schema.Struct({
        route: Schema.Literals(["direct", "proxy"]),
        proxy: Schema.NullOr(Schema.String),
        proxyUnused: Schema.NullOr(Schema.String),
        reachable: Schema.Boolean,
        state: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

type Outcome = "PASS" | "FAIL" | "INFO"

const results: Array<Outcome> = []

const report = (outcome: Outcome, name: string, evidence: string) => {
  results.push(outcome)
  console.log(`${outcome} ${name}: ${evidence}`)
}

// The last line of stderr, which carries the `hush: <message>` of a failed command.
const failureReason = (ran: Ran) => `exit ${ran.code}; ${ran.stderr.trim().split("\n").at(-1) ?? ""}`

type ServerCheck = NonNullable<typeof DoctorReport.Type.server>

const describeRoute = (server: ServerCheck) =>
  server.route === "proxy"
    ? `route=proxy via ${server.proxy ?? "?"}`
    : `route=direct${server.proxyUnused === null ? "" : ` (proxy unused: ${server.proxyUnused})`}`

// `hush doctor`'s server check, or the reason there is none.
const doctor = async (
  hush: ReadonlyArray<string>,
): Promise<{ readonly server: ServerCheck } | { readonly missing: string }> => {
  const ran = await exec([...hush, "doctor"], {})
  const decoded = Schema.decodeUnknownResult(DoctorReport)(ran.stdout)
  return Result.isSuccess(decoded) && decoded.success.server !== null
    ? { server: decoded.success.server }
    : { missing: `doctor gave no server report; ${failureReason(ran)}` }
}

const checkVariant = async (variant: string, hush: ReadonlyArray<string>) => {
  const checked = await doctor(hush)
  if (process.env["HUSH_PROXY"] === "direct") {
    // The Server is expected to be unreachable on this route; the finding is the route doctor reports.
    report(
      "INFO",
      `${variant} HUSH_PROXY=direct`,
      "missing" in checked
        ? checked.missing
        : `reached the command: doctor shows ${describeRoute(checked.server)}, reachable=${checked.server.reachable}`,
    )
    return
  }
  if ("missing" in checked) report("FAIL", `${variant} doctor`, checked.missing)
  else {
    const { server } = checked
    report(
      server.reachable && server.state === "ready" ? "PASS" : "FAIL",
      `${variant} doctor`,
      `${describeRoute(server)}, reachable=${server.reachable}, state=${server.state ?? "none"}`,
    )
    if (server.route !== "proxy")
      report("FAIL", `${variant} route`, `expected the sandbox's loopback proxy, got ${describeRoute(server)}`)
  }

  // PASS with `evidence` when the command exited 0 and `holds`, else FAIL with why.
  const expect = (name: string, ran: Ran, evidence: string, holds = true) =>
    ran.code === 0 && holds
      ? report("PASS", `${variant} ${name}`, evidence)
      : report("FAIL", `${variant} ${name}`, ran.code === 0 ? `exit 0, but not: ${evidence}` : failureReason(ran))

  const reference = `hush://${vault}/${seed.title}/credential`
  const found = await exec([...hush, "find", seed.title, "--vault", vault], {})
  expect("find", found, `lists ${reference}`, found.stdout.includes(reference))

  const ran = await exec(
    [...hush, "run", "--env", `SPIKE=${reference}`, "--", "sh", "-c", `test "$SPIKE" = "${seed.value}"`],
    {},
  )
  expect("run", ran, "the child saw the seed value")

  const title = `Spike ${variant} ${Date.now()}`
  const created = await exec(
    [...hush, "create", "api-credential", "--title", title, "--vault", vault, "--stdin"],
    {},
    `hush-spike-${crypto.randomUUID()}\n`,
  )
  expect("create --stdin", created, `created "${title}"`)
}

// A denied read shows as an error such as EACCES, as an empty file or as a missing one, depending on how the
// sandbox masks it; missing is only INFO, since the file may simply not exist. The contents are never printed.
const checkTokenFile = async () => {
  const outcome = await readFile(tokenFile).then(
    (bytes) => (bytes.length === 0 ? "reads as empty" : "readable"),
    (error: unknown) => PlatformCause.code(error) ?? "unreadable",
  )
  if (outcome === "ENOENT")
    report("INFO", "token file denied", `${tokenFile} is absent here: denied only if setup reported it present`)
  else report(outcome === "readable" ? "FAIL" : "PASS", "token file denied", `${tokenFile}: ${outcome}`)
}

const check = async (args: ReadonlyArray<string>) => {
  const server = process.env["HUSH_SERVER"]
  const token = process.env["HUSH_TOKEN"]
  if (server === undefined || token === undefined)
    throw new Error("HUSH_SERVER and HUSH_TOKEN must reach this command from the Claude Code settings `env`")
  const proxy = process.env["HTTP_PROXY"] ?? process.env["http_proxy"]
  report(
    "INFO",
    "environment",
    `HTTP_PROXY ${proxy === undefined ? "unset (not inside Claude Code's sandbox?)" : `host ${URL.parse(proxy)?.host ?? "unparseable"}`}, HUSH_PROXY ${process.env["HUSH_PROXY"] ?? "unset"}, HUSH_SERVER ${server}`,
  )
  await checkTokenFile()

  await checkVariant("bun", [process.execPath, "run", "bin/hush"])
  const binary = flag(args, "--binary") ?? defaultBinary()
  if (binary === undefined || !(await exists(binary)))
    report(
      "FAIL",
      "compiled",
      `no binary at ${binary ?? "(no target for this host)"}: build it outside the sandbox and pass --binary`,
    )
  else await checkVariant("compiled", [binary])

  const failed = results.filter((outcome) => outcome === "FAIL").length
  console.log(`\n${failed === 0 ? "spike: all checks passed" : `spike: ${failed} check(s) failed`}`)
  process.exitCode = failed === 0 ? 0 : 1
}

const [mode, ...rest] = process.argv.slice(2)
const main = mode === "setup" ? setup : mode === "check" ? check : undefined
if (main === undefined) {
  console.error("usage: bun test/sandbox-spike.ts setup [--tailnet <ip>] [--binary <path>] | check [--binary <path>]")
  process.exitCode = 2
} else
  await main(rest).catch((error: unknown) => {
    console.error(`spike: ${PlatformCause.message(error) ?? String(error)}`)
    process.exitCode = 1
  })
