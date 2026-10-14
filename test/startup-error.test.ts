import { assert, describe, it } from "@effect/vitest"

import { StartupError } from "../src/server/StartupError.js"

// The startup error catalogue: one line per tag, with the exact wording operators see.
const catalogue: { readonly [Tag in StartupError.StartupError["_tag"]]: readonly [StartupError.StartupError, string] } =
  {
    StateDirRequired: [
      new StartupError.StateDirRequired(),
      "hush server needs a state directory and none was given; nothing was created. Pass `--state-dir /var/lib/hush` or set `HUSH_STATE_DIR` (the unit and image set it already).",
    ],
    ConfigInvalid: [
      new StartupError.ConfigInvalid({ source: "--port", reason: "expected a port number from 0 to 65535" }),
      "--port is invalid (expected a port number from 0 to 65535); nothing was started.",
    ],
    ListenInvalid: [
      new StartupError.ListenInvalid({ source: "--listen", value: "tailnet.example" }),
      "`--listen tailnet.example` must be an IP address (not a hostname, link-local or IPv4-mapped address); nothing was started. For the tailnet use the 100.x address from `tailscale ip -4`.",
    ],
    ListenNotAllowed: [
      new StartupError.ListenNotAllowed({ ip: "192.168.1.5" }),
      "Refusing to listen on 192.168.1.5: it is not a loopback or Tailscale address, and Tokens and the Passphrase would cross it in cleartext; nothing was started. In a Docker bridge container set `HUSH_ALLOW_ANY_LISTEN=true` only together with `-p 127.0.0.1:7787:7787` or `-p <tailnet-ip>:7787:7787`; elsewhere listen on 127.0.0.1 or the tailnet IP.",
    ],
    ListenAddressUnavailable: [
      new StartupError.ListenAddressUnavailable({ ip: "100.101.102.103" }),
      "100.101.102.103 is not assigned to this host yet; nothing was started. If it is the tailnet IP, start after Tailscale (`systemctl enable tailscale-wait-online.service` and order the unit after `tailscale-online.target`); systemd and Docker retry automatically.",
    ],
    ListenAddressInUse: [
      new StartupError.ListenAddressInUse({ ip: "127.0.0.1", port: 7787 }),
      "127.0.0.1:7787 is already in use (another hush Server on this state dir or port?); nothing was started. Stop the other process or choose `--port`.",
    ],
    ListenFailed: [
      new StartupError.ListenFailed({ ip: "127.0.0.1", port: 80, code: "EACCES" }),
      "Could not listen on 127.0.0.1:80 (EACCES); nothing was started.",
    ],
    StateFileNotOwned: [
      new StartupError.StateFileNotOwned({
        stateDir: "/var/lib/hush",
        path: "/var/lib/hush/hush.db",
        owner: { uid: 0, gid: 0 },
        server: { uid: 998, gid: 998 },
      }),
      "/var/lib/hush/hush.db is owned by 0:0 but the Server runs as 998:998; nothing was changed. Fix it with the command for your deployment: systemd static user `sudo chown hush:hush /var/lib/hush/hush.db`; DynamicUser `sudo chown --reference=/var/lib/private/hush /var/lib/hush/hush.db`; Docker `docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data/hush.db`.",
    ],
    StatePermissionFailed: [
      new StartupError.StatePermissionFailed({ operation: "chmod-0700", path: "/var/lib/hush", code: "EROFS" }),
      "Could not set mode 0700 on /var/lib/hush (EROFS); nothing else was changed. Check the directory's owner and the filesystem (never NFS or a bind mount).",
    ],
    DatabaseOpenFailed: [
      new StartupError.DatabaseOpenFailed({ path: "/var/lib/hush/hush.db", code: "SQLITE_NOTADB" }),
      "Could not open /var/lib/hush/hush.db (SQLITE_NOTADB); nothing was changed. If it was just restored, check it is a hush backup and that `-wal`/`-shm` from the old file were deleted.",
    ],
    MigrationFailed: [
      new StartupError.MigrationFailed({ version: "0002_example", message: "table meta already exists" }),
      "Upgrading the database schema to 0002_example failed (table meta already exists); the migration was rolled back and the file is as before. Keep the file, run the previous hush version, and report the message.",
    ],
    MigrationPending: [
      new StartupError.MigrationPending(),
      "The database schema is older than this hush binary; nothing was changed. Start the Server once (it migrates), then run the command again.",
    ],
    MetaInvalid: [
      new StartupError.MetaInvalid({ field: "kdf_salt" }),
      `The database's key metadata is invalid (kdf_salt), so it was modified or corrupted; nothing was changed. Restore from a backup (README, "Backup and restore").`,
    ],
    InitCodeWriteFailed: [
      new StartupError.InitCodeWriteFailed({ path: "/var/lib/hush/init-code", code: "ENOSPC" }),
      "Could not write the Init code file /var/lib/hush/init-code (ENOSPC); nothing else was changed. Check the state directory's owner and free space.",
    ],
  }

describe("StartupError.render", () => {
  for (const [tag, [error, line]] of Object.entries(catalogue))
    it(`renders ${tag} as its one catalogue line`, () => {
      assert.strictEqual(error._tag, tag)
      assert.strictEqual(StartupError.render(error), line)
      assert.notInclude(line, "\n")
    })
})
