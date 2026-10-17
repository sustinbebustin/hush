# The UI holds the Passphrase in memory, and the Owner reads Items with it

This amends ADR-0004 in two ways without changing the Server's rule that every human-only request carries the Passphrase and is checked on each request.

First, an Open UI keeps the Passphrase in its own process memory for the length of a session and re-sends it on every request; it is wiped after ten minutes idle, on suspend, on terminal detach and on quit, and the UI is then Locked. ADR-0004 rejected an admin session because a session held in a file or environment value is readable by any same-user agent. Memory of a foreground process is not, short of ptrace, which already captures the Passphrase at the CLI's prompt (ADR-0003). The Server still runs Argon2 and the backoff on every request, so nothing on the Server side resembles a session.

Second, the Owner can list Items in a Vault (with its Retired titles), Reveal one Field and create an Item under the Passphrase (`admin/items/list`, `admin/items/reveal`, `admin/items/create`, also `hush item list|reveal|create`). Before this the Owner could only browse or add Items by issuing themselves a Token, which would sit in the token file with Read on every Vault, exactly the credential ADR-0007 keeps narrow. Every Reveal is one Audit Log row naming the Reference, so `read` is no longer the only command that prints a value.

## Considered Options

- Prompt for the Passphrase on every operation: the Server's rule applied literally; every edit, delete and revoke in the UI would ask again.
- An Owner-issued all-Vault Token for the UI's reads: no Server change, but a same-user agent could use it.
- A metadata-only UI: no Items at all, which does not meet the goal.

## Consequences

The held Passphrase is only ever as safe as the terminal it was typed into; the recipe in SECURITY.md (no agent in the Owner's shell) applies to the UI as it does to the CLI. The three new endpoints are human-only and never reachable with a Token; the skill lists them with the other Passphrase commands.
