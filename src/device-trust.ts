/** Gateway-owned device credentials. Only id/name/expires may leave this boundary. */
export type TrustedDevice = {
  id: string;
  name: string;
  hash: string;
  csrf: string;
  expires: number;
  maxExpires: number;
};

/** Every gateway uses its workspace transaction store. Preview processes have
 * an independent database and cookie namespace. */
export interface DeviceTrust {
  /** Stored administrative inventory, including credentials awaiting retirement.
   * Call device/authenticate to establish current authentication eligibility. */
  devices(): TrustedDevice[];
  /** Authoritative eligibility decisions. Callers must not make another expiry
   * decision from the returned timestamp using a separate clock observation. */
  device(id: string): TrustedDevice | undefined;
  authenticate(digest: string): TrustedDevice | undefined;
  revoke(id: string): void;
  expire(): void;
  originChanged(origin: string): void;
  pair(origin: string): { url: string; expiresIn: number };
  redeem(
    input: { secret: string; name: string; ceremonyId?: string },
    origin: string,
  ): { token: string; expires: number };
}
