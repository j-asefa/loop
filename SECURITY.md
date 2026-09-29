# Security

## Reporting a vulnerability

Report vulnerabilities privately through **Security → Report a vulnerability** on the [GitHub repository](https://github.com/j-asefa/loop/security). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected version or commit, the mode you run (laptop workspace, single-user server or multi-user server), steps to reproduce and the impact you expect. We aim to acknowledge reports within a week.

## Supported versions

Loop is pre-1.0. Fixes land on `main` and ship in the next release; older releases are not patched.

## Security model

### Laptop workspaces

Pairing is how a device signs in. The tunnel address is not a secret, and knowing it grants nothing: every API request and WebSocket needs a paired device's token, write requests also need a per-device CSRF token and a matching Origin, and the local server listens only on `127.0.0.1`.

- **Pairing links and QR codes are passwords.** A pairing secret is single-use, expires after 2 minutes and is replaced when you create a new one. Whoever redeems it first gets full control of the workspace. Pair in private and don't paste pairing links into chat apps, email or anything that previews links.
- **The secret stays out of request logs.** It travels in the URL fragment (`#pair=…`), which browsers don't send, and reaches Loop only in an HTTPS request body. Loop redacts it from its own logs.
- **Device tokens are long-lived.** The laptop stores only token hashes. A token renews on use for up to a year of inactivity, with a two-year maximum. Browsers hold it in a `__Host-` cookie that is `Secure`, `HttpOnly` and `SameSite=Lax`; the phone app keeps it in secure storage. A copied token works from anywhere until it is revoked or expires.
- **Revoke anything you don't recognise.** `loop devices` lists paired devices and `loop devices revoke ID` removes one and closes its connections.

Remote access is HTTPS only. With the default Quick Tunnel, Cloudflare terminates TLS and can technically see traffic; use `--public-url` with your own TLS proxy if that is not acceptable. Someone watching your network sees the hostname and traffic volume, not tokens or content. Devices with a company root certificate, malware or untrusted browser extensions can see inside HTTPS, so don't pair from them.

See [pairing and recovery](docs/pairing.md) for tunnels, custom proxies and recovery.

### Servers

- **Single-user** (the default) has no login. It serves localhost directly and refuses a public `LOOP_URL` unless `LOOP_GATEWAY_TOKEN` (32+ characters) is set. Put an authenticating proxy in front, such as Cloudflare Access, oauth2-proxy or Authelia, and have it inject the token only for visitors it has authenticated. A proxy that injects the token for everyone makes the server public.
- **Multi-user** uses Loop accounts (email and password of 12+ characters, optionally GitHub). Workspaces are scoped to their owner, so one user can't see or use another's.

Keep the direct server port private either way. `LOOP_BEHIND_PROXY` trusts forwarded headers; it does not authenticate anyone. See [server operation](docs/server.md).

## Known limitations

- **Multi-user sign-up is open.** Anyone who can reach a multi-user server can create an account and a workspace of their own. They can't reach other users' workspaces, but they can use the server's resources. Until sign-up can be restricted, put an access gate such as Cloudflare Access in front of servers that shouldn't accept strangers.
- **Device tokens are not bound to the device.** Revocation is the remedy for a lost or copied token.
