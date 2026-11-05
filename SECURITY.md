# Security

## Reporting a vulnerability

Report vulnerabilities privately through **Security → Report a vulnerability** on the [GitHub repository](https://github.com/j-asefa/loop/security). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected version or commit, whether you run the laptop workspace or the Docker companion, steps to reproduce and the impact you expect. We aim to acknowledge reports within a week.

## Supported versions

Loop is pre-1.0. Fixes land on `main` and ship in the next release; older releases are not patched.

## Security model

### Laptop workspaces

Pairing is how a device signs in. The tunnel address is not a secret, and knowing it grants nothing: every API request and WebSocket needs a paired device's token, write requests also need a per-device CSRF token and a matching Origin, and the local server listens only on `127.0.0.1`.

- **Pairing links and QR codes are passwords.** A pairing secret is single-use, expires after 2 minutes and is replaced when you create a new one. Whoever redeems it first gets full control of the workspace. Pair in private and don't paste pairing links into chat apps, email or anything that previews links.
- **The secret stays out of request logs.** It travels in the URL fragment (`#pair=…`), which browsers don't send, and reaches Loop only in an HTTPS request body. Loop redacts it from its own logs.
- **Device tokens are long-lived.** The laptop stores only token hashes. A token renews on use for up to a year of inactivity, with a two-year maximum. Browsers hold it in a `__Host-` cookie that is `Secure`, `HttpOnly` and `SameSite=Lax`. A copied token works from anywhere until it is revoked or expires.
- **Revoke anything you don't recognise.** `loop devices` lists paired devices and `loop devices revoke ID` removes one and closes its connections.

Remote access is HTTPS only. With the default Quick Tunnel, Cloudflare terminates TLS and can technically see traffic; use `--public-url` with your own TLS proxy if that is not acceptable. Someone watching your network sees the hostname and traffic volume, not tokens or content. Devices with a company root certificate, malware or untrusted browser extensions can see inside HTTPS, so don't pair from them.

See [pairing and recovery](docs/pairing.md) for tunnels, custom proxies and recovery.

## Known limitations

- **Device tokens are not bound to the device.** Revocation is the remedy for a lost or copied token.
