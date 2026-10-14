import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Forward-only migrations. Each statement is its own `sql` call: a multi-statement
// string would run only its first statement. Keys are `<id>_<name>` for `SqliteMigrator.fromRecord`.

const init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      format INTEGER NOT NULL CHECK (format = 1),
      kdf_version INTEGER NOT NULL CHECK (kdf_version = 1),
      kdf_memory_kib INTEGER NOT NULL CHECK (kdf_memory_kib >= 65536),
      kdf_passes INTEGER NOT NULL CHECK (kdf_passes >= 3),
      kdf_parallelism INTEGER NOT NULL CHECK (kdf_parallelism >= 1),
      kdf_salt BLOB NOT NULL CHECK (length(kdf_salt) = 16),
      mk_nonce BLOB NOT NULL CHECK (length(mk_nonce) = 12),
      mk_wrapped BLOB NOT NULL CHECK (length(mk_wrapped) = 48),
      initialised_at TEXT NOT NULL,
      passphrase_changed_at TEXT NOT NULL
    ) STRICT`
  yield* sql`
    CREATE TABLE vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      key_nonce BLOB NOT NULL CHECK (length(key_nonce) = 12),
      key_wrapped BLOB NOT NULL CHECK (length(key_wrapped) = 48),
      created_at TEXT NOT NULL
    ) STRICT`
  yield* sql`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (vault_id, title_key)
    ) STRICT`
  yield* sql`
    CREATE TABLE fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      label_key TEXT NOT NULL,
      nonce BLOB NOT NULL CHECK (length(nonce) = 12),
      sealed BLOB NOT NULL CHECK (length(sealed) >= 80 AND (length(sealed) - 16) % 64 = 0),
      updated_at TEXT NOT NULL,
      UNIQUE (item_id, label_key)
    ) STRICT`
  yield* sql`
    CREATE TABLE tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash BLOB NOT NULL UNIQUE CHECK (length(hash) = 32),
      wrap_salt BLOB NOT NULL CHECK (length(wrap_salt) = 16),
      label TEXT NOT NULL,
      label_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT
    ) STRICT`
  yield* sql`CREATE UNIQUE INDEX tokens_active_label ON tokens(label_key) WHERE revoked_at IS NULL`
  yield* sql`
    CREATE TABLE token_vaults (
      token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      access TEXT NOT NULL CHECK (access IN ('read', 'read+create')),
      key_nonce BLOB CHECK (key_nonce IS NULL OR length(key_nonce) = 12),
      key_wrapped BLOB CHECK (key_wrapped IS NULL OR length(key_wrapped) = 48),
      CHECK ((key_nonce IS NULL) = (key_wrapped IS NULL)),
      PRIMARY KEY (token_id, vault_id)
    ) STRICT`
  yield* sql`CREATE INDEX token_vaults_vault ON token_vaults(vault_id)`
  yield* sql`
    CREATE TRIGGER tokens_revoke_drops_wraps AFTER UPDATE OF revoked_at ON tokens
    WHEN NEW.revoked_at IS NOT NULL
    BEGIN
      UPDATE token_vaults SET key_nonce = NULL, key_wrapped = NULL WHERE token_id = NEW.id;
    END`
  yield* sql`
    CREATE TABLE retired_titles (
      vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      title_key TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      PRIMARY KEY (vault_id, title_key)
    ) STRICT`
  yield* sql`
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
      actor TEXT NOT NULL CHECK (actor IN ('init', 'passphrase', 'host', 'token')),
      token_id INTEGER,
      token_label TEXT,
      action TEXT NOT NULL,
      vaults TEXT NOT NULL,
      refs TEXT NOT NULL,
      detail TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
      error TEXT,
      peer TEXT,
      CHECK ((actor = 'token') = (token_id IS NOT NULL AND token_label IS NOT NULL)),
      CHECK ((outcome = 'ok') = (error IS NULL)),
      CHECK (count = 1 OR (actor = 'token' AND outcome = 'denied'))
    ) STRICT`
  yield* sql`CREATE INDEX audit_token ON audit(token_id, id) WHERE token_id IS NOT NULL`
})

export const migrations = { "0001_init": init } as const
