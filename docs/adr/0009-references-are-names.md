# References are names, not IDs

A Reference is `hush://` followed by exactly three names, Vault, Item and Field, matched case-insensitively. There are no IDs, escaping, percent-decoding, query or section forms, and output always uses the stored names. Templates and Audit Log rows stay readable, and an agent can predict a Reference such as `hush://Work/Stripe API Key/credential` on the first try. hush uses its own scheme rather than `op://` so that no 1Password tool, secret scanner or leftover 2password install acts on it, and so a mixed file shows which backend owns each line.

Renaming an Item breaks its old References on purpose: the rename receipt prints old and new, and resolving an old one fails with near-miss suggestions. Vault and Field rename are left out of v1.

## Considered Options

- Stable public IDs in References, or 1Password's name-or-ID hybrid: templates and audit rows become opaque, and one Field gets two spellings.
- Aliases kept on rename: hidden state that collides when a new Item later takes the old name.
- Reusing `op://`.
- Percent-encoded segments: a decoding layer with no 1Password precedent.

## Consequences

Names cannot contain `/` or control characters. A freed title is retired (ADR-0008), so an old Reference cannot silently resolve to a newly created Item.
