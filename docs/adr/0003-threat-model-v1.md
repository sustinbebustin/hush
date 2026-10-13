# Threat model for v1

v1 names what it defends, what it only bounds, and what it leaves to tools outside hush, so the spec never promises isolation that only a sandbox or a separate OS user provides.

## Defended

- **A stolen disk, backup or snapshot of the Server.** Values open only with the Passphrase or a Token (ADR-0002). Names, Kinds, Labels, the Audit Log and approximate value sizes are readable (ADR-0007).
- **A misused Token, a hijacked agent included.** This is bounded damage, not prevention. The holder can do at most what the Token's Grants allow, can never change or delete existing Items or take a Retired title, can be stopped by Revoke or expiry, and every use is in the Audit Log. Agents are separated only when they hold different Tokens.
- **Hostile web content and unauthenticated network peers.** A browser page, including one using DNS rebinding, is refused by the Origin, Content-Type and Host checks. A tailnet or LAN device without a credential gets only `status`, cannot Init without the Init code, and is slowed by the Passphrase backoff. Under userspace Tailscale every peer arrives on loopback, so only these checks and a Tailscale ACL protect the Server there.
- **Accidental echo of a value into an agent transcript**, best effort: `run` and `env run` mask injected values on piped output.

## Trust boundaries

- The Server host is trusted while it runs. Root there, live memory capture and core dumps are out of scope; such an attacker gets the keys of the requests it observes. Commands run on the Server host act on its files directly (ADR-0005).
- On the CLI side the boundary is the OS user, not root. Anything running as the user who holds the token file or types the Passphrase, including an agent, can use that saved Token and can capture the Passphrase (through a fake `hush` earlier on PATH or an edited shell rc file). hush ships a tested recipe that separates agents: a per-agent `HUSH_TOKEN` with the token file denied in the agent's sandbox, or a separate Linux user. It is recommended, not required (owner call OC-4).

## Not defended in v1

Prompt-injected exfiltration of a secret the agent is allowed to use, for example `run` with a command that sends the value elsewhere. `run` must inject into a child (a hard requirement), and this is the attack class seen most in practice. The mitigations live outside hush, in the agent sandbox's egress allowlist and vendor credential masking; hush stays compatible with them. An egress broker is a possible later addition.

## Residual risks

1. Until a Vault is re-keyed, a revoked Token or a former Passphrase plus any database copy taken while it was valid opens that Vault in every later copy (ADR-0002).
2. Restoring a backup brings back Tokens revoked after it was taken. If the old Server's Token list cannot be read, every Token the restored database lists as active is revoked and reissued.
3. Whoever can read the Server's state directory before Init (root, the Server's user, docker group members) can take the Init code. A hostile Init is detected because the Owner's own Init then fails.
4. A same-user agent without a sandbox holds the saved Token and can capture the Passphrase.
5. A disk holding both the database and a token file needs full-disk encryption.
6. Masking misses encoded, transformed and short values.
7. A Token holder can fill the Server's disk with audited requests until it is revoked, and a full disk stops every request because the Audit Log fails closed. Requests from revoked or expired Tokens are counted, not logged one by one, so Revoke bounds this.
8. The CLI sends requests through a loopback `HTTP_PROXY` automatically, which is how a sandboxed agent reaches a same-machine Server. A loopback proxy that is not an agent sandbox's (cntlm, px, mitmproxy, Charles, Fiddler, a VPN client) therefore receives Tokens and the Passphrase in cleartext unless `HUSH_PROXY=direct` is set; `hush doctor` names the proxy in use. A non-loopback proxy is never used.
