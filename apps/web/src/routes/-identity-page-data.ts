import { getRequest } from "@tanstack/react-start/server";
import {
  type IdentityEnvelope,
  type IdentityKey,
  readIdentity,
} from "@/lib/server/identity-envelope";
import { assertIdentityReadAllowed } from "@/lib/server/identity-dials";
import {
  canonicalIdentityKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  platformIdentityKey,
} from "@/lib/identity-key";

export type IdentityKeyKind = "isrc" | "mbid" | "platform" | "reference";

export function identityKeyFor(raw: string): { key: IdentityKey; kind: IdentityKeyKind } {
  const isrc = normalizeIsrcKey(raw);

  if (isrc) {
    return { key: { isrcs: [isrc], kind: "isrc" }, kind: "isrc" };
  }

  const mbid = normalizeMbidKey(raw);

  if (mbid) {
    return { key: { kind: "mbid", mbid }, kind: "mbid" };
  }

  const platform = platformIdentityKey(raw);

  if (platform?.platform === "spotify") {
    return { key: { kind: "spotify", spotifyId: platform.id }, kind: "platform" };
  }

  if (platform?.platform === "deezer") {
    return { key: { deezerId: platform.id, kind: "deezer" }, kind: "platform" };
  }

  return { key: { idOrLogId: raw.trim(), kind: "idOrLogId" }, kind: "reference" };
}

export type IdentityPageData =
  | { envelope: IdentityEnvelope; key: string; kind: IdentityKeyKind; status: "found" }
  | { key: string; kind: IdentityKeyKind; status: "missing" }
  | { status: "limited" };

export async function resolveIdentityPageData(raw: string): Promise<IdentityPageData> {
  const { key, kind } = identityKeyFor(raw);
  const canonical = canonicalIdentityKey(raw);

  try {
    await assertIdentityReadAllowed(getRequest());
  } catch {
    return { status: "limited" };
  }

  const envelope = await readIdentity(key, "first-party");

  return envelope
    ? { envelope, key: canonical, kind, status: "found" }
    : { key: canonical, kind, status: "missing" };
}
