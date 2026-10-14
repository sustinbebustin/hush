import { assert, describe, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }

// The files a Deployer installs. The compiled binary and the image are smoke-tested by
// `scripts/smoke-binary.sh` and `scripts/smoke-docker.sh`; this file checks the shipped text.

const deploy = (name: string) => readFileSync(join(import.meta.dirname, "..", "deploy", name), "utf8")

// `Key=Value` lines per `[Section]`, comments and blank lines skipped (systemd.syntax(7), no continuations).
const unit = (text: string): ReadonlyMap<string, ReadonlyArray<readonly [string, string]>> => {
  const sections = new Map<string, Array<readonly [string, string]>>()
  let current: Array<readonly [string, string]> = []
  for (const line of text.split("\n").map((raw) => raw.trim())) {
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section?.[1] !== undefined) {
      current = []
      sections.set(section[1], current)
      continue
    }
    const at = line.indexOf("=")
    if (at === -1) throw new Error(`not a Key=Value line: ${line}`)
    current.push([line.slice(0, at), line.slice(at + 1)])
  }
  return sections
}

const service = (text: string) => new Map(unit(text).get("Service") ?? [])

// Directives that need a mount namespace, which an unprivileged LXC with nesting=0 refuses with 226/NAMESPACE.
// DynamicUser implies ProtectSystem=strict and PrivateTmp.
const mountNamespaced = [
  "DynamicUser",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "ProtectKernelTunables",
  "ProtectKernelModules",
  "ProtectKernelLogs",
  "ProtectControlGroups",
]

describe("deploy/hush.service", () => {
  it("runs `hush server` as a DynamicUser with a 0700 state dir, no core dumps and restart on failure", () => {
    const directives = service(deploy("hush.service"))
    for (const [key, value] of [
      ["ExecStart", "/usr/local/bin/hush server"],
      ["Environment", "HUSH_STATE_DIR=/var/lib/hush"],
      ["DynamicUser", "yes"],
      ["StateDirectory", "hush"],
      ["StateDirectoryMode", "0700"],
      ["UMask", "0077"],
      ["LimitCORE", "0"],
      ["NoNewPrivileges", "yes"],
      ["ProtectSystem", "strict"],
      ["CapabilityBoundingSet", ""],
      ["Restart", "on-failure"],
      ["RestartSec", "5"],
    ] as const)
      assert.strictEqual(directives.get(key), value, key)
  })

  it("never sets MemoryDenyWriteExecute, which silently disables Bun's JIT", () => {
    assert.isFalse(service(deploy("hush.service")).has("MemoryDenyWriteExecute"))
  })

  it("shows the tailnet ordering and the HUSH_LISTEN setting as comments", () => {
    const text = deploy("hush.service")
    assert.match(text, /^# After=tailscale-online\.target$/m)
    assert.match(text, /^# Wants=tailscale-online\.target$/m)
    assert.match(text, /^# Environment=HUSH_LISTEN=/m)
  })
})

describe("deploy/hush-static-user.conf", () => {
  it("turns off every mount-namespace directive the unit sets and runs as the static hush user", () => {
    const unitDirectives = service(deploy("hush.service"))
    const dropIn = service(deploy("hush-static-user.conf"))
    const set = mountNamespaced.filter((key) => unitDirectives.has(key))
    assert.deepStrictEqual(set, mountNamespaced)
    for (const key of set) assert.strictEqual(dropIn.get(key), "no", key)
    assert.strictEqual(dropIn.get("User"), "hush")
    assert.strictEqual(dropIn.get("Group"), "hush")
  })

  it("keeps the non-namespace hardening: it overrides nothing else", () => {
    const extra = [...service(deploy("hush-static-user.conf")).keys()].filter(
      (key) => !mountNamespaced.includes(key) && key !== "User" && key !== "Group",
    )
    assert.deepStrictEqual(extra, [])
  })
})

describe("deploy/hush-backup.service and .timer", () => {
  it("runs `hush server backup` daily as root, umask 0077, into /var/backups/hush", () => {
    const backup = service(deploy("hush-backup.service"))
    assert.strictEqual(backup.get("Type"), "oneshot")
    assert.strictEqual(backup.get("UMask"), "0077")
    assert.isFalse(backup.has("User") || backup.has("DynamicUser"))
    assert.include(
      backup.get("ExecStart") ?? "",
      "/usr/local/bin/hush server backup --state-dir /var/lib/hush /var/backups/hush/",
    )
    const timer = new Map(unit(deploy("hush-backup.timer")).get("Timer") ?? [])
    assert.strictEqual(timer.get("OnCalendar"), "daily")
    assert.strictEqual(timer.get("Persistent"), "true")
  })
})

const systemdAnalyze = spawnSync("systemd-analyze", ["--version"]).status === 0 && existsSync("/usr/lib/systemd/system")

// `systemd-analyze verify` against an alternate root holding the host's system units, the shipped files and
// executable stand-ins for the commands they run, so it needs no root and installs nothing.
const verify = (files: ReadonlyArray<readonly [string, string]>, units: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "hush-units-"))
  try {
    cpSync("/usr/lib/systemd/system", join(root, "usr/lib/systemd/system"), { recursive: true, verbatimSymlinks: true })
    // verify only checks that each command is executable.
    for (const command of ["usr/local/bin/hush", "bin/sh", "bin/mkdir"]) {
      mkdirSync(join(root, command, ".."), { recursive: true })
      writeFileSync(join(root, command), "#!/bin/sh\n")
      chmodSync(join(root, command), 0o755)
    }
    for (const [path, source] of files) {
      mkdirSync(join(root, "etc/systemd/system", path, ".."), { recursive: true })
      writeFileSync(join(root, "etc/systemd/system", path), deploy(source))
    }
    const result = spawnSync("systemd-analyze", ["verify", "--man=no", `--root=${root}`, ...units], {
      encoding: "utf8",
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!systemdAnalyze)("systemd-analyze verify", () => {
  it("passes the unit with no warning", () => {
    assert.deepStrictEqual(verify([["hush.service", "hush.service"]], ["hush.service"]), { status: 0, output: "" })
  })

  it("passes the unit with the static-user drop-in", () => {
    assert.deepStrictEqual(
      verify(
        [
          ["hush.service", "hush.service"],
          ["hush.service.d/static-user.conf", "hush-static-user.conf"],
        ],
        ["hush.service"],
      ),
      { status: 0, output: "" },
    )
  })

  it("passes the backup service and timer", () => {
    assert.deepStrictEqual(
      verify(
        [
          ["hush-backup.service", "hush-backup.service"],
          ["hush-backup.timer", "hush-backup.timer"],
        ],
        ["hush-backup.service", "hush-backup.timer"],
      ),
      { status: 0, output: "" },
    )
  })
})

describe("deploy/Dockerfile", () => {
  it("builds from oven/bun:1.4.3 and runs on debian:stable-slim, both pinned by digest", () => {
    const from = [...deploy("Dockerfile").matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map((match) => match[1])
    assert.strictEqual(from.length, 2)
    assert.match(from[0] ?? "", /^oven\/bun:1\.4\.3@sha256:[0-9a-f]{64}$/)
    assert.match(from[1] ?? "", /^debian:stable-slim@sha256:[0-9a-f]{64}$/)
  })

  it("never pre-enables the any-listen opt-in or a non-loopback listen", () => {
    const env = [...deploy("Dockerfile").matchAll(/^(?:ENV|ARG) (.+)$/gm)].map((match) => match[1]).join(" ")
    assert.match(env, /HUSH_STATE_DIR=\/data/)
    assert.notInclude(env, "HUSH_ALLOW_ANY_LISTEN")
    assert.notInclude(env, "HUSH_LISTEN")
  })
})

describe("deploy/compose.yaml", () => {
  it("runs this version's image on host networking, read-only, without capabilities or core dumps", () => {
    assert.deepStrictEqual(Bun.YAML.parse(deploy("compose.yaml")), {
      services: {
        hush: {
          image: `ghcr.io/sustinbebustin/hush:${packageJson.version}`,
          container_name: "hush",
          network_mode: "host",
          restart: "unless-stopped",
          read_only: true,
          tmpfs: ["/tmp"],
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          ulimits: { core: { soft: 0, hard: 0 } },
          volumes: ["hush-data:/data"],
        },
      },
      volumes: { "hush-data": { name: "hush-data" } },
    })
  })

  it("shows the bridge variant only as comments: loopback publish, HUSH_LISTEN 0.0.0.0 and the opt-in", () => {
    const text = deploy("compose.yaml")
    assert.match(text, /^\s*# ports: \["127\.0\.0\.1:7787:7787"\]/m)
    assert.match(text, /^\s*# environment: \{ HUSH_LISTEN: 0\.0\.0\.0, HUSH_ALLOW_ANY_LISTEN: "true" \}/m)
  })
})
