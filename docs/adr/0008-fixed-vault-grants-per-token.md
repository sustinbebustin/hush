# Tokens hold a fixed set of Grants, Read or Read+Create

Each Token is issued with a fixed set of one or more Grants. A Grant is one Vault with Read or Read+Create Access, and Create only adds an Item under an unused title; it never edits, deletes or takes over an existing one. To change a Token's Grants, the Owner issues a replacement, which revokes the old Token in the same step and can keep its Grants.

- **Why sets, not one Vault per Token:** an isolated agent holds exactly one Token (`HUSH_TOKEN`), and a template mixing Vaults must resolve in one request without copying secrets between Vaults.
- **Why fixed:** a Grant is cryptographic (the Vault key is wrapped under the Token), so adding a Vault later would need the Token's own secret, which the Server never keeps. 1Password service accounts behave the same way.
- **Why no update Access:** a misused Token can add clutter, but it can never destroy a working credential or redirect what an existing Reference resolves to. Changing a stored value is a human step with the Passphrase.

## Considered Options

- One Vault per Token, with a dedicated agent Vault per agent.
- Mutable Grants (`token grant`).
- Read+Write Access including update and delete (1Password's `write_items`).

## Consequences

A title freed by renaming or deleting an Item becomes a Retired title. Tokens cannot create it again until the Owner releases it, so an old Reference fails instead of silently resolving to a value someone else stored.
