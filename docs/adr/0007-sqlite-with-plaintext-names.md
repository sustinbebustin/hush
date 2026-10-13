# One SQLite file, values encrypted per Field, names in plaintext

The Server keeps everything, the Audit Log included, in one SQLite file. Each Field value is padded and encrypted on its own under its Vault's key, bound to the row it belongs to. Names stay in plaintext, so `find`, case-insensitive uniqueness and the Audit Log work with plain SQL and need no key. One file also lets an Item create commit atomically with its audit row.

A stolen copy of the file reveals every Vault, Item and Field name, every Kind and Token Label, and the whole Audit Log, including the names of deleted Items and when each was used. It also reveals each value's size, rounded up to 64 bytes. It never reveals a value. This is the default of owner call OC-2.

## Considered Options

- SQLCipher or SQLite3 Multiple Ciphers: neither can be loaded through `bun:sqlite` on Linux, and `bun:sqlite` silently accepts `PRAGMA key` while writing plaintext, so a misconfiguration would fail open.
- Encrypting Item and Field names as well: the cost spreads across `find`, uniqueness (an HMAC index), the Audit Log (sealed References) and debugging, and because the Server holds no key at rest (ADR-0002), every name lookup would need a Token or the Passphrase.
- One encrypted blob file (KeePass style): a create could not commit with its audit row, and every write rewrites the whole file.

## Consequences

The storage hygiene is not optional: secure delete, foreign keys and full sync on every connection, files created mode 0600, a WAL checkpoint after every write that retires a key or a value, and backups made only by `VACUUM INTO`, never by copying a live file.
