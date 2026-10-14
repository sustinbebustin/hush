import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { StartupError } from "../src/server/StartupError.js"
import { StateDir } from "../src/server/StateDir.js"

const root = { uid: 0, gid: 0 }

const notOwned = (input: Parameters<typeof StateDir.check>[0]) => {
  const result = StateDir.check(input)
  return Result.isFailure(result) ? StartupError.render(result.failure) : "owned"
}

// The ownership diagnosis over the `stat` results each deployment produces after a backup was restored by root.
describe("StateDir.check", () => {
  it("names a root-owned database restored under a systemd static user, with its chown", () => {
    assert.strictEqual(
      notOwned({
        stateDir: "/var/lib/hush",
        paths: [
          { path: "/var/lib/hush", owner: { uid: 998, gid: 998 } },
          { path: "/var/lib/hush/hush.db", owner: root },
        ],
        server: { uid: 998, gid: 998 },
      }),
      "/var/lib/hush/hush.db is owned by 0:0 but the Server runs as 998:998; nothing was changed. Fix it with the command for your deployment: systemd static user `sudo chown hush:hush /var/lib/hush/hush.db`; DynamicUser `sudo chown --reference=/var/lib/private/hush /var/lib/hush/hush.db`; Docker `docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data/hush.db`.",
    )
  })

  it("names a root-owned WAL left beside a database under DynamicUser", () => {
    assert.strictEqual(
      notOwned({
        stateDir: "/var/lib/hush",
        paths: [
          { path: "/var/lib/hush", owner: { uid: 61184, gid: 61184 } },
          { path: "/var/lib/hush/hush.db", owner: { uid: 61184, gid: 61184 } },
          { path: "/var/lib/hush/hush.db-wal", owner: root },
        ],
        server: { uid: 61184, gid: 61184 },
      }),
      "/var/lib/hush/hush.db-wal is owned by 0:0 but the Server runs as 61184:61184; nothing was changed. Fix it with the command for your deployment: systemd static user `sudo chown hush:hush /var/lib/hush/hush.db-wal`; DynamicUser `sudo chown --reference=/var/lib/private/hush /var/lib/hush/hush.db-wal`; Docker `docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data/hush.db-wal`.",
    )
  })

  it("names a database copied in by `docker cp`, with its path inside the volume", () => {
    assert.strictEqual(
      notOwned({
        stateDir: "/data",
        paths: [
          { path: "/data", owner: { uid: 10001, gid: 10001 } },
          { path: "/data/hush.db", owner: root },
        ],
        server: { uid: 10001, gid: 10001 },
      }),
      "/data/hush.db is owned by 0:0 but the Server runs as 10001:10001; nothing was changed. Fix it with the command for your deployment: systemd static user `sudo chown hush:hush /data/hush.db`; DynamicUser `sudo chown --reference=/var/lib/private/hush /data/hush.db`; Docker `docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data/hush.db`.",
    )
  })

  it("names the state directory itself when a fresh volume belongs to root", () => {
    assert.strictEqual(
      notOwned({ stateDir: "/data", paths: [{ path: "/data", owner: root }], server: { uid: 10001, gid: 10001 } }),
      "/data is owned by 0:0 but the Server runs as 10001:10001; nothing was changed. Fix it with the command for your deployment: systemd static user `sudo chown hush:hush /data`; DynamicUser `sudo chown --reference=/var/lib/private/hush /data`; Docker `docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data`.",
    )
  })

  it("accepts files owned by the Server's uid whatever their group", () => {
    assert.strictEqual(
      notOwned({
        stateDir: "/var/lib/hush",
        paths: [
          { path: "/var/lib/hush", owner: { uid: 998, gid: 998 } },
          { path: "/var/lib/hush/hush.db", owner: { uid: 998, gid: 0 } },
        ],
        server: { uid: 998, gid: 998 },
      }),
      "owned",
    )
  })
})
