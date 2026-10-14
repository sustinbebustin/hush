# Plain HTTP, on loopback or the tailnet

The Server speaks plain HTTP and relies on the network for transport security: loopback when the CLI and Server share a machine, and Tailscale (WireGuard) when they don't. TLS would close no on-path observer that loopback or WireGuard leaves open, and it would add certificate generation, pinning and redistribution, plus two confirmed Bun traps (a reload does not swap the certificate; a custom identity check can silently accept any certificate).

The bind policy is a guard against misconfiguration, not a security boundary. Binding loopback and Tailscale addresses needs no extra flag. Any other address, including `0.0.0.0` inside a bridge-networked container, needs an explicit opt-in, and the Server then warns at every start that Tokens and the Passphrase travel in cleartext. The peer address is never used for any security decision: in Docker bridge, userspace Tailscale and `tailscale serve` it is wrong. The network also does not stop a browser on the same machine or an unauthenticated tailnet peer, so the Server refuses any request with an `Origin` header, any POST that is not exactly JSON, any `Host` that is not an IP literal, `localhost` or a configured name, and any request arriving through Tailscale Funnel.

## Considered Options

- Built-in TLS with a pinned self-signed certificate.
- `tailscale serve --https` or `tailscale cert`: writes the device name to Certificate Transparency logs and hides every peer behind 127.0.0.1.
- A Unix socket as the same-machine transport: Claude Code's Linux sandbox cannot allow it by path.

## Consequences

Because Tokens carry key material, the CLI never sends a request through a non-loopback HTTP proxy. A loopback `HTTP_PROXY`, which is what an agent sandbox sets, is used automatically with `NO_PROXY` ignored for the Server, so a sandboxed same-machine agent reaches the Server with no hush-specific setting. A loopback proxy set for other reasons (a corporate NTLM bridge, a debugging proxy) would receive every Token and the Passphrase in cleartext; `HUSH_PROXY=direct` turns proxy use off and `hush doctor` names the proxy in use (ADR-0003, residual risk 8).
