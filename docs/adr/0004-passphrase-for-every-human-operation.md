# The Passphrase authorises every human-only operation

Every human-only operation over the API carries the Passphrase and is checked on each request: Init, Passphrase change, Vault create, list and delete, Item edit, rename, delete and release, Token issue, list and revoke, reading the Audit Log, and backup. The CLI reads it from a hidden prompt on the terminal or from piped stdin, never from arguments or the environment. There is no admin token, no admin session and no admin channel based on where a request comes from. Agents never perform these operations, and the Passphrase is the only factor a same-user agent cannot obtain by reading files.

What this stops: an agent escalating opportunistically or under prompt injection, by issuing itself a Token, deleting Items or reading the Audit Log. What it does not stop: a same-user process that deliberately captures the Passphrase as it is typed. Admin work belongs in an account or shell where no agent runs (ADR-0003).

One deliberate exception: `hush server revoke` and `hush server backup` run on the Server host against the Server's files and need no Passphrase, because only the Server's own user or root can run them, and either can already read the whole database. They exist so the Owner can Revoke a Token while someone holds the Passphrase backoff, and so backups can run unattended. They are not requests and add no network path.

## Considered Options

- A Passphrase-minted admin session: for its lifetime it is a file or environment value any same-user agent can read, and a prompt-injected `token issue` during that window takes full control silently.
- A long-lived admin token: undoes the misused-Token defence.
- Admin by locality (Unix socket or Server host only) as the network path: the Server cannot see a peer's OS user, and it forces an SSH hop for routine work.
- Tailscale identity: it identifies devices, not a human at a keyboard.

## Consequences

The Passphrase crosses the wire on every admin request, which is one reason the Server stays on loopback and the tailnet (ADR-0005) and request bodies are never logged.
