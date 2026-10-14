import { Match, Schema } from "effect"

// Server startup errors: each is printed as one `hush: <message>` line on stderr,
// then the process exits 1, so journald and `docker logs` show it and the supervisor retries.

export class StateDirRequired extends Schema.TaggedError<StateDirRequired>()("StateDirRequired", {}) {}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  // The flag or env var as the Deployer wrote it, e.g. `--port` or `HUSH_PORT`.
  source: Schema.String,
  reason: Schema.String,
}) {}

// A listen address that is not a plain IP literal: a hostname, link-local, scoped or IPv4-mapped.
export class ListenInvalid extends Schema.TaggedError<ListenInvalid>()("ListenInvalid", {
  source: Schema.Literals(["--listen", "HUSH_LISTEN"]),
  value: Schema.String,
}) {}

// An address outside 127/8, ::1, 100.64/10 and fd7a:115c:a1e0::/48 without `--allow-any-listen`.
export class ListenNotAllowed extends Schema.TaggedError<ListenNotAllowed>()("ListenNotAllowed", {
  ip: Schema.String,
}) {}

// `EADDRNOTAVAIL`: typically the tailnet address before Tailscale is up; the supervisor's restart retries.
export class ListenAddressUnavailable extends Schema.TaggedError<ListenAddressUnavailable>()(
  "ListenAddressUnavailable",
  { ip: Schema.String },
) {}

export class ListenAddressInUse extends Schema.TaggedError<ListenAddressInUse>()("ListenAddressInUse", {
  ip: Schema.String,
  port: Schema.Number,
}) {}

// Any other bind error, by its system code.
export class ListenFailed extends Schema.TaggedError<ListenFailed>()("ListenFailed", {
  ip: Schema.String,
  port: Schema.Number,
  code: Schema.String,
}) {}

// A file's owner, or the identity the Server runs as.
export const Owner = Schema.Struct({ uid: Schema.Number, gid: Schema.Number })

export type Owner = typeof Owner.Type

export class StateFileNotOwned extends Schema.TaggedError<StateFileNotOwned>()("StateFileNotOwned", {
  stateDir: Schema.String,
  // The state directory itself or a file directly inside it.
  path: Schema.String,
  owner: Owner,
  server: Owner,
}) {}

export class StatePermissionFailed extends Schema.TaggedError<StatePermissionFailed>()("StatePermissionFailed", {
  // `read` and `delete` cover listing the state directory and removing stale snapshots; `chown` is a host
  // command run as root handing a `-wal`/`-shm` it created back to the database's owner.
  operation: Schema.Literals(["create", "chmod-0700", "chmod-0600", "read", "delete", "chown"]),
  path: Schema.String,
  code: Schema.String,
}) {}

export class DatabaseOpenFailed extends Schema.TaggedError<DatabaseOpenFailed>()("DatabaseOpenFailed", {
  path: Schema.String,
  code: Schema.String,
}) {}

export class MigrationFailed extends Schema.TaggedError<MigrationFailed>()("MigrationFailed", {
  version: Schema.String,
  message: Schema.String,
}) {}

// A host command found a schema older than this binary's; host commands never migrate, so only the
// Server changes the schema.
export class MigrationPending extends Schema.TaggedError<MigrationPending>()("MigrationPending", {}) {}

// The `meta` row of a Ready database does not decode: the file was edited or is corrupt.
export class MetaInvalid extends Schema.TaggedError<MetaInvalid>()("MetaInvalid", {
  // The first column that fails, e.g. `kdf_salt`.
  field: Schema.String,
}) {}

export class InitCodeWriteFailed extends Schema.TaggedError<InitCodeWriteFailed>()("InitCodeWriteFailed", {
  path: Schema.String,
  code: Schema.String,
}) {}

export type StartupError =
  | StateDirRequired
  | ConfigInvalid
  | ListenInvalid
  | ListenNotAllowed
  | ListenAddressUnavailable
  | ListenAddressInUse
  | ListenFailed
  | StateFileNotOwned
  | StatePermissionFailed
  | DatabaseOpenFailed
  | MigrationFailed
  | MigrationPending
  | MetaInvalid
  | InitCodeWriteFailed

const ownerText = ({ uid, gid }: { readonly uid: number; readonly gid: number }) => `${uid}:${gid}`

// The image mounts the state directory at /data.
const dockerPath = ({ stateDir, path }: StateFileNotOwned) =>
  path === stateDir ? "/data" : `/data/${path.slice(stateDir.length + 1)}`

const operationText = {
  create: "create",
  "chmod-0700": "set mode 0700 on",
  "chmod-0600": "set mode 0600 on",
  read: "read",
  delete: "delete",
  chown: "change the owner of",
} as const

export const render: (error: StartupError) => string = Match.type<StartupError>().pipe(
  Match.tagsExhaustive({
    StateDirRequired: () =>
      "hush server needs a state directory and none was given; nothing was created. Pass `--state-dir /var/lib/hush` or set `HUSH_STATE_DIR` (the unit and image set it already).",
    ConfigInvalid: (error) => `${error.source} is invalid (${error.reason}); nothing was started.`,
    ListenInvalid: (error) =>
      `${error.source === "--listen" ? `\`--listen ${error.value}\`` : `\`HUSH_LISTEN\` item \`${error.value}\``} must be an IP address (not a hostname, link-local or IPv4-mapped address); nothing was started. For the tailnet use the 100.x address from \`tailscale ip -4\`.`,
    ListenNotAllowed: (error) =>
      `Refusing to listen on ${error.ip}: it is not a loopback or Tailscale address, and Tokens and the Passphrase would cross it in cleartext; nothing was started. In a Docker bridge container set \`HUSH_ALLOW_ANY_LISTEN=true\` only together with \`-p 127.0.0.1:7787:7787\` or \`-p <tailnet-ip>:7787:7787\`; elsewhere listen on 127.0.0.1 or the tailnet IP.`,
    ListenAddressUnavailable: (error) =>
      `${error.ip} is not assigned to this host yet; nothing was started. If it is the tailnet IP, start after Tailscale (\`systemctl enable tailscale-wait-online.service\` and order the unit after \`tailscale-online.target\`); systemd and Docker retry automatically.`,
    ListenAddressInUse: (error) =>
      `${error.ip}:${error.port} is already in use (another hush Server on this state dir or port?); nothing was started. Stop the other process or choose \`--port\`.`,
    ListenFailed: (error) => `Could not listen on ${error.ip}:${error.port} (${error.code}); nothing was started.`,
    StateFileNotOwned: (error) =>
      `${error.path} is owned by ${ownerText(error.owner)} but the Server runs as ${ownerText(error.server)}; nothing was changed. Fix it with the command for your deployment: systemd static user \`sudo chown hush:hush ${error.path}\`; DynamicUser \`sudo chown --reference=/var/lib/private/hush ${error.path}\`; Docker \`docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 ${dockerPath(error)}\`.`,
    StatePermissionFailed: (error) =>
      `Could not ${operationText[error.operation]} ${error.path} (${error.code}); nothing else was changed. Check the directory's owner and the filesystem (never NFS or a bind mount).`,
    DatabaseOpenFailed: (error) =>
      `Could not open ${error.path} (${error.code}); nothing was changed. If it was just restored, check it is a hush backup and that \`-wal\`/\`-shm\` from the old file were deleted.`,
    MigrationFailed: (error) =>
      `Upgrading the database schema to ${error.version} failed (${error.message}); the migration was rolled back and the file is as before. Keep the file, run the previous hush version, and report the message.`,
    MigrationPending: () =>
      "The database schema is older than this hush binary; nothing was changed. Start the Server once (it migrates), then run the command again.",
    MetaInvalid: (error) =>
      `The database's key metadata is invalid (${error.field}), so it was modified or corrupted; nothing was changed. Restore from a backup (README, "Backup and restore").`,
    InitCodeWriteFailed: (error) =>
      `Could not write the Init code file ${error.path} (${error.code}); nothing else was changed. Check the state directory's owner and free space.`,
  }),
)

export * as StartupError from "./StartupError.js"
