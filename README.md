# hush

A self-hosted secret store that lets coding agents use secrets without seeing them.

One binary is both the Server (`hush server`) and the CLI (`hush`). An agent holds one Token and works with `hush://Vault/Item/field` References; hush puts the values into the processes that need them, so plaintext never enters the model's context.

1. The agent finds a credential by title: `hush find openai` returns its Reference, never its value.
2. It runs a command with the value injected: `hush run --env "OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential" -- bun run dev`.
3. It saves a new secret from a pipe: `... | hush create api-credential --title "Stripe API Key" --vault Work --stdin`, read back and verified.

The Owner, a human with the Passphrase, does everything else: Init, Vaults, Item changes, Tokens, the Audit Log and backups. hush is not a sandbox (a child given a secret can do anything with it) and not a sharing tool for teams. What it defends is in [SECURITY.md](SECURITY.md); the terms used here are defined in [GLOSSARY.md](GLOSSARY.md).

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [First run](#first-run)
- [Give an agent access](#give-an-agent-access)
- [Commands](#commands)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Backup and restore](#backup-and-restore)
- [Recovery](#recovery)
- [Security](#security)
- [Development](#development)

## How it works

- **Server.** Holds every Vault in one SQLite database, `hush.db`, with each value sealed under its Vault's key. It listens on `127.0.0.1:7787`, and on a tailnet address when you add one. Plain HTTP is allowed only there ([ADR-0005](docs/adr/0005-plain-http-on-loopback-or-tailnet.md)).
- **Vaults and Items.** A Vault groups Items. An Item has a Kind (`api-credential`, `login` or `database`) and Fields; one Field is the secret, the rest are plain metadata. A Reference names one Field: `hush://Personal/GitHub/password`.
- **Tokens.** A Token has a Label and fixed Grants, each a Vault with Read or Read+Create Access ([ADR-0007](docs/adr/0007-fixed-vault-grants-per-token.md)). It carries the keys of its Vaults, so the Server serves it from the moment it starts, reboots included ([ADR-0002](docs/adr/0002-tokens-carry-vault-keys.md)). A Token can never change or delete an existing Item.
- **The Passphrase.** Every human-only operation asks for it ([ADR-0004](docs/adr/0004-passphrase-for-every-human-operation.md)). There is no reset.
- **The contract.** Results are compact JSON on stdout. Every expected error is one `hush: <message>` line on stderr with exit 1, and the message says what was left unchanged and what to do next. Each command makes one Server request (`create` adds its read-back) and never retries.

## Install

macOS runs the CLI only; a macOS or Windows Server is unsupported.

With [Homebrew](https://brew.sh) on macOS or Linux, which installs the release binary:

```sh
brew install sustinbebustin/tap/hush
```

With [Bun](https://bun.sh), which runs the package from npm:

```sh
bun add -g @sustinbebustin/hush
```

Or install a release binary by hand: `hush-linux-x64`, `hush-linux-arm64`, `hush-darwin-arm64` or `hush-darwin-x64`. Download yours and `SHA256SUMS` from the [latest release](https://github.com/sustinbebustin/hush/releases/latest), verify, and install:

```sh
curl -fLO https://github.com/sustinbebustin/hush/releases/latest/download/hush-linux-x64
curl -fLO https://github.com/sustinbebustin/hush/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS (ignore the three missing files)
sudo install -m 0755 hush-linux-x64 /usr/local/bin/hush
hush --version
```

To build from source instead, with [Bun](https://bun.sh): `bun install && bun run build` writes the four binaries to `dist/`.

Then install the agent skill, which teaches agents the commands and rules: copy [`skills/hush`](skills/hush/SKILL.md) to `~/.claude/skills/hush`, or run `bunx skills add sustinbebustin/hush` where Bun is installed.

## First run

Start a Server first (see [Deploy](#deploy)). Until Init, its state directory holds an Init code, which proves you can read the Server's files. The paths below are the systemd unit's; to try hush locally, run `mkdir -p ~/.local/state && hush server --state-dir ~/.local/state/hush` in another terminal and read `~/.local/state/hush/init-code` instead.

### On the Server's own machine

```sh
sudo cat /var/lib/hush/init-code
hush init --vault Personal
```

`hush init` asks for the Init code, then a new Passphrase twice. It initialises the Server, creates the Vault `Personal` and saves a Read+Create Token for it, labelled `<user> on <hostname>`, in `~/.config/hush/tokens.json`. Without `--vault` it initialises the Server and creates nothing else.

Write the Passphrase down offline now. There is no reset (see [Lost Passphrase](#lost-passphrase)).

### From another machine

Run these in this order:

```sh
hush config set server http://<tailnet-ip>:7787
ssh <server-host> sudo cat /var/lib/hush/init-code
hush init --vault Personal
```

The Server URL decides where `init` sends the Passphrase, and the saved Token is keyed by that URL. Run `init` before `config set server` and it goes to whatever Server the old setting named, with the Token saved for the wrong origin.

### Further Vaults

```sh
hush vault create Work
hush token issue --label "<same label>" --create Work --keep-grants --replace
```

A new Vault is in no existing Token. The second command widens your saved Token: it issues a replacement with the same Label that keeps the old Grants and adds `Work`, revokes the old Token in the same step, and saves the new one. Use `--read` instead of `--create` for Read-only Access.

Run Passphrase commands in a shell no agent uses; see [SECURITY.md](SECURITY.md#trust-boundaries).

## Give an agent access

Give each agent its own Token with only the Vaults its task needs, printed instead of saved:

```sh
hush token issue --label "claude on devbox" --read Work --ttl 90d --print
```

Launch the agent with that Token as `HUSH_TOKEN` and the Server as `HUSH_SERVER`, and install the skill. An agent running as your own user can otherwise read your saved token file; the [agent isolation recipe](SECURITY.md#agent-isolation-recipe) keeps it out with Claude Code's sandbox or a separate Linux user.

`hush token list` shows every Token with its Grants and state; `hush token revoke "claude on devbox"` stops one at once. The Audit Log (`hush audit --label "claude on devbox" --since 7d`) records every request a Token made, never a value.

## Commands

`hush <command> --help` documents every flag.

For agents, with a Token:

| Command                                                      | What it does                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `hush find <query...>`                                       | References whose title matches each query, with suggestions for near misses |
| `hush inventory`                                             | the granted Vaults and every Item's metadata and References                 |
| `hush run --env NAME=<ref> -- <command...>`                  | run a command with values in its environment; exits with its exit code      |
| `hush env write <file> NAME=<ref>...`                        | write an env template of References (no request)                            |
| `hush env run <file> -- <command...>`                        | run a command with every value of a template                                |
| `hush env resolve <file> --output <file>`                    | write the values to a new 0600 file, only for a tool that needs one         |
| `hush create <kind> --title <title> --vault <vault> --stdin` | create an Item from piped input and verify it; never overwrites             |
| `hush read <ref>`                                            | print one value: the only command that does                                 |
| `hush token status`                                          | the current Token's Label, Grants and expiry                                |

`run` and `env run` mask concealed values of 8 bytes or more in the child's piped output, best effort. `read` and `env resolve` are never masked.

For the Owner, with the Passphrase:

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `hush init`                 | initialise a new Server                                        |
| `hush vault`                | create, list and delete Vaults                                 |
| `hush item list <vault>`    | a Vault's Items and Retired titles, never a value, no Token    |
| `hush item`                 | edit, rename, delete and release existing Items                |
| `hush token issue`          | issue a Token with fixed Grants                                |
| `hush token list`           | every Token with its Grants and state                          |
| `hush token revoke <label>` | stop a Token at once                                           |
| `hush audit`                | read the Audit Log, newest first                               |
| `hush backup <file>`        | download a checked snapshot of the database                    |
| `hush passphrase change`    | change the Passphrase; Vaults, Tokens and values are untouched |

Every Passphrase command reads it from a hidden prompt, or with `--passphrase-stdin` from a pipe.

On the Server host, as root or the owner of `hush.db`, with no Passphrase: `hush server` runs the Server, `hush server revoke <label>` revokes a Token, and `hush server backup <file>` writes a snapshot.

Needing no credential: `hush status` (the Server's state and versions), `hush doctor` (checks the setup; safe to paste into an issue), `hush config get|set`, and `hush token save|forget` for the local token file.

## Configuration

The CLI reads each setting from the environment, else `~/.config/hush/config.json` (written by `hush config set`), else the default. `hush config get` shows the values in use and where each came from.

| Variable      | Default                 | Description                                                                                                                                      |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HUSH_SERVER` | `http://127.0.0.1:7787` | the Server URL; `hush config set server <url>`                                                                                                   |
| `HUSH_PROXY`  | `auto`                  | `auto` sends requests through a loopback `HTTP_PROXY` (an agent sandbox's) when set; `direct` never uses a proxy; `hush config set proxy <mode>` |
| `HUSH_TOKEN`  | -                       | the Token to use; when set, the token file is never opened                                                                                       |

Without `HUSH_TOKEN`, the CLI uses the Token saved for this Server URL in `~/.config/hush/tokens.json` (directory 0700, file 0600). A bad credential fails closed: no other source is tried.

The Server takes flags, each with an environment variable:

| Flag                    | Variable                     | Description                                                                            |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `--state-dir`           | `HUSH_STATE_DIR`             | required; holds `hush.db` and, until Init, the Init code                               |
| `--port`                | `HUSH_PORT`                  | default 7787                                                                           |
| `--listen <ip>`         | `HUSH_LISTEN`                | also listen on this IP, e.g. the tailnet IP; repeatable (comma-separated)              |
| `--allow-any-listen`    | `HUSH_ALLOW_ANY_LISTEN=true` | allow `--listen` outside loopback and the tailnet; the Server warns at every start     |
| `--allowed-host <name>` | `HUSH_ALLOWED_HOSTS`         | also accept this hostname, e.g. a `tailscale serve` name; repeatable (comma-separated) |

## Deploy

### Supported network setups

The Server listens on `127.0.0.1:7787` and never on `0.0.0.0` or `::` implicitly. `--listen <ip>` adds an address next to loopback; any address outside loopback and the tailnet needs `--allow-any-listen`, because Tokens and the Passphrase cross it in cleartext.

| Setup                                                 | Listen                                               | Notes                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Binary + systemd, same machine                        | 127.0.0.1 (always on)                                | the CLI's default URL works                                                                                                    |
| Binary + systemd, remote over Tailscale (kernel mode) | 127.0.0.1 + `--listen <tailnet-ip>`                  | order the unit after `tailscale-online.target`; a Tailscale ACL limits the port                                                |
| Docker, `network_mode: host` (recommended)            | as above                                             | `restart: unless-stopped` rides out the tailnet boot race                                                                      |
| Docker bridge                                         | `HUSH_LISTEN=0.0.0.0` + `HUSH_ALLOW_ANY_LISTEN=true` | publish only `127.0.0.1:7787:7787` or `<tailnet-ip>:7787:7787`, never a bare `-p`; Engine >= 28.0.0 (>= 28.3.3 with firewalld) |
| LXC, kernel-mode Tailscale                            | 127.0.0.1 + tailnet IP                               | `/dev/net/tun` passed through                                                                                                  |
| LXC or sidecar, userspace Tailscale                   | 127.0.0.1                                            | every peer arrives on loopback, so the whole tailnet reaches the Server: a Tailscale ACL on the port is required               |
| `tailscale serve` in front                            | 127.0.0.1                                            | allowed, not recommended; its MagicDNS name goes in `--allowed-host` and in `HUSH_SERVER`                                      |
| Funnel                                                | -                                                    | never; the Server refuses every request that arrives through it                                                                |
| macOS Server, Docker Desktop                          | -                                                    | unsupported                                                                                                                    |

The health check is `GET /v1/status` (or `hush status`), which needs no credential.

### Where the database may live

The state directory holds `hush.db` (with its `-wal` and `-shm`) and, until Init, the Init code. Keep it on a local filesystem the Server owns: the host or LXC root filesystem, a Proxmox volume mount point or a Docker named volume. Never a bind mount (vzdump skips them) or NFS (SQLite's locking is not sound there). The Server creates the directory 0700 and the files 0600 and refuses to start on files it does not own, naming the `chown` that fixes them.

### systemd

[`deploy/hush.service`](deploy/hush.service) is a hardened unit: a dynamic user, `StateDirectory=hush` (mode 0700), `UMask=0077`, no core dumps (`LimitCORE=0`), and the usual sandboxing directives.

```sh
sudo install -m 0644 deploy/hush.service /etc/systemd/system/hush.service
sudo systemctl daemon-reload && sudo systemctl enable --now hush
```

To also listen on the tailnet, add a drop-in with `sudo systemctl edit hush`:

```ini
[Unit]
After=tailscale-online.target
Wants=tailscale-online.target

[Service]
Environment=HUSH_LISTEN=100.x.y.z
```

and run `sudo systemctl enable tailscale-wait-online.service` (Tailscale >= 1.96.2), so the Server starts once the tailnet address exists. If it starts too early it exits naming `tailscale-online.target`, and systemd retries it.

Where the host cannot set up a mount namespace (an unprivileged LXC with nesting=0), the unit fails with `status=226/NAMESPACE`. Install the static-user drop-in [`deploy/hush-static-user.conf`](deploy/hush-static-user.conf) instead; it runs the Server as a system user `hush` and keeps every hardening directive that needs no namespace:

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin hush
sudo install -D -m 0644 deploy/hush-static-user.conf /etc/systemd/system/hush.service.d/static-user.conf
sudo systemctl daemon-reload && sudo systemctl restart hush
```

Unattended daily backups: [`deploy/hush-backup.service`](deploy/hush-backup.service) and [`deploy/hush-backup.timer`](deploy/hush-backup.timer) run `hush server backup` as root into `/var/backups/hush` (see [Backup and restore](#backup-and-restore)).

### Proxmox LXC

An unprivileged Debian or Ubuntu container with 1 vCPU, 512 MiB of RAM (one 64 MiB Argon2 derivation must fit) and a 2 GiB disk, running the binary and `hush.service` as above.

- **Nesting.** With nesting=1 (`pct set <CTID> --features nesting=1`, or Options > Features) the full unit applies. With nesting=0, install the static-user drop-in; without it the unit fails with `status=226/NAMESPACE`.
- **Kernel-mode Tailscale.** Pass `/dev/net/tun` through (`pct set <CTID> --dev0 /dev/net/tun`, or `lxc.cgroup2.devices.allow: c 10:200 rwm` plus `lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file` in the container's config), run Tailscale in the container, and listen on its tailnet IP as above.
- **Userspace Tailscale.** The Server listens on loopback only, and every tailnet peer arrives on loopback, so a Tailscale ACL that limits port 7787 to your own devices is required.
- **Init from the CLI machine:** `hush config set server http://<tailnet-ip>:7787` first, then read the code with `pct exec <CTID> -- cat /var/lib/hush/init-code` on the Proxmox host (or `pct enter <CTID>` and `cat` it), then `hush init --vault Personal`.
- **Host commands** run inside the container as root, for example `pct exec <CTID> -- hush server revoke --state-dir /var/lib/hush "<label>"`. The backup timer above works unchanged inside the container.
- **The database** stays on the container's rootfs or a volume mount point, never a bind mount.
- **Disk-usage alert.** The Audit Log is kept forever, and 2 GiB holds it comfortably at normal rates. But an active, misused Token can append rows fast enough to fill the disk, and a full disk stops every request because the Audit Log fails closed. Set a disk-usage alert in Proxmox or any monitor. If the disk is already full: stop the Server, grow the disk, start it, then Revoke the Token.

### Tailscale

- Limit the hush port to your own devices in the tailnet policy, for example a grant `{ "src": ["you@example.com"], "dst": ["tag:hush"], "ip": ["tcp:7787"] }` with no broader rule reaching the Server's device.
- Use the tailnet IP in `HUSH_SERVER` or `hush config set server`. A MagicDNS name works only if the Server lists it with `--allowed-host`.
- `tailscale serve` is allowed but not recommended: the Server then sees every peer as 127.0.0.1. Serve to `http://127.0.0.1:7787` (for example `tailscale serve --bg --http=8080 http://127.0.0.1:7787`), start the Server with `--allowed-host <machine-name>` (and the full `.ts.net` name if you use it), and use that name in `HUSH_SERVER`; serve refuses a raw 100.x IP.
- Never Funnel. The Server refuses every request that arrives through it.

### Docker

[`deploy/compose.yaml`](deploy/compose.yaml) runs `ghcr.io/sustinbebustin/hush:<version>` with host networking, a read-only root filesystem, dropped capabilities, a core ulimit of 0, the named volume `hush-data` and `restart: unless-stopped`:

```sh
docker compose -f deploy/compose.yaml up -d
docker exec hush cat /data/init-code
hush init --vault Personal
```

`hush init` runs with the host's CLI (host networking: the default `127.0.0.1:7787`), or from another machine after `hush config set server http://<tailnet-ip>:7787`. To listen on the tailnet too, set `HUSH_LISTEN: <tailnet-ip>` under `environment`.

- **Token-saving commands** (`init --vault`, `token issue`) run from a CLI machine. Inside the container there is no writable home, so without `--print` they fail before the Passphrase prompt.
- **Plain `docker run`:** pass `--name hush --ulimit core=0 --read-only --tmpfs /tmp`. A container inherits the daemon's core limit otherwise. Check with `docker exec hush sh -c 'ulimit -c'`, which must print 0.
- **Bridge networking** (Docker Engine >= 28.0.0, >= 28.3.3 with firewalld): drop `network_mode: host`, set `HUSH_LISTEN: 0.0.0.0` and `HUSH_ALLOW_ANY_LISTEN: "true"`, and publish `127.0.0.1:7787:7787` or `<tailnet-ip>:7787:7787` only, never a bare port, which exposes the LAN. The Server warns about the opt-in at every start. The compose file has this variant commented out.
- **Tailscale sidecar:** `network_mode: service:tailscale`, either in kernel mode (`TS_USERSPACE=false`, `/dev/net/tun`, `cap_add: [net_admin, net_raw]`, a persistent `TS_STATE_DIR`) with the Server listening on the tailnet IP, or in userspace mode with the Server on loopback and a Tailscale ACL.
- **Unattended backups,** from root's crontab on the host: `umask 077 && docker exec hush hush server backup - > /var/backups/hush/hush-$(date +\%F).db`.
- **Break-glass Revoke:** `docker exec hush hush server revoke "<label>"`.

## Backup and restore

### Backup

- **Ad hoc,** from any machine that reaches the Server: `hush backup ~/hush-$(date +%F).db` (asks for the Passphrase). It downloads a consistent snapshot, checks its size and SHA-256, writes it 0600 and never overwrites a file.
- **Unattended,** on the Server host, as root or the owner of `hush.db`, with no Passphrase: `hush server backup --state-dir /var/lib/hush <file>`, from the systemd timer or (Docker) cron above. `-` instead of a file writes the snapshot to stdout.
- **Alternatives:** stop the Server and copy `hush.db` plus any `hush.db-wal`; or a vzdump snapshot of the container. Restore-test a snapshot before relying on it; the two commands above are recommended instead.

Treat every backup as sensitive. Names, Kinds, Labels and the Audit Log are readable in it. Its values open with the Passphrase, or with any Token, that was valid when it was taken, and those same credentials open every later copy too, because Vault keys never change in v1. Keep backups on hardware you own.

### Restore

1. If the old Server still answers, save its Token list first: `hush token list > tokens-before-restore.json`.
2. Stop the Server, put the backup in place with the right owner (the Server refuses files it does not own), and delete the old WAL files. Replace `backup.db` with your file:
   - systemd, static `hush` user: `sudo systemctl stop hush && sudo install -o hush -g hush -m 0600 backup.db /var/lib/hush/hush.db && sudo rm -f /var/lib/hush/hush.db-wal /var/lib/hush/hush.db-shm && sudo systemctl start hush`
   - systemd, DynamicUser: `sudo systemctl stop hush && sudo install -m 0600 backup.db /var/lib/private/hush/hush.db && sudo chown --reference=/var/lib/private/hush /var/lib/private/hush/hush.db && sudo rm -f /var/lib/private/hush/hush.db-wal /var/lib/private/hush/hush.db-shm && sudo systemctl start hush`
   - Docker: `docker compose stop hush && docker run --rm -v hush-data:/data -v "$PWD":/in:ro debian:stable-slim sh -c 'install -o 10001 -g 10001 -m 0600 /in/backup.db /data/hush.db && rm -f /data/hush.db-wal /data/hush.db-shm' && docker compose start hush`. The helper runs as root so it can read a 0600 backup owned by your user; `docker cp` would leave the file owned by root.
   - Proxmox LXC: `pct push <CTID> backup.db /root/backup.db`, then the systemd line above that matches the unit inside the container, with `/root/backup.db`.
3. Tokens. A restore brings back every Token as it was at backup time, including Tokens revoked since then, and a Token revoked because it leaked would open current values again. With the list from step 1: run `hush token revoke "<label>"` for every Label it shows as `revoked` that `hush token list` now shows as `active`. Without it (the usual case, a lost disk): revoke every Token the restored Server lists as active, then issue new ones (`--replace` for the ones saved on your machines). Tokens are cheap to reissue; values are not.
4. What else changes: the Passphrase is the one current at backup time; Tokens issued after the backup are rejected as unknown; Items created or edited after it are gone or old. There is no unlock step.

## Recovery

### Lost Passphrase

There is no reset, and hush has no export. The Server keeps serving its Tokens, but nobody can issue, edit, delete or release, read the Audit Log or make a Passphrase backup again. Revoke and backup remain only as the host commands `hush server revoke` and `hush server backup`.

To recover the data: stand up a new Server. For each old Vault, read its values with an existing Token that covers it, into a temporary 0600 file:

```sh
hush inventory --vault Personal
hush env write recover.tpl "OPENAI=hush://Personal/OpenAI API Key/credential" "GITHUB=hush://Personal/GitHub/password"
hush env resolve recover.tpl --output recover.env
```

`inventory` lists the References; `env resolve` writes the values to `recover.env` with mode 0600. Re-create the Items on the new Server, delete the temporary files, then retire the old Server. A Vault that no live Token covers is lost. Write the new Passphrase down offline at Init.

### Leak with a database copy

Revoke and Passphrase change stop use of the live Server only. A revoked Token or a former Passphrase, together with any copy of `hush.db` taken while it was valid (a backup, a stolen disk, a vzdump image), opens that copy and every later one, because Vault keys never change in v1.

- **Leaked Token:** create a new Vault, re-enter its secrets, issue new Tokens for it, revoke the old Tokens and delete the old Vault (`hush vault delete`). `item edit` cannot move values between Vaults.
- **Leaked Passphrase:** Init a fresh Server and move every Vault the same way.

Without a database copy in the attacker's hands, Revoke or `hush passphrase change` is enough.

### Incident: someone keeps the Passphrase backoff pinned

After three wrong Passphrases the Server delays the next check, doubling up to 15 minutes. Anyone who can reach the Server can keep it there with no credential, and a restart clears it only against a passive source. Every Passphrase command then fails with `BackoffActive`; Tokens keep working.

1. Revoke the suspect Token on the Server host, which needs no Passphrase: `sudo hush server revoke --state-dir /var/lib/hush "<label>"` (Docker: `docker exec hush hush server revoke "<label>"`; LXC: through `pct exec` as above).
2. Find the source. `hush audit` needs the Passphrase, so read the denied attempts on the Server host directly, where `sqlite3` is installed:

   ```sh
   sudo sqlite3 -readonly /var/lib/hush/hush.db "SELECT at, peer FROM audit WHERE actor = 'passphrase' AND outcome = 'denied' ORDER BY id DESC LIMIT 20"
   ```

3. Block that peer with a Tailscale ACL or a firewall rule. The peer is information only: behind userspace Tailscale, `tailscale serve` or a Docker bridge it is 127.0.0.1 or the gateway, and then the tailnet ACL is the only lever.

## Security

[SECURITY.md](SECURITY.md) is the threat model: what hush defends, its trust boundaries, what it leaves to an agent sandbox, and the residual risks.

A stolen copy of the Server's state directory, a backup or a snapshot reveals every Vault, Item and Field name, every Kind and Token Label, the whole Audit Log, and each value's size rounded up to 64 bytes, but never a value: values open only with the Passphrase or a Token. A disk that also holds a token file (`~/.config/hush/tokens.json`) opens the Vaults that Token covers, so use full-disk encryption where the Server and a CLI share a disk.

## Development

```sh
bun install
bun run check        # format check, lint, typecheck and tests, as CI runs them
bun run bin/hush --help
bun run smoke        # the compiled-binary smoke test (Linux)
```

Decisions are recorded in [`docs/adr/`](docs/adr/).

## Credits

hush started as a selective copy of [2password](https://github.com/kitlangton/2password) by Kit Langton (MIT): its agent-facing command shapes, matching, env templates, write-once-then-verify and test pattern. The two files still carrying its code keep its MIT notice in their headers.

## License

[MIT](LICENSE).
