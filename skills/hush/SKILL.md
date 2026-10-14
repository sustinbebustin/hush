---
name: hush
description: Use for any password, API key, token, credential or secret task, including finding credentials, injecting them into commands or env files and saving new secrets. Prefer hush over reading .env files.
metadata:
  author: sustinbebustin
---

# hush

`hush` is a self-hosted secret store you use without seeing the secrets. You hold one Token with fixed Grants (Vault plus Access: `read` or `read+create`); everything else belongs to the human, who has the Passphrase. Results are JSON on stdout; errors are one `hush: <message>` line on stderr with exit 1, and the message names the next step.

## Rules

- Values stay out of the conversation: never print, log, summarise or repeat one. Pass `hush://Vault/Item/field` References around instead.
- Batch: many queries in one `hush find`, many References in one template for `hush env run`. Each command is one Server request.
- Run the command you need directly. The command itself is the capability check, so skip `hush status`, `hush doctor` and every other preflight.
- A write runs once. After a write that failed or said unverified, run `hush find` to see whether it happened; never retry it.
- The Passphrase and the Init code are the human's alone: never ask for, type or pipe either. Human-only commands are `hush init`, `hush passphrase`, `hush vault`, `hush item`, `hush token issue`, `hush token list`, `hush token revoke`, `hush audit`, `hush backup` and `hush server`; when one is needed, give the human the exact command.
- Values enter hush through `--stdin` (piped) or `--clipboard` (macOS) only; `--prompt` is for humans at a terminal. Never put a value in an argument, a command substitution or a temporary file.

## Find credentials

```bash
hush find openai anthropic "github actions"   # many queries, one request
hush find stripe --vault Work                  # only one Vault
```

Each match appears once as `{ ref, title, kind }`, with `queries` when you asked several. A query that matches nothing returns `suggestions` with close titles (typos included) from the same lookup: use those rather than searching again. Without `--vault`, every granted Vault is searched. Values are never returned.

## Use credentials

```bash
hush run --env "OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential" -- bun run dev
hush env write .env.tpl "OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential" "STRIPE_KEY=hush://Work/Stripe API Key/credential"
hush env run .env.tpl -- bun run dev            # preferred: no plaintext on disk
hush env resolve .env.tpl --output .env         # only when a tool requires a real file (mode 0600)
hush read "hush://Personal/OpenAI API Key/credential"   # last resort: prints the value
```

- All References of a template resolve in one request. Use one `hush env run` rather than a loop over `hush read`.
- A `.env.tpl` of References is safe to read; a resolved `.env` is plaintext.
- The child of `hush run` or `hush env run` receives plaintext in its environment, so it is a trusted consumer of the secret. Inject into the program that needs the value, never into environment dumps, debug commands or anything whose purpose is to show the value.
- Concealed values of 8 bytes or more are masked in the child's piped output. Masking is a best-effort safety net (exact bytes only; encoded or transformed values pass), not permission to print.
- `hush run` and `hush env run` exit with the child's exit code.

## Save a new secret

```bash
some-command-that-prints-a-key | hush create api-credential --title "OpenAI API Key" --vault Personal --stdin
hush create api-credential --title "OpenAI API Key" --vault Personal --clipboard
hush create login --title "GitHub work-account" --vault Work --username me@example.com --clipboard
hush create database --title "Postgres staging" --vault Work --host 10.0.0.5 --port 5432 --database app --username app --stdin
```

- Kinds: `api-credential` (secret Field `credential`), `login` and `database` (secret Field `password`). Plain flags such as `--username`, `--host`, `--port`, `--database` and `--notes` take non-secret metadata only.
- `--vault` is required: use the Vault the user names, or their documented default; ask if neither exists.
- Never read the clipboard into the conversation first.
- Success is exit 0 with `"verified": true`. Reuse the returned `ref`; do not `hush read` it to check.
- A taken title is refused and nothing is ever overwritten. Changing an existing Item is a human command (`hush item edit`).

## Inventory

```bash
hush inventory               # every granted Vault
hush inventory --vault Work
```

Returns `vaults` (each granted Vault with its Access, empty ones included) and `items` (title, Vault, Kind, times, and each Field's label, `concealed` and `ref`). Never values.

## Which Vaults can I use

Run these when the task needs the answer, not as a preflight:

- `hush token status`: your Token's Label, Grants with Access, expiry, and whether it came from `HUSH_TOKEN` or the token file.
- `hush inventory`: the granted Vaults and what is in them.

## When hush says

Read the whole message: it says what was not changed and the next step, and every command it gives is complete.

- `NotInitialised`: the Server has never been set up. Stop and tell the human; only they can run `hush init`.
- `VaultNotGranted`: check `granted` and `Did you mean` for a typo in the Vault name and retry with the right one. If the Vault was right, give the human the exact `hush token issue` command from the message.
- `NoToken`, `CreateNotAllowed`: give the human the exact command from the message; it names the account and machine it must run on.
- `TitleRetired`: a rename or delete freed that title. Choose another title, or ask the human to run the `hush item release` command from the message.
- `ItemExists`: run the `hush find` from the message; reuse the existing Item or choose another title.
- `ReferenceNotFound`: often an Item was renamed. Use the suggestions in the message, or `hush find` for current References.
- `ServerUnreachable`: run `hush doctor` and show the human its output.
- `TokenRejected`: your Token is missing, unknown, revoked or expired. Stop and ask the human for a new Token.
- `TokenEnvInvalid`, `TokenFileInvalid`, `TokenFileInsecure`: the credential setup is broken. Show the human the message; hush tries no other Token.
- `CreationMayHaveSucceeded`, `CreationUnverified`: never retry. Run the `hush find` from the message first and report what it shows.
- `InvalidName`, `InvalidReference`, `InvalidAssignment`, `EnvFileInvalid`, `UnknownField`, `InputEmpty`: fix your input and run the command again.
- `NoTerminal`: you ran a human-only command. Give it to the human instead.
- `IntegrityCheckFailed`, `AuditUnavailable`, `UnexpectedResponse`: tell the human; the Server needs attention.

## Item conventions

- API keys: Kind `api-credential` (Field `credential`), titled `<Provider> API Key` or `<Provider> <Purpose> API Key`.
- Logins: Kind `login` (Field `password`), titled `<Provider>` or `<Provider> <Account>`.
- Databases: Kind `database` (Field `password`), titled `<Service> <Environment>`.
- One current secret value per Item; a new value for an existing Item is the human's `hush item edit`.
- The Vault already says who owns the Item, so the title never repeats the Vault name.

## Setup for the human

When hush is not set up, point the human here rather than doing it yourself:

- Install the binary and run a Server per the [README](https://github.com/sustinbebustin/hush#readme).
- Give each agent its own Token in `HUSH_TOKEN` (`hush token issue --label "<agent> on <host>" --read <vault> --print`), with `~/.config/hush/tokens.json` denied in the agent's sandbox and the Server's `ip:port` allowed. The full recipe is in [SECURITY.md](https://github.com/sustinbebustin/hush/blob/main/SECURITY.md).
- Install this skill: copy `skills/hush` to `~/.claude/skills/hush`, or run `bunx skills add sustinbebustin/hush`.

## Report anything that goes poorly

hush is built for agents, so your experience is how it improves. Speak up when a command fails unexpectedly, you had to work around it, output was awkward, or this skill was unclear or wrong. Tell the user and offer to open an issue; it posts from their GitHub account, so get their okay first.

```bash
gh issue list --repo sustinbebustin/hush --state all --search "<keywords>"   # add to an existing issue instead of duplicating it
gh issue create --repo sustinbebustin/hush --title "<what went wrong>" --body "<details>"
```

Include the output of `hush doctor` (versions and setup; it never prints secrets, names or the Server address), the command you ran with placeholders, and what you expected versus what happened. Never include values, titles, Vault names or References: replace them with placeholders.
