# Tokens carry the Vault keys; the Server keeps no key and never locks

Each Vault has its own random key. It is stored wrapped under a master key, which is itself wrapped under a key derived from the Passphrase, and wrapped again under each Token granted that Vault. A Token request derives its wrap key from the Token, opens only the Vault keys that request needs and drops them; a human operation does the same from the Passphrase. The Server therefore holds no key between requests, there is no Locked state, a restart needs no human step, and a stolen Server disk or backup opens nothing by itself.

This replaces the earlier draft, in which the Server started Locked after every restart until a human typed the Passphrase. That made every reboot, crash and upgrade stop every agent, against 2password's first priority (fewest interruptions). It is the default of owner call OC-1; choosing the Locked design instead would restore that draft.

## Considered Options

- Passphrase Unlock after every restart (the earlier draft).
- Automatic unlock from a key file, a Docker secret, a systemd-creds host key or a Proxmox vTPM: each puts the unlocking secret where a disk copy or vzdump backup also reaches it.
- Client-side decryption (Bitwarden style): moves the cryptography into the CLI, away from 2password's seam.

## Consequences

- Vault keys and the master key never change in v1. Until a Vault is re-keyed, a revoked Token or a former Passphrase plus any copy of the database taken while it was valid yields keys that open that Vault in every later copy as well: new backups, a stolen disk, a snapshot. Revoke and Passphrase change stop use of the live Server, not decryption of copies. If a leaked Token or Passphrase may come with a database copy, the v1 recovery is a new Vault with its secrets re-entered and new Tokens, then deleting the old Vault; for the Passphrase, a fresh Server. Re-keying is a named later addition.
- Where the Server and a token file share a disk, that disk opens every Vault the saved Token covers; full-disk encryption is the defence there.
- A lost Passphrase has no reset. The Server keeps serving its Tokens, but nobody can issue, edit, delete or read the Audit Log again, and Revoke and backup remain only as commands run on the Server host. Recovery is a new Server whose Items are re-created from values read with existing Tokens. The Owner should write the Passphrase down offline at Init.
