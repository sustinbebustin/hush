# Security

This is hush v1's threat model: what it defends, where it trusts, what it leaves to tools outside hush, and the risks that remain. The reasoning behind it is in [ADR-0003](docs/adr/0003-threat-model-v1.md).

## Defended

- **A stolen disk, backup or snapshot of the Server.** Values open only with the Passphrase or a Token. See [What a stolen copy reveals](#what-a-stolen-copy-reveals).
- **A misused Token, a hijacked agent included,** as bounded damage, not prevention. The holder can do at most what the Token's Grants allow (Read, or Read+Create, per Vault). It can never change or delete an existing Item or take a Retired title. Revoke or expiry stops it, and Revoke works even while the Passphrase backoff is pinned, as the host command `hush server revoke`. Every use is in the Audit Log. Agents are separated from each other only when they hold different Tokens.
- **Hostile web content and unauthenticated peers.** A browser page, DNS rebinding included, is refused by the `Host`, `Origin` and `Content-Type` checks, and requests through Tailscale Funnel are refused. A tailnet or LAN device without a credential gets only `status`, cannot Init without the Init code (which lives on the Server host), and is slowed by the Passphrase backoff. Under userspace Tailscale every peer arrives on loopback, so only these checks and a Tailscale ACL protect the Server there.
- **Accidental echo of a value into an agent transcript,** best effort. `hush run` and `hush env run` mask concealed values of 8 bytes or more on the child's piped output. `hush read` and `hush env resolve` are never masked.

## Trust boundaries

- **The Server host is trusted while it runs.** Root there, live memory capture and core dumps are out of scope; such an attacker gets the keys of the requests it observes. The unit and the image disable core dumps; keep swap encrypted or off on the Server host. Commands run on the Server host (`hush server revoke`, `hush server backup`) act on its files directly, as root or the owner of `hush.db`.
- **On the CLI side the boundary is the OS user, not root.** Anything running as the user who holds the token file or types the Passphrase, an agent included, can use that saved Token and can capture the Passphrase (through a fake `hush` earlier on `PATH` or an edited shell rc file). Run Passphrase commands (`hush init`, `vault`, `item`, `token issue|list|revoke`, `audit`, `backup`, `passphrase change`, `ui`) in an account or shell no agent uses. To keep an agent away from your own Token, use the [isolation recipe](#agent-isolation-recipe).
- **An Open `hush ui` holds the Passphrase in its process memory** and sends it with every request, under the same terminal trust as the CLI's prompt: whatever can read that process's memory (ptrace as the same user, root) or the terminal could already capture the Passphrase as it is typed ([ADR-0010](docs/adr/0010-ui-holds-the-passphrase-in-memory.md)). It drops it and Locks after ten minutes without a key and on Ctrl-Z, and drops it on exit. A Revealed value and a freshly issued Token are drawn on the terminal's alternate screen, which scrollback does not keep, but the terminal itself, a screen recorder or a shared session still sees them while they are shown.

The token file `~/.config/hush/tokens.json` (directory 0700, file 0600) is weaker than a macOS Keychain entry. Any process running as your user can read it, and a disk that also holds `hush.db` opens the Vaults it covers. hush keeps a file anyway because an OS keyring does not separate processes of one user either, and a plain file is what an agent sandbox can deny by path. When `HUSH_TOKEN` is set, the file is never opened.

## Not defended

**Prompt-injected exfiltration of a secret the agent is allowed to use,** for example `hush run` with a command that sends the value elsewhere. `run` must hand the value to a child process, and this is the attack seen most in practice. The mitigations live outside hush: the agent sandbox's network egress allowlist, and vendor credential masking. hush stays compatible with both (`HUSH_TOKEN`, plain HTTP through the sandbox's proxy). Give an agent only the Vaults its task needs.

Also not defended: root or memory capture on the Server host, and a same-user agent running without a sandbox (see Trust boundaries).

## Residual risks

1. **Copies outlive Revoke.** Until a Vault is re-keyed (a later addition), a revoked Token or a former Passphrase plus any copy of `hush.db` taken while it was valid opens that Vault in that copy and every later one. Recovery is in the README, [Leak with a database copy](README.md#leak-with-a-database-copy).
2. **A restore brings back revoked Tokens.** Restoring a backup reinstates Tokens revoked after it was taken. If the old Server's `hush token list` cannot be saved first, revoke and reissue every Token the restored database lists as active ([Restore](README.md#restore)).
3. **The Init code before Init.** Whoever can read the Server's state directory before Init (root, the Server's user, members of the `docker` group) can take the Init code. A hostile Init shows: your own `hush init` then fails with `AlreadyInitialised`. Init right after the first start.
4. **A same-user agent without a sandbox** holds your saved Token and can capture the Passphrase.
5. **A shared disk.** A disk holding both the database and a token file needs full-disk encryption.
6. **Masking is best effort.** It misses encoded, transformed and short values, and is never permission to print one.
7. **A full disk.** A Token holder can fill the Server's disk with audited requests until it is revoked, and a full disk stops every request because the Audit Log fails closed. Requests from revoked or expired Tokens are counted rather than logged one by one, so Revoke bounds this. Set a disk-usage alert.
8. **A non-sandbox loopback proxy.** The CLI sends requests through a loopback `HTTP_PROXY` automatically, which is how a sandboxed agent reaches a same-machine Server. A loopback proxy that is not an agent sandbox's (cntlm, px, mitmproxy, Charles, Fiddler, a VPN client) therefore receives Tokens and the Passphrase in cleartext. Turn proxy use off with `HUSH_PROXY=direct` or `hush config set proxy direct`; `hush doctor` names the proxy in use. A non-loopback proxy is never used.

## Incident: a pinned Passphrase backoff

Anyone who reaches the Server can keep the Passphrase backoff pinned without a credential, which blocks every Passphrase command (Tokens keep working). Revoke the suspect Token on the Server host with `hush server revoke`, which needs no Passphrase, then read the source of the denied attempts on the Server host and block it with a Tailscale ACL or firewall rule. The exact commands are in the README, [Incident](README.md#incident-someone-keeps-the-passphrase-backoff-pinned).

## What a stolen copy reveals

A stolen copy of the Server's state directory, a backup or a snapshot reveals every Vault, Item and Field name, every Kind and Token Label, the whole Audit Log, and each value's size rounded up to 64 bytes, but never a value: values open only with the Passphrase or a Token. A disk that also holds a token file (`~/.config/hush/tokens.json`) opens the Vaults that Token covers, so use full-disk encryption where the Server and a CLI share a disk.

## Agent isolation recipe

**Status: pending a sandbox run.** This recipe is not called supported until it has run in a real Claude Code sandbox (the manual check in [`test/sandbox-spike.ts`](test/sandbox-spike.ts)). It is recommended, not required: without it, an agent running as your user can use your saved Token.

Give each agent its own Token, holding only the Grants it needs, and keep your token file out of its reach.

1. Issue the agent's Token from your own shell, printed instead of saved:

   ```sh
   hush token issue --label "claude on dev-vm" --read Work --print | jq -r .token
   ```

2. Launch the agent with `HUSH_TOKEN=<its Token>` and `HUSH_SERVER=http://<ip>:7787`, in its launcher or in the `env` of your Claude Code settings. Inside the sandbox the CLI uses the sandbox's loopback proxy automatically, so `HUSH_PROXY` must not be `direct` there.
3. Then pick one of the two supported options.

**Claude Code's sandbox.** In your user settings (`~/.claude/settings.json`, so the denies hold in every project and still apply when a repository's settings are excluded), deny the token file to sandboxed commands and to the file tools, and allow the Server's exact address:

```json
{
  "env": { "HUSH_TOKEN": "<its Token>", "HUSH_SERVER": "http://<ip>:7787" },
  "permissions": { "deny": ["Read(~/.config/hush/**)"] },
  "sandbox": {
    "enabled": true,
    "filesystem": { "denyRead": ["~/.config/hush/tokens.json"] },
    "network": { "allowedDomains": ["<ip>:7787"] }
  }
}
```

`sandbox.credentials` with the file in `deny` mode works in place of `filesystem.denyRead`.

**A separate Linux user.** Run the agent as its own user, which has no token file of yours to read, and give it `HUSH_TOKEN` and `HUSH_SERVER` as above.

**Codex: untested.** A Codex permissions profile that denies reading `~/.config/hush` and allows the Server's literal IP may work, but no Codex case has been run. Codex's proxy allowlists hosts only, sets `NO_PROXY=""` when `allow_local_binding=false`, and is off by default.

That sandbox run also confirms that the route needs no hush setting inside the sandbox, and that a `HUSH_PROXY=direct` in Claude Code's settings `env` reaches sandboxed commands; if you set it for a corporate proxy, unset it there.

Limits:

- Sandboxes cover shell commands only. Hooks, MCP servers and other tools run outside them with your full access.
- `HUSH_TOKEN` is visible in `/proc` to unsandboxed processes of the same user.
- Admin work still belongs in an account or shell no agent runs in.
