# Fleet acceptance

Use this checklist on test-owned workspaces. Results belong in the implementation
PR or a dated acceptance report; this guide describes how to reproduce them.
The [development guide](development.md) defines the ordinary PR checks, and
[pairing and recovery](pairing.md) describes the supported operator workflow.

## Reproducible runner

Start from the submitted checkout with `npm ci` completed. Install Chromium and
WebKit using the command in the development guide. Serialize heavy checks on a
shared host; do not stop other users' jobs to make room.

```sh
node scripts/fleet-acceptance.mjs --help
node scripts/fleet-acceptance.mjs --fixtures --output /tmp/fleet-fixtures.json
```

Fixture mode runs `npm run check`, a build, selected fleet HTTP/mail tests, the
startup/host/mail/native-harness fixtures, both fleet browser journeys and the
package smoke. It does not replace the full suites required when opening or
merging the integration PR. It uses no Internet tunnel or provider account.

Fixture measurements include the production Feed and metadata loader with nine
synthetic HTTP sources (one held, then refused with 503), production multiplexing
with three viewers across three and sixteen sources (one slow), and shared Host
admission under eight simulated peer senders plus browser HTTP and WebSockets.
The JSON report records measured render/partial-failure timing, request counts,
body and frame bytes, upstream sharing, peak admission, teardown counts and RSS.
These fixtures separately exercise the actual client, multiplex and admission
boundaries; they are not sixteen Internet-connected companions. A held response
followed by 503 is not an observed Internet timeout, and RSS observations do not
prove an upper bound on process memory. Replay eviction and released capacity
have separate assertions in the same measured fixtures. Additional fault cases
check malformed and oversized frames, browser reconnect cursors, and a slow
viewer's output buffer without disrupting another source or viewer. Socket-buffer
pressure is injected at the production send boundary; it is not a live network
congestion measurement.

The following separate command installs the packaged build and starts three
isolated companions behind **real Quick Tunnels**. It prints that scope before
starting. Allow enough time for package installation, tunnel setup and the
eleven-minute mail interval. It is never invoked by `npm test`, `npm run check`,
`npm run test:all` or CI.

```sh
node scripts/fleet-acceptance.mjs --quick-tunnels --output /tmp/fleet-transport.json
# To test an already built tarball instead:
node scripts/fleet-acceptance.mjs --quick-tunnels --package /absolute/path/loop55-0.1.0.tgz --output /tmp/fleet-transport.json
```

To exercise an existing workspace upgrade, supply a separately built, clean
older **Loop55** package whose source includes fleet administration and ordinary
peer reads but predates fleet event streaming, Done grouping and mail migrations.
Both builds must use the same Loop55 header protocol. The pre-rename `loop`
package is not a supported mixed-version peer in this scenario; follow
[the name upgrade guide](name-upgrade.md) when moving an existing installation.
Build the chosen older revision in an isolated checkout;
do not change the source of a running test. The runner requires different clean
source commits and at least one new migration, so changing only a package version
cannot satisfy this case.

```sh
node scripts/fleet-acceptance.mjs --quick-tunnels --package /absolute/new-loop55.tgz --upgrade-from /absolute/older-loop55.tgz --output /tmp/fleet-upgrade-transport.json
```

A starts from the older package in a private global npm prefix. B/C use the new
package. After enrollment, the runner creates an agent and completed conversation
on A. It checks that B can read A's agents, sees events unavailable, and cannot
read A's absent Done-group projection. It runs the real `loop55 upgrade --from` against A's existing state, verifies newly applied
named migrations, the retained agent/run/directory and old paired cookie, and the
unchanged connection service/tunnel. The Done-group read must then succeed and
the peer must advertise events before
continuing all transport cases. The report records both source commits and the
observed refusal status. Without `--upgrade-from`, this case remains explicitly
pending. This tests the chosen older-to-new pair, not arbitrary future versions.

The runner uses the installed CLI and production cloudflared pin. Each companion
has a new `LOOP55_HOME`, committed fixture project and deterministic Codex executable.
It never changes `HOME`, adopts a user's workspace, or uses a provider account.
Child Git commands use an empty private global configuration and template directory,
with system Git configuration disabled. Child Docker discovery uses an empty private
configuration and an absent test-owned socket, so it cannot attach existing local
Docker sources. Proxy and CA settings remain intact. This is tool-specific isolation,
not a sandbox for arbitrary executables on `PATH`.
Pairing links and cookies stay in memory; they are not included in the report.
The native fixture uses its production private tool bridge, and the actual worker
persists and delivers the mail. Public HTTPS addresses are temporary test origins.

Transport cases cover three-member enrollment and acknowledgements, six directed
source reads, authenticated multiplexed event sockets through A and B, repeated
remote command identity, a message/file/reply, delayed mail with all browser
clients closed and controller A stopped for more than ten minutes while C and B
exchange mail, all three addresses changing while
the controller key survives, signed controller handoff, and explicit per-member
recovery with the controller unavailable. The recovery case checks pending
unconfirmed members, fresh grants and a message/reply after each member consents.
No browser HTTP or
WebSocket or metrics client is active during the delayed-mail interval; the worker
originates the message and the recipient replies through its own harness bridge.
The runner verifies their local audit files before relaunching and repairing A.

The gateway-loss case uses a loopback response-drop relay as the browser stand-in.
It forwards one real HTTPS action, verifies the destination's committed command/run
rows, withholds the browser response, stops A with its own CLI, and drops that
response. C then checks B's original receipt while A is unavailable. A synthetic
native process writes an audit marker; the runner checks one marker, one run and
one command receipt before and after restarting/repairing A. It also checks an
absent receipt is durably refused at B, submits the matching delayed action and
expects 409, then verifies one refusal row, no run and no native audit effect for
that identity. This is an injected transport fault with actual packaged
companions, not a physical-browser network failure or a real provider effect.

The JSON report records source/build identity, dirty-source status, each case's
outcome and elapsed time, safe failure kind/numeric diagnostics and runner source
location, cleanup state, client HTTP/frame observations and exact
remaining live cases. A failure stops dependent steps. Failed, missing and unrun
cases are not passes. Client request counts are not aggregate per-tunnel peer
load, proof of lower battery use, or a representative performance benchmark.
Native audit counts are observations at the end of the case; the durable-boundary
regressions separately check stored receipts and effects.

On A and B, Chromium and WebKit use fresh mobile-sized contexts at the real
origins. Three fixture conversations establish a known workload. The runner
records time to the first visible Feed row and all three source rows, browser
HTTP/byte counts, event frames/bytes, ten seconds idle and ten seconds with a
source-correct remote thread open. It checks one multiplexed browser event
socket. These measurements describe that small synthetic workload and browser
emulation; they do not establish physical-phone acceptance or total inbound peer
traffic at Cloudflare. All browser processes close before the delayed-mail case.

Each test-owned cloudflared gets a separately allocated loopback metrics address
through the documented
[`TUNNEL_METRICS` setting](https://developers.cloudflare.com/tunnel/reference/run-parameters/#metrics).
The runner samples its documented [`/metrics` endpoint](https://developers.cloudflare.com/tunnel/observability/#metrics)
before navigation, after loading Feed, after idle and after opening the remote
thread. Each connection launch captures the pin from its installed package's
compiled tunnel module, including when `--package` supplies another build. An
application upgrade keeps that captured pin until the connection is relaunched,
because the existing tunnel survives the upgrade. An unrecognized packaged pin
stops the launch case. Samples record the expected version, verify `build_info`
against it and retain only numeric sums for total/concurrent requests, request
errors, active streams and process/Go memory when exported. Unavailable fields stay null; an
unreachable or mismatched daemon is marked unavailable. Labels, tunnel identities,
URLs and raw metrics never enter the report. These snapshots include all senders
at each receiving test tunnel, but are not peak sampling or a separation of peer
HTTP, browser HTTP and WebSocket connections. They do not prove capacity headroom.
The runner never scans shared default ports and stops sampling before the
closed-browser/controller-offline interval.

The runner stops only its own companions and removes their temporary directories
after successful cleanup. An already-stopped companion is accepted only after the
CLI's specific no-running-workspace response and status confirmation that both
application and connection are stopped. Other stop failures retain the state.
If cleanup fails, the report retains the test directory.
The printed test directory also has a private `cleanup.json` with the installed
CLI for each test-owned `LOOP55_HOME`, so interruption does not lose their locations.
Use that directory's installed CLI with each recorded test state's `LOOP55_HOME`
to run `loop55 stop` and `loop55 status --json`; remove the directory only after
every companion is confirmed stopped with no unresolved stop error. Do not
publish retained databases or daemon logs, which can contain test credentials.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
have temporary addresses, no uptime guarantee and a documented in-flight request
limit. Their optional interactive email gate is incompatible with peer traffic.
Loop55 uses HTTPS and WebSockets; Quick Tunnels do not support SSE. The
[WebSocket guidance](https://developers.cloudflare.com/network/websockets/)
describes connection loss during edge updates and the need for reconnects and
heartbeats. An unavailable tunnel is recorded as unavailable evidence.

## Separate-host and physical-phone checklist

The automated tunnel run uses one host and a synthetic harness. Full live
acceptance additionally needs a second host/VM, a physical iPhone or Android, and
authorized test accounts for real harnesses on at least two machines, including
one outside Claude Code/Codex. The user supplies those resources or executes the
steps below and returns the report. Do not infer these results from emulation.

1. Build and pack the reviewed commit, copy the same tarball to both hosts, and
   install it into a test-specific prefix on each. Record `loop55 --version`,
   `/api/build` through a paired session, host OS, phone OS/browser and harness
   versions. Keep independent copies of the package/build identity in the report.
2. Create three empty committed projects and three new absolute `LOOP55_HOME`
   directories, with at least one companion on the second host. Start each with
   its own explicit project and only the authorized test providers. For example:

   ```sh
   npm install --prefix /absolute/test-install /absolute/loop55-0.1.0.tgz
   LOOP55_HOME=/absolute/fleet-a /absolute/test-install/node_modules/.bin/loop55 start --project /absolute/project-a --providers codex
   LOOP55_HOME=/absolute/fleet-b /absolute/test-install/node_modules/.bin/loop55 start --project /absolute/project-b --providers pi
   ```

   Use a separate directory for C. Keep real credentials on the machine/harness
   that owns them. Verify an unauthenticated HTTPS request to `/api/bootstrap`
   returns 401/403, including after restarts and address changes.

3. On the physical phone, scan A's code with the OS camera, confirm pairing, and
   install/open the PWA. In **Settings → Machines & fleet**, create the fleet.
   Add B and C using their fresh links and explicit scopes. Verify acknowledgements
   settle, every gateway labels its own authority, and the controller cannot
   remove itself. Use duplicate display names on two machines and confirm their
   identities and owning agents stay distinct.
4. Exercise both QR paths: deny in-app camera access and paste the link; then
   scan with the in-app decoder on a browser without native `BarcodeDetector`.
   Separately pair at B using its OS-camera link, mint a fresh enrollment-only
   link there, and add/repair it through the controller. Replayed or expired
   enrollment must be refused without removing existing device trust.
5. Through A and then B, select an account on the owning machine under
   **Model & connection**. Inspect its projects and models, create agents,
   read/reply to threads, answer a harmless native approval
   or question, cancel a test task, save an output, and upload/read a small file.
   Confirm the owning machine's records change once and another source's same
   display name or entity ID does not select the target. Native sessions and
   provider credentials must remain on their owning machines.
6. Start a harmless cross-machine message/file/reply task and a handoff using
   discovered source-qualified agent addresses. Close every browser/PWA for at
   least eleven minutes while the agents remain running, then reopen. Verify
   delivery/replies continued, attachments were read through `loop55_read_file`,
   and recorded message IDs were not duplicated. Include at least one real
   non-Claude/Codex harness. Record busy/paused recipient and held/resume results
   separately; an unsupported live input operation must remain unavailable.
7. Background and resume the phone, switch networks, and temporarily disconnect
   one companion. The Feed must show healthy sources promptly and identify the
   offline source. Return it and verify queued mail resumes its existing IDs.
   Record first useful render and partial-source timeout, HTTP/frame counts and
   bytes, idle/active traffic, and upstream/browser sockets per receiving tunnel.
   Run a larger synthetic fleet with concurrent peer/browser traffic separately;
   report aggregate ingress, memory/queue bounds and 429/5xx behavior with the
   exact workload. Do not infer aggregate capacity from a browser socket count.
8. Stop/recreate at least two test tunnels using the owning test `LOOP55_HOME` and
   `loop55 stop`/`loop55 start`. Pair at the fresh origins, repair their signed
   addresses, and observe pending acknowledgements. Repeat with **all** addresses
   changed and no old browser storage while A's server key survives. Repair A
   first, then the peers. Confirm the old PWA's cookie does not confer authority
   over a replaced directory.
9. Exercise signed controller handoff and interruption/receipt recovery using
   the original operation ID. Separately stop the controller and explicitly reset
   each surviving member into the selected recovery lineage; reconnect each
   member with fresh consent. Old grants must not silently return. Record every
   unconfirmed member until it acknowledges the recovery directory.
10. In an isolated fault-injection run, terminate the gateway after the destination
    commits an action but before the browser receives its result. Retain/copy the
    original command receipt, open another paired gateway, and use **Check outcome**.
    Verify destination database command/run rows and the fixture's external-effect
    counter show one effect. Repeat same-ID/same-payload and same-ID/different-payload
    attempts, including a genuinely unknown result. Never submit a replacement
    action merely because its outcome is uncertain. A manual stop after the
    browser already received success does not establish this race.
11. Restart application and worker independently, then peer and gateway; verify
    the connection service retains its address across an application restart.
    Test installation/upgrade from a known prior package using a copied test
    workspace, mixed-version refusal/capabilities and existing server/Docker
    profile regressions. Record old/new versions and the migration result.
12. Stop only the test companions with their explicit `LOOP55_HOME`. Revoke test
    device trust and remove test data after capturing a sanitized report. Keep
    pairing capabilities, cookies, provider tokens and private native context
    out of screenshots, traces, issue comments and result attachments.

## Results template

```text
Reviewed commit / merge commit / package build identity:
Commands and observed exits:
Host A / Host B / third companion placement:
Physical phone, OS, browser, installed-PWA status:
Real harness versions and machines (no account identifiers or credentials):
Case | passed / failed / unavailable / unrun | observation | evidence location
Pairing, QR fallback, enrollment and replay:
Ownership, grants and unauthenticated refusal:
Source reads, controls, files and Feed:
HTTPS / WebSockets in both directions:
Mail/reply/handoff with browsers closed (start/end UTC, message IDs):
Origin rotation / all-origin repair / handoff / per-member recovery:
Gateway-loss receipt and persistent effect count:
Lifecycle / mixed versions / package upgrade / Docker:
Three-node and larger-fleet workload + measured traffic/latency/capacity:
Cleanup result:
Remaining case | reason | required resource | owner | next action:
Software completion: yes/no (all stages merged and required software gates passed)
Full live acceptance: yes/no (second host, physical phone and real harness cases passed)
```
