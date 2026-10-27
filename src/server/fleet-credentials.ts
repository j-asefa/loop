import type Database from "better-sqlite3";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { FleetGrantContext } from "../shared/fleet.js";
import {
  FLEET_CREDENTIAL_LIFETIME_MS,
  FLEET_NONCE_LIFETIME_MS,
  FleetChallenge,
  FleetCredential,
  FleetCredentialProof,
  FleetCredentialRequest,
  FleetSecret,
  SignedFleetChallenge,
  SignedFleetCredential,
  fleetCredentialTiming,
} from "../shared/fleet-credentials.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  identityFromPrivateKey,
} from "./fleet-crypto.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

type Secrets = Parameters<typeof initializeFleetIdentity>[1];
type Clock = { wall: () => number; monotonic: () => number };
const purposes = {
  challenge: FleetChallenge,
  request: FleetCredentialRequest,
  credential: FleetCredential,
};
type Purpose = keyof typeof purposes;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const refused = () =>
  new Problem(403, "Fleet credential proof is invalid, expired, or revoked.");
function proofBytes(purpose: Purpose, input: unknown) {
  return Buffer.from(
    `loop:fleet:credential:${purpose}:v1\n${fleetPayloadDigest(purposes[purpose].parse(input))}`,
  );
}
function valid(
  purpose: Purpose,
  input: unknown,
  signature: string,
  publicKey: string,
) {
  try {
    return verify(
      null,
      proofBytes(purpose, input),
      createPublicKey({
        key: Buffer.from(publicKey, "base64url"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
const Row = z.object({
  owner_id: z.string(),
  peer_id: z.string(),
  context: z.string(),
  issued_at: z.number().int(),
  expires_at: z.number().int(),
  observed_at: z.number().int(),
});

/** Destination-owned ten-minute credentials. There is no phone or controller
 * dependency after enrollment. These primitives expose no HTTP admission. */
export class FleetCredentials {
  private readonly pending = new WeakMap<
    FleetCredentialProof,
    { started: number; digest: string }
  >();
  private readonly issuerSession = randomUUID();
  private readonly deadlines = new Map<
    string,
    { mono: number; issued: number }
  >();
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly secrets: Secrets,
    private readonly clock: Clock = {
      wall: Date.now,
      monotonic: () => performance.now(),
    },
  ) {
    // One issuer instance belongs to a companion gateway. Monotonic elapsed
    // time cannot be recovered portably after a process restart or reboot when
    // wall time has stalled. Invalidate short-lived credentials at startup;
    // durable grants remain for fresh renewal. Old challenges cannot be reused
    // because they carry the previous issuer instance's identity.
    if (db.inTransaction) throw refused();
    db.transaction(() => {
      // Replacing the issuer fences an overlapping old instance before clearing
      // receipts. It must never issue again against the newly empty nonce set.
      db.prepare(
        "INSERT INTO fleet_credential_issuer VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET issuer_session=excluded.issuer_session",
      ).run(this.issuerSession);
      db.prepare("DELETE FROM fleet_credentials").run();
      db.prepare("DELETE FROM fleet_credential_nonces").run();
    }).immediate();
  }

  private currentIssuer() {
    const row = this.db
      .prepare(
        "SELECT issuer_session FROM fleet_credential_issuer WHERE singleton=1",
      )
      .get() as { issuer_session: string } | undefined;
    if (row?.issuer_session !== this.issuerSession) throw refused();
  }

  private sign(purpose: Purpose, input: unknown) {
    const row = this.db
      .prepare(
        "SELECT private_key FROM fleet_machine_identity WHERE singleton=1",
      )
      .get() as { private_key: string };
    const key = this.secrets.unseal(
      row.private_key,
      `fleet:machine:${this.authority.identity.machineId}`,
    );
    if (
      identityFromPrivateKey(key).machineId !==
      this.authority.identity.machineId
    )
      throw refused();
    return sign(
      null,
      proofBytes(purpose, input),
      createPrivateKey({
        key: Buffer.from(key, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
    ).toString("base64url");
  }

  private now() {
    const now = this.clock.wall();
    const prior = this.db
      .prepare(
        "SELECT observed_at FROM fleet_credential_clock WHERE singleton=1",
      )
      .get() as { observed_at: number } | undefined;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (prior && now < prior.observed_at)
    )
      throw refused();
    if (!prior || now > prior.observed_at)
      this.db
        .prepare(
          "INSERT INTO fleet_credential_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=excluded.observed_at",
        )
        .run(now);
    return now;
  }

  /** Rejection must not roll the observed clock backwards with other writes.
   * Keep the high-water mark after the transaction rolls back, so restarting
   * after an expired request cannot revive it by rewinding the issuer clock. */
  private timed<T>(action: (now: number) => T): T {
    if (this.db.inTransaction) throw refused();
    const mono = this.clock.monotonic(),
      wall = this.clock.wall();
    const expired = [...this.deadlines]
      .filter(
        ([, entry]) =>
          entry.mono <= mono ||
          entry.issued + FLEET_CREDENTIAL_LIFETIME_MS <= wall,
      )
      .map(([digest]) => digest);
    if (expired.length) {
      // Commit invalidation before forgetting a deadline. Keep this separate
      // from the requested operation: even a rejected issuance must not roll
      // expiry back and let authentication or restart rebuild its lifetime.
      this.db
        .transaction(() => {
          this.currentIssuer();
          const remove = this.db.prepare(
            "DELETE FROM fleet_credentials WHERE token_hash=?",
          );
          for (const digest of expired) remove.run(digest);
        })
        .immediate();
      for (const digest of expired) this.deadlines.delete(digest);
    }
    let observed: number | undefined;
    try {
      return this.db
        .transaction(() => {
          this.currentIssuer();
          observed = this.now();
          return action(observed);
        })
        .immediate();
    } catch (error) {
      if (observed !== undefined)
        this.db
          .prepare(
            "INSERT INTO fleet_credential_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=max(observed_at,excluded.observed_at)",
          )
          .run(observed);
      throw error;
    }
  }

  challenge(input: FleetGrantContext): SignedFleetChallenge {
    const context = FleetGrantContext.parse(input);
    return this.timed((issuedAt) => {
      this.authority.authorize(context);
      const challenge = FleetChallenge.parse({
        version: 1,
        context,
        nonce: secret(),
        issuerSession: this.issuerSession,
        expiresAtMonotonic:
          Math.floor(this.clock.monotonic()) + FLEET_NONCE_LIFETIME_MS,
        issuedAt,
        expiresAt: issuedAt + FLEET_NONCE_LIFETIME_MS,
      });
      // Challenges allocate no per-request state. One durable clock high-water
      // mark prevents expired nonce receipts reviving after an issuer clock reset.
      return { challenge, signature: this.sign("challenge", challenge) };
    });
  }

  private target(owner: string, context: FleetGrantContext) {
    const signed = this.authority.directory(owner);
    const target = signed?.document.members.find(
      (m) => m.machineId === context.destination,
    );
    if (
      !signed ||
      !target ||
      !signed.document.members.some(
        (member) => member.machineId === this.authority.identity.machineId,
      ) ||
      context.peer !== this.authority.identity.machineId ||
      context.fleetId !== signed.document.fleetId ||
      context.directory !== directoryDigest(signed.document) ||
      context.grantId !== target.grantId ||
      target.machineId === context.peer
    )
      throw refused();
    return target;
  }

  prove(owner: string, input: SignedFleetChallenge): FleetCredentialProof {
    const challenge = SignedFleetChallenge.parse(input);
    const target = this.target(owner, challenge.challenge.context);
    if (
      challenge.challenge.expiresAt - challenge.challenge.issuedAt !==
        FLEET_NONCE_LIFETIME_MS ||
      !valid(
        "challenge",
        challenge.challenge,
        challenge.signature,
        target.publicKey,
      )
    )
      throw refused();
    // The caller does not compare another machine's wall clock to its own.
    const request = { challenge, requestNonce: secret() };
    const proof = { ...request, signature: this.sign("request", request) };
    this.pending.set(proof, {
      started: this.clock.monotonic(),
      digest: fleetPayloadDigest(proof),
    });
    return proof;
  }

  issue(input: FleetCredentialProof): SignedFleetCredential {
    const proof = FleetCredentialProof.parse(input);
    const challenge = proof.challenge.challenge,
      context = challenge.context;
    return this.timed((now) => {
      const { owner, publicKey } = this.authority.authorize(context);
      const started = this.clock.monotonic();
      if (
        now < challenge.issuedAt ||
        now >= challenge.expiresAt ||
        challenge.issuerSession !== this.issuerSession ||
        started >= challenge.expiresAtMonotonic ||
        challenge.expiresAt - challenge.issuedAt !== FLEET_NONCE_LIFETIME_MS ||
        !valid(
          "challenge",
          challenge,
          proof.challenge.signature,
          this.authority.identity.publicKey,
        ) ||
        !valid(
          "request",
          { challenge: proof.challenge, requestNonce: proof.requestNonce },
          proof.signature,
          publicKey,
        )
      )
        throw refused();
      this.db
        .prepare(
          "DELETE FROM fleet_credential_nonces WHERE expires_at<=? OR issuer_session<>? OR expires_at_monotonic<=?",
        )
        .run(now, this.issuerSession, started);
      this.db
        .prepare("DELETE FROM fleet_credentials WHERE expires_at<=?")
        .run(now);
      if (
        this.db
          .prepare("SELECT 1 FROM fleet_credential_nonces WHERE nonce_hash=?")
          .get(hash(challenge.nonce))
      )
        throw refused();
      const total = this.db
        .prepare("SELECT count(*) n FROM fleet_credentials")
        .get() as { n: number };
      const peer = this.db
        .prepare(
          "SELECT count(*) n FROM fleet_credentials WHERE owner_id=? AND peer_id=?",
        )
        .get(owner, context.peer) as { n: number };
      if (total.n >= 2048 || peer.n >= 64)
        throw new Problem(
          429,
          "Fleet credential capacity is busy. Retry after expiry.",
        );
      const token = secret(),
        digest = hash(token),
        expires = now + FLEET_CREDENTIAL_LIFETIME_MS;
      this.db
        .prepare("INSERT INTO fleet_credential_nonces VALUES(?,?,?,?)")
        .run(
          hash(challenge.nonce),
          challenge.expiresAt,
          this.issuerSession,
          challenge.expiresAtMonotonic,
        );
      this.db
        .prepare("INSERT INTO fleet_credentials VALUES(?,?,?,?,?,?,?)")
        .run(
          digest,
          owner,
          context.peer,
          JSON.stringify(context),
          now,
          expires,
          now,
        );
      const credential = FleetCredential.parse({
        version: 1,
        context,
        nonce: challenge.nonce,
        requestNonce: proof.requestNonce,
        token,
        remainingMs: FLEET_CREDENTIAL_LIFETIME_MS,
      });
      const result = {
        credential,
        signature: this.sign("credential", credential),
      };
      // In-process monotonic expiry also fails closed if the wall clock stalls.
      this.deadlines.set(digest, {
        mono: started + FLEET_CREDENTIAL_LIFETIME_MS,
        issued: now,
      });
      return result;
    });
  }

  accept(
    owner: string,
    proof: FleetCredentialProof,
    input: SignedFleetCredential,
  ) {
    const response = SignedFleetCredential.parse(input);
    const credential = response.credential,
      target = this.target(owner, credential.context);
    if (
      credential.nonce !== proof.challenge.challenge.nonce ||
      credential.requestNonce !== proof.requestNonce ||
      fleetPayloadDigest(credential.context) !==
        fleetPayloadDigest(proof.challenge.challenge.context) ||
      !valid("credential", credential, response.signature, target.publicKey)
    )
      throw refused();
    const pending = this.pending.get(proof);
    if (!pending || pending.digest !== fleetPayloadDigest(proof))
      throw refused();
    const received = this.clock.monotonic();
    const timing = fleetCredentialTiming(
      credential.remainingMs,
      received - pending.started,
    );
    if (timing.remainingMs <= 0) throw refused();
    this.pending.delete(proof);
    return {
      ...credential,
      remainingMs: timing.remainingMs,
      expiresAtMonotonic: received + timing.remainingMs,
      renewAtMonotonic: received + timing.renewInMs,
    };
  }

  authenticate(input: string) {
    const digest = hash(FleetSecret.parse(input));
    const result = this.timed((wall) => {
      const value = this.db
        .prepare("SELECT * FROM fleet_credentials WHERE token_hash=?")
        .get(digest);
      if (!value) throw refused();
      const row = Row.parse(value),
        mono = this.clock.monotonic();
      if (
        wall < row.issued_at ||
        wall < row.observed_at ||
        wall >= row.expires_at ||
        row.expires_at - row.issued_at !== FLEET_CREDENTIAL_LIFETIME_MS
      )
        throw refused();
      const deadline = this.deadlines.get(digest);
      if (!deadline) throw refused();
      if (mono >= deadline.mono) {
        // Persist an observed monotonic expiry even if the wall clock has
        // stalled; a restart must not rebuild a fresh in-memory deadline.
        this.db
          .prepare("DELETE FROM fleet_credentials WHERE token_hash=?")
          .run(digest);
        return undefined;
      }
      if (deadline.issued !== row.issued_at) throw refused();
      const context = FleetGrantContext.parse(JSON.parse(row.context));
      const granted = this.authority.authorize(context);
      if (granted.owner !== row.owner_id || context.peer !== row.peer_id)
        throw refused();
      const remaining = Math.min(row.expires_at - wall, deadline.mono - mono);
      const remainingMs = Math.floor(remaining);
      if (remainingMs <= 0) throw refused();
      this.db
        .prepare(
          "UPDATE fleet_credentials SET observed_at=? WHERE token_hash=?",
        )
        .run(wall, digest);
      this.deadlines.set(digest, deadline);
      return { context, owner: granted.owner, remainingMs };
    });
    if (!result) throw refused();
    return result;
  }
}
