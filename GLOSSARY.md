# hush

A self-hosted secret store that lets coding agents use secrets without seeing them.

## Language

### Runtime

**Server**:
The single process that holds the encrypted secrets and answers every request for them, on the same machine as its users or on another one.
_Avoid_: daemon, backend, host

**Server host**:
The machine, container or LXC the Server runs on; whoever controls it can read the Server's files.
_Avoid_: server machine, node, box

**CLI**:
The `hush` command that people and agents run; it never stores secrets itself and talks only to a Server.
_Avoid_: client, agent tool

**Owner**:
The one person who runs a Server and holds its Passphrase; every human-only operation is theirs.
_Avoid_: admin, operator, user

### Secrets

**Vault**:
A named collection of Items, and the unit a Token is granted.
_Avoid_: folder, project, namespace

**Item**:
One named thing in a Vault, such as an API credential or a database login, made up of Fields.
_Avoid_: entry, secret, record

**Kind**:
What sort of thing an Item is, which fixes its Field labels and which of them is concealed: api-credential, login or database.
_Avoid_: category, type, template

**Field**:
A single labelled value inside an Item; each Item has one concealed Field that holds its secret, and the others are plain.
_Avoid_: key, attribute, secret

**Reference**:
The address of one Field, written `hush://Vault/Item/field`, which agents pass around in place of the value.
_Avoid_: URI, path, pointer

**Retired title**:
An Item title freed in its Vault by a rename or delete, which no Token may take again until the Owner releases it.
_Avoid_: reserved name, tombstone

### Access

**Token**:
A credential that lets its holder, an agent or a human, use a fixed set of Vaults, one Grant each; it carries the key that opens those Vaults, and everyday use never needs the Passphrase.
_Avoid_: agent token, service account, API key, machine identity

**Grant**:
One Vault together with the Access a Token has to it, chosen when the Token is issued and never changed.
_Avoid_: permission, scope, binding

**Access**:
What a Grant allows in its Vault: Read, or Read+Create, where Create means adding new Items and never changing or deleting existing ones.
_Avoid_: role, permission level

**Label**:
The human-chosen name of a Token, such as "claude on dev-vm", which identifies it in the Audit Log and when revoking.
_Avoid_: token name, description

**Revoke**:
Permanently invalidating one Token so that it can open nothing; the normal way a Token stops working.
_Avoid_: delete, disable

**Audit Log**:
The permanent record of every request made with a known Token, every Passphrase check, Init and every Revoke on the Server host, readable only with the Passphrase and never containing secret values.
_Avoid_: history, access log, events

### Server state

**Passphrase**:
The human-held secret from which the key that wraps every Vault key is derived; it is never written to disk.
_Avoid_: master password, password

**Uninitialised**:
The state of a fresh Server that has no Passphrase yet and refuses everything except status and Init.
_Avoid_: empty, new, unconfigured

**Init**:
The one-time act of giving a fresh Server its Passphrase, authorised by the Init code.
_Avoid_: setup, bootstrap, register

**Init code**:
The one-time secret an Uninitialised Server keeps on the Server host, which Init must present and which stops existing once Init succeeds.
_Avoid_: setup code, bootstrap token, PIN

**Ready**:
The state of an initialised Server, which serves every authorised request from the moment it starts, with no human step after a restart.
_Avoid_: unlocked, unsealed, running
