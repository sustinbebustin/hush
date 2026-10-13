# Always client-server, even on one machine

hush always runs as a Server plus the CLI, also when both share a machine; the CLI never opens the database file. The Server is the only place that enforces each Token's Grants and Access, Revoke, expiry and the Audit Log, and the only process that handles keys, so a second "local" mode would be a weaker parallel code path rather than a simplification. On a shared machine this holds only because the Server runs under its own OS user, never the Owner's or an agent's, so a same-user process cannot read the database or replace the Server.

## Considered Options

- Direct-file local mode (the psst or SOPS shape): no Revoke without re-keying, no trustworthy Audit Log, and scope enforced only by putting a key or the Passphrase in every agent's process.
- OpenBao as the Server: not the Owner's own repo, and it has no batch resolve or `run`.

## Consequences

A resident process costs about 15-19 MB and starts in a few milliseconds. On Linux a sandboxed agent reaches a same-machine Server only through its sandbox's proxy, so the Server's `IP:port` goes in the sandbox allowlist; the CLI uses a loopback proxy automatically (ADR-0006).
