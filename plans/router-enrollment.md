# Questionaire

Gateway enrollment carried by the Router. A clean break from the phone posting the sealed bundle to the new Gateway over the LAN, with a pasted bundle as the fallback.

Why: enrolling `ql-2815` failed three times on 2026-11-09. Reproduced on a firewalled lab machine with the real setup script: the enrollment window ran out while the paste prompt sat open, the prompt froze the countdown, and the refusal read `not in enrollment mode`. A machine that drops inbound connections always falls to the paste road, which needs a courier for 3 KB of text inside a ten minute window that arming again voids.

Lab (session scratchpad, not in the repo): two Docker-in-Docker machines on their own network, `sblab-a` reachable and `sblab-b` dropping ping and every inbound connection, plus the Android emulator with a debug build as the phone.

Research digests (session scratchpad, `enroll/`): the Router's public surface, the Gateway and phone inventories, the other human-carried flows, a threat model, and the pickup design options.

## Question 1 - What should a new Gateway trust? [superseded]

Q: A second compare at the terminal before install, the QR's one-time code as the only secret as today, or install at once and show which Domain it joined?

Superseded by Question 5. The compare at the terminal was accepted on the condition that it stayed small, then dropped when the owner ruled its whole threat out of scope.

## Question 2 - Does the paste road survive?

Q: Remove the pasted bundle with the LAN delivery, or keep it as a last resort?
A: It goes. No "Copy bundle" on the phone, no paste action in setup, no loopback enroll post. The Router is the one road.

> Recommended because the only case a paste could rescue is a Gateway that cannot reach the Router, which cannot work after enrolling either, and setup now catches that before it shows the QR. Owner: "A. Clean break gone. No more cancerous bundle transfers over like 2 external apps".

The phone keeps "Paste enrollment JSON" beside Scan QR. That is the QR's own content, for when the camera cannot see the terminal, not a bundle.

## Question 3 - What does each screen show?

Q: The flow as drawn, or changes?
A: As drawn, with a resume on the setup side. The join prompt and the phone's declined card left with Question 5.

Terminal, Gateway Setup:
- Router host and port, then `Router reached at <host>:<port>`, or `Cannot reach the Router at <host>:<port> (<reason>). Nothing was armed.` and back to the prompt.
- QR or JSON, the Gateway's code to match on the phone, `1) Save`, `b) Back`, and `Waiting for your phone...`. No countdown, no paste key, no arm-again key. If the Router drops away while waiting, that line reads `Cannot reach the Router at <host>:<port> (<reason>), retrying`.
- When the bundle arrives it installs: `Gateway "<id>" enrolled into <Domain name>; connecting to the Router.`
- The Gateway remembers a setup that has not finished, so the menu reads `1) Resume Gateway Setup` and returns to the same code without asking the address again. If the phone approved meanwhile, it enrolls at once.

Phone:
- Add a Gateway, Scan QR, compare, Approve, unchanged. The dialog closes at once after Approve.
- The card while pending, one state: the Gateway's name and `Waiting for setup.sh, Gateway Setup`. No button: the phone hands the bundle in whenever the Gateway asks. The existing actions menu removes it.
- Once the Gateway registers it is an ordinary card, online with no sessions included.

> Owner: "Maybe the '1) Gateway Setup' becomes '1) Resume Gateway Setup' if it detects the temp bundle files that was meant to be sent and enrolled." and, on the pending card's line, "or something to make it clear".

No bundle file exists on the machine to detect: the bundle waits on the phone. What setup detects is the Gateway's own pending code.

## Question 4 - Slim the image?

Q: Cut the image down to what the Gateway and Router run, or leave the development tools in?
A: Slim it, with no OS package install in the build at all. The base already carries `openssl`, the one outside program the Router runs, and the Gateway runs none once the LAN certificate goes. The Gateway also stops holding a time zone: times stay instants and are read in the Console's local time.

> Recommended because nothing in the code uses those packages and the slow first build is part of what made setup feel broken. Owner: "With our default firewall settings for that machine, our Docker fails to build until I snooze firewall. Lets slim off anything we dont need." and "tbh we dont even need timezone package stuff do we? we see timestamps in phone time. Probably should keep it agnostic in like iso friendly timestamps, and read any time in the local Console time".

Measured: the image is 1.56 GB over a 310 MB base. The owner's build log from `ql-2815` fails at the first `apt` step, a 403 on plain HTTP to the Debian mirror, after the base image pulled fine. `TZ` and named zones work in the base with nothing installed.

The Gateway's zone is read in one place, `gatewayZone`, as the zone a routine is stored in. A routine already records its own zone, so the phone saves it in the zone it was typed in and the Gateway needs none.

## Question 5 - Who is the plan defending against?

Q: Keep the terminal's `Join this Domain? [y/n]`, which exists only for a QR that reached the wrong person, or drop it?
A: Drop it. Anyone holding the QR's content is out of scope. The Gateway installs the bundle as soon as it collects it and the terminal says which Domain it joined.

> Recommended because it follows from the owner's scope, removes a step from every enrollment, and takes the held bundle, the confirm, the decline and the phone's dead card out of the plan. Owner: "I dont care about that case. It's a nonexistant case IRL. Me in-person enrolling a device, or me Teams calling a teammate and enrolling with them." and "If a person posts the QR code to the internet public forums and gets got, I call that a SKILL ISSUE(lol) not a MY ISSUE."

In scope, since none of it needs the QR: another tenant filling the Router's memory, the Router reading the code or the bundle, and a process in a devcontainer arming a Gateway by itself.

An outsider hammering the Router is real and is not this plan's. It concerns every public route, not the one added here, so it is a security pass of its own.

> Owner: "now 'an outsider hammering the Router's public route' is a real topic. But lets finish the plan before devising countermeasures for that, since there are more than 1 public routes that you didnt mention. Thats a real security pass, not a feature pass."

# Plan

Two phases. Claude builds it. Every step is proven in the lab before it reaches the owner's Domain. Two audit laps are folded in: Lunas per area, one Sol as the adversary on the trust protocol, and an Opus ranking.

## Decided without asking

- **The Gateway asks, the Router never pushes.** A Gateway with a pending code asks a new public route beside device approval. It names its bundle by a hash of the one-time code, so the Router never sees the code, and signs the ask with its own key, as the register proof is signed, under a tag of its own. The ask is a read and leaves nothing behind on the Router: it finds the frame by the hash, checks the signature against the Gateway key the hand-in named, and answers the frame or nothing. It gets the body cap and the limiter device approval has, lifted out of `PublicApproval` unchanged so the two routes share one class, no better and no worse; hardening is the security pass's. The gateway socket stays closed to anything not admitted.
- **The phone hands in with an owner op.** The Router takes a sealed frame only from an admitted console of the Domain that admitted that Gateway key, and checks the envelope's signature without opening it. A frame is held under the code's hash, and a hand-in from another Domain under a held hash is refused. A frame has a size cap fitted to a whole keyring and a Domain has a count cap, since a console post may be 64 MiB and any Domain can admit made-up Gateway keys.
- **The Router holds it in memory,** as `DeviceApprovalCoordinator` holds its windows: a time limit, a cap, gone on restart. The frame leaves when that Gateway registers. The phone keeps the frame and hands it in again whenever its status read says the Router no longer holds it.
- **One signer check for fresh and repeat enrollments.** The frame's signer and every content key's signer must be admitted consoles under the bundle's own verified snapshot. `stageBootstrap` runs that only when the Gateway already holds a Domain; the condition goes. The phone already includes its own admission (`sealBundle`), so real bundles pass unchanged.
- **Setup arms through the Gateway.** Setup starts the Gateway and calls one loopback arm route with the Router's address. The Gateway checks reach from its own network, where the default local name `federation-router` resolves and the host's does not, pins the certificate it sees, mints the code, writes the pending record and answers with the payload, or with the refusal. `ENROLL_NONCE`, `ENROLL_LAN_HOST` and the container restart on every arm go, and boot arms from the record. On a record that already exists the route mints nothing: it pins again and returns the same payload, which is how a resume gets its QR back.
- **Arming still needs no transport,** as `decideBootPhase` requires. The arm route refuses while one is installed, so a re-enroll keeps today's one stop, clear and start before it arms, and nothing else restarts the Gateway. A boot that finds a transport activates and retires a leftover record.
- **The pending record lives on disk** in the Gateway's federation directory. It is retired at install and at purge, and a plain Gateway restart keeps it.
- **The setup screen's status read is what makes the Gateway ask.** No timer decides a Gateway is armed: with no screen reading, nothing asks. The read answers waiting, installed, refused with the reason a bundle failed, or that the Router cannot be reached, with the reason, in place of watching for the transport file beside a countdown. The ask has a deadline of its own, so it never holds the read.
- **The loopback arm and status routes take the host's token** (`HOST_WS_TOKEN`), since every devcontainer on the Gateway's network can reach its port. The admit payload is gated by the code itself today.
- **The pin is the certificate seen at this arm or resume,** read again each time so one bad first contact does not stick. The asks go through an HTTPS client pinned to it, which the Gateway lacks today, and a bundle whose sealed fingerprint differs is refused. The installed transport comes only from the sealed bundle.
- **The enrollment payload gets a new type name,** so an older app refuses a new Gateway's code plainly, and a new app tells the owner to update a machine showing the old one.
- **No order can be held across one push,** since `start-gateway.sh` pulls on every start and any restart deploys the Gateway half. So Phase 1 keeps answering a zone to apps that still require one, with a dated removal. Phase 2 needs none: an older app refuses the new code plainly, and enrolling is the only thing that waits for the new app.
- **Out of scope:** the setup code a first phone imports, friend invites and Domain links. A human still carries those, and none depends on reaching a machine.
- **Out of scope, and on the board as its own work:** a security pass over everything the Router answers without a member credential. That is the health read, device approval's join and fetch, the gateway socket's upgrade behind one bearer shared by every Domain with the frames it takes from a sender that never registered, and the ask route added here, beside the 64 MiB console post.

## Phase 1 - A slim image and a Gateway with no zone

- ✅ The Dockerfile is `oven/bun` 1.4.0 pinned by digest, `bun install --production` and `src/`. No `apt`, no locale, no zone line. The Router keeps minting its certificate with the base's `openssl`. The two `build --pull` steps went with the floating tag, under which a fresh machine ran Bun 1.4.4 against Sakura's 1.4.0.
- ✅ `diagnose-router.sh` probes with Bun, since it ran `curl` inside the Gateway and the image no longer carries one.
- ✅ The phone keeps a saved routine's zone and gives a new one its own (`keptZoneOf`), and reads the routine list without a zone. `gatewayZone` is gone. Until 2026-11-23 the list answers a fixed `America/Los_Angeles`, which every old image was set to, for apps that still require the field and convert into it. The container's real zone is UTC now and would make such an app save into UTC.
- ✅ The Dockerfile's Bun and `BUN_FLOOR` are tied by a test, and CI runs the pinned Bun.
- ✅ Lab: machine B, rebuilt with no images and plain HTTP refused outbound. The old Dockerfile fails at its first `apt` step, as on `ql-2815`. The new one builds in 25 seconds, 363 MB against 1.56 GB. The Gateway starts on it and the Router mints its certificate and answers its health read.
- ✅ Docs with it: the image paragraph and the zone line in AGENTS.md, and `docs/routines.md`.
- Not checked on a device: the routine editor's zone rule. It is covered by JVM tests only until an app build is installed.
- On the board, not here: a routine draft kept across a daylight-saving week, and a stored zone the phone does not know.

## Phase 2 - Enrollment through the Router

- **Router:** the public ask route behind the existing limiter; the hand-in owner op with its caps; a status read for the phone answering held or not. A wrong or unsigned ask learns nothing.
- **Gateway:** the arm and status routes behind the host's token; the pending record, and arming from it at boot; the pinned HTTPS ask; at arrival the install as it runs today, `openBootstrapBundle` with the code compared in constant time, `stageBootstrap` with its signer checks unconditional, then `activateStaged`. The ask stops with the Gateway's close. Deleted: `enrollTls`, the enrollment port, `handleEnrollPost`, the loopback enroll post, the payload's `lan` block, and the enrollment variables in compose.
- **Setup:** arm through the Gateway and show its refusal as Question 3 words it; the screen from Question 3, with every read after arming through `readKeyWhile`, so the status read never stops behind a blocking prompt as the countdown did; `Resume Gateway Setup` when a pending record exists, found as the installed transport is found so it shows with the Gateway down. A resume never restarts the container or mints a code. Purge removes the record. Deleted: `armGateway`'s restart, both copies of `ENROLL_WINDOW_MS`, the paste action and the arm-again key.
- **Phone:** after Approve it admits, asks for the transport, seals the whole keyring and hands in. While a pending record exists the drain reads the status on its visible and its background path, backing off, hands in again when the Router no longer holds the frame, and stops once the Gateway is online. A rule beside the ops class reads the card's state from the pending record, the status read and `GatewayRegistry.standing`, so a Gateway with no sessions reads online. Deleted: the LAN post, the pinned client, the private-address check, the bounded paste frame, "Copy bundle", the old "Resume setup", and the socket exemption `sandbox-network-residue` gives `GatewayEnrollment`. The paste field for the QR's content gets a bounded height.
- **Tests:** the harness boots a Gateway armed and enrolls it through the real Router with the phone driver's own `send`, replacing the test that posts to the loopback. `check:pinning` gains a matching and a mismatched HTTPS case. Kotlin tests cover the card rule. Wire fixtures and `Protocol.kt` are regenerated. The sandbox seeds a pending card.
- **Lab, with the emulator as the phone:** enroll machine A, whose Router is local, then machine B, which answers nothing. Close setup after Approve and resume. Restart the Router between Approve and the collect.
- **Docs with it:** `docs/federation.md`, the port table in `docs/architecture.md`, `docs/environment.md`, the README, and the AGENTS.md map lines for enrollment.
- **Rollout, once the lab passes:** the Router, then Sakura's Gateway, then `mikan` and the machine at `.182` over SSH, then the app. Enroll `ql-2815` for real, with its firewall left on. Then delete the two dead bundles from Discord and take the lab down.
