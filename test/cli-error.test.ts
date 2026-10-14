import { assert, describe, it } from "@effect/vitest"

import { CliError } from "../src/cli/CliError.js"
import {
  BrowserRequestRefused,
  CreateNotAllowed,
  FunnelRequestRefused,
  HostNotAllowed,
  NotInitialised,
  TokenRejected,
  UnsupportedContentType,
  VaultNotGranted,
} from "../src/shared/ApiError.js"

const destination = { title: "Example API Key", vault: "Personal" }

describe("CliError.render", () => {
  it("says a create whose receipt was lost may have succeeded and must not be retried", () => {
    assert.strictEqual(
      CliError.render(new CliError.CreationMayHaveSucceeded(destination)),
      'Creation may have succeeded, but its receipt could not be verified. Do not retry creation; inspect the destination with hush find "Example API Key" --vault Personal first.',
    )
  })

  it("says a create whose read-back failed is unverified, naming the Item reference", () => {
    assert.strictEqual(
      CliError.render(
        new CliError.CreationUnverified({ ...destination, ref: "hush://Personal/Example API Key/credential" }),
      ),
      'Creation is unverified. Do not retry creation; inspect the destination by title with hush find "Example API Key" --vault Personal first. Item reference: hush://Personal/Example API Key/credential.',
    )
  })

  it("suppresses the details of any other spawner failure", () => {
    assert.strictEqual(
      CliError.render(new CliError.ChildFailed({ command: "tool" })),
      "Could not run tool (details suppressed); secrets were resolved but not exposed.",
    )
  })

  it("says a request over the Server's body limit changed nothing", () => {
    assert.strictEqual(
      CliError.render(new CliError.RequestTooLarge()),
      "The request was larger than the Server accepts (1 MiB); nothing was changed. Values are limited to 64 KiB.",
    )
  })

  it("tells how to read the Init code on each deployment when the Server is NotInitialised", () => {
    assert.strictEqual(
      CliError.renderServer(new NotInitialised(), "http://127.0.0.1:7787"),
      "The hush Server at http://127.0.0.1:7787 has not been initialised; nothing was read or changed. A human reads the Init code on the Server host (systemd: `sudo cat /var/lib/hush/init-code`; Docker: `docker exec hush cat /data/init-code`; Proxmox LXC: `pct enter <CTID>`, then `cat /var/lib/hush/init-code`; the Server's startup log prints the exact path) and runs `hush init --vault <name>`.",
    )
  })

  it("renders each guard refusal with its fix, saying nothing was read or changed", () => {
    const server = "http://127.0.0.1:7787"
    assert.strictEqual(
      CliError.renderServer(new HostNotAllowed({ host: "hush.example.ts.net:7787" }), server),
      "The hush Server refused the request because it was addressed as hush.example.ts.net:7787, which is not on its allowed list; nothing was read or changed. Start it with `--allowed-host hush.example.ts.net` (or `HUSH_ALLOWED_HOSTS`), or point `HUSH_SERVER` at its IP address.",
    )
    assert.strictEqual(
      CliError.renderServer(new HostNotAllowed({ host: null }), server),
      "The hush Server refused the request because it carried no Host header; nothing was read or changed. Point `HUSH_SERVER` at the Server's IP address.",
    )
    assert.strictEqual(
      CliError.renderServer(new FunnelRequestRefused(), server),
      "The hush Server refuses requests from Tailscale Funnel (the public internet); nothing was read or changed. Turn Funnel off for this port; use the tailnet.",
    )
    assert.strictEqual(
      CliError.renderServer(new BrowserRequestRefused(), server),
      "The hush Server refuses requests carrying an Origin header, which browsers send; nothing was read or changed. Use the hush CLI.",
    )
    assert.strictEqual(
      CliError.renderServer(new UnsupportedContentType({ received: "text/plain" }), server),
      "The hush Server accepts only JSON request bodies (got text/plain); nothing was read or changed. Send `Content-Type: application/json`.",
    )
    assert.strictEqual(
      CliError.renderServer(new UnsupportedContentType({ received: null }), server),
      "The hush Server accepts only JSON request bodies (got none); nothing was read or changed. Send `Content-Type: application/json`.",
    )
  })

  describe("the complete `hush token issue` command, by where the Token came from", () => {
    const account = { user: "agent", hostname: "devbox" }

    const notGranted = new VaultNotGranted({
      vault: "Work",
      label: "claude on devbox",
      granted: [
        { vault: "Personal", access: "read+create" },
        { vault: "Shared", access: "read" },
      ],
    })

    const readOnly = new CreateNotAllowed({ vault: "Shared", label: "claude on devbox" })
    const server = "http://127.0.0.1:7787"

    it("adds --print for a Token from HUSH_TOKEN", () => {
      assert.strictEqual(
        CliError.renderServer(notGranted, server, { source: "env", account, flag: "--read" }),
        'Token claude on devbox is not granted Vault Work; nothing was read or changed. It is granted: Personal (read+create), Shared (read). If Work is right, ask the human to run: `hush token issue --label "claude on devbox" --read Work --keep-grants --replace --print`, then put the printed Token in `HUSH_TOKEN`.',
      )
      assert.strictEqual(
        CliError.renderServer(readOnly, server, { source: "env", account, flag: "--create" }),
        'Token claude on devbox has Read Access to Vault Shared, which cannot create Items; nothing was created. Ask the human to run: `hush token issue --label "claude on devbox" --create Shared --keep-grants --replace --print`, then put the printed Token in `HUSH_TOKEN`.',
      )
    })

    it("names the account whose token file holds the Token, with the form for another account", () => {
      assert.strictEqual(
        CliError.renderServer(notGranted, server, { source: "file", account, flag: "--create" }),
        'Token claude on devbox is not granted Vault Work; nothing was read or changed. It is granted: Personal (read+create), Shared (read). If Work is right, ask the human to run: `hush token issue --label "claude on devbox" --create Work --keep-grants --replace` as agent on devbox, whose token file holds this Token; from another account: `hush token issue --label "claude on devbox" --create Work --keep-grants --replace --print | sudo -u agent hush token save --stdin --replace`.',
      )
      assert.strictEqual(
        CliError.renderServer(readOnly, server, { source: "file", account, flag: "--create" }),
        'Token claude on devbox has Read Access to Vault Shared, which cannot create Items; nothing was created. Ask the human to run: `hush token issue --label "claude on devbox" --create Shared --keep-grants --replace` as agent on devbox, whose token file holds this Token; from another account: `hush token issue --label "claude on devbox" --create Shared --keep-grants --replace --print | sudo -u agent hush token save --stdin --replace`.',
      )
    })

    it("gives NoToken a Label for this account and the form for another account", () => {
      assert.strictEqual(
        CliError.render(new CliError.NoToken({ server, vault: "Work" }), { source: "file", account, flag: "--read" }),
        'No hush Token is available for http://127.0.0.1:7787 (`HUSH_TOKEN` unset, none saved for this Server); nothing was read. A human can run `hush token issue --label "agent on devbox" --read Work` as agent on devbox (the Token is saved to that account\'s token file), or from another account `hush token issue --label "agent on devbox" --read Work --print | sudo -u agent hush token save --stdin`, or set `HUSH_TOKEN`.',
      )
    })

    it("leaves out `sudo -u` when the OS has no name for this account", () => {
      const nameless = { user: undefined, hostname: "devbox" }
      assert.strictEqual(
        CliError.render(new CliError.NoToken({ server, vault: "Work" }), {
          source: "file",
          account: nameless,
          flag: "--read",
        }),
        'No hush Token is available for http://127.0.0.1:7787 (`HUSH_TOKEN` unset, none saved for this Server); nothing was read. A human can run `hush token issue --label "agent on devbox" --read Work` as this CLI\'s account on devbox (the Token is saved to that account\'s token file), or from another account `hush token issue --label "agent on devbox" --read Work --print`, then pipe the printed Token to `hush token save --stdin` run as this CLI\'s account, or set `HUSH_TOKEN`.',
      )
      assert.strictEqual(
        CliError.renderServer(readOnly, server, { source: "file", account: nameless, flag: "--create" }),
        'Token claude on devbox has Read Access to Vault Shared, which cannot create Items; nothing was created. Ask the human to run: `hush token issue --label "claude on devbox" --create Shared --keep-grants --replace` as this CLI\'s account on devbox, whose token file holds this Token; from another account: `hush token issue --label "claude on devbox" --create Shared --keep-grants --replace --print`, then pipe the printed Token to `hush token save --stdin --replace` run as this CLI\'s account.',
      )
    })
  })

  describe("TokenRejected, per reason", () => {
    const server = "http://127.0.0.1:7787"

    const rejected = (rejection: TokenRejected["rejection"]) =>
      CliError.renderServer(new TokenRejected({ rejection }), server)

    it("names HUSH_TOKEN and the token file for a missing or malformed Token", () => {
      for (const reason of ["missing", "malformed"] as const)
        assert.strictEqual(
          rejected({ reason }),
          "The request had no valid hush Token (expected `hush_...`); nothing was read. Check `HUSH_TOKEN` or the token file.",
        )
    })

    it("says an unknown Token came from another Server or an older backup", () => {
      assert.strictEqual(
        rejected({ reason: "unknown" }),
        "This Server does not know the Token (issued by another Server, or the Server was restored from an older backup); nothing was read. Ask the human for a new Token.",
      )
    })

    it("names the Label and time of a revoked or expired Token, and how to replace it", () => {
      assert.strictEqual(
        rejected({ reason: "expired", label: "agent", at: "2026-10-13T00:00:00.000Z" }),
        "Token agent was expired at 2026-10-13T00:00:00.000Z; nothing was read. Ask the human to issue a new Token (`hush token issue`), then run `hush token save --replace` or update `HUSH_TOKEN`.",
      )
    })
  })

  it("tells token save to pass --replace, and an issuing command --print too, for TokenAlreadySaved", () => {
    assert.strictEqual(
      CliError.render(new CliError.TokenAlreadySaved({ label: "agent", command: "save" })),
      "A Token for this Server is already saved (Label agent); nothing was saved. Pass `--replace` to replace it.",
    )
    assert.strictEqual(
      CliError.render(new CliError.TokenAlreadySaved({ label: "agent", command: "issue" })),
      "A Token for this Server is already saved (Label agent); nothing was issued or saved. Pass `--replace`, or `--print` to print the new Token instead.",
    )
  })
})
