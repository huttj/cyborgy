// Web Push from the Worker: VAPID (ES256 JWT) auth + RFC 8291 aes128gcm
// payload encryption, all on WebCrypto (ported from Todolog). No-ops when the
// VAPID keys are unset.
import type { Env, UEnv } from "./types";
import { now } from "./db";

interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const te = new TextEncoder();

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlEncode(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

async function vapidJwt(env: Env, audience: string): Promise<string> {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY!) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = (o: unknown) => b64urlEncode(te.encode(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const claims = enc({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    // Push services want a contact URL here; the app URL is enough.
    sub: env.PUBLIC_URL,
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    te.encode(`${head}.${claims}`),
  );
  return `${head}.${claims}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Encrypt + POST one push message. Returns the HTTP status. */
async function sendPush(env: Env, sub: PushSub, payload: string): Promise<number> {
  const uaPub = b64urlDecode(sub.p256dh); // 65-byte uncompressed P-256 point
  const authSecret = b64urlDecode(sub.auth); // 16 bytes

  const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPub = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types names the peer key `$public`; the runtime takes `public`.
      { name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
      asKeys.privateKey,
      256,
    ),
  );

  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // Single record: payload + 0x02 (last-record delimiter).
  const record = concat(te.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, record as BufferSource),
  );

  // aes128gcm body header: salt(16) | rs(4) | idlen(1) | keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const body = concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);

  const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: body as unknown as BodyInit,
  });
  return res.status;
}

export function pushEnabled(env: Env): boolean {
  return !!(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY);
}

/** Push to every browser/device this user subscribed; prunes dead endpoints. Returns the count delivered. */
export async function pushToUser(
  env: UEnv,
  message: { title: string; body?: string | null; url?: string },
): Promise<number> {
  if (!pushEnabled(env)) return 0;
  const subs = await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`)
    .bind(env.USER_ID)
    .all<PushSub>();
  const payload = JSON.stringify({
    title: message.title,
    body: (message.body ?? "").slice(0, 400),
    url: message.url ?? "/",
  });
  let sent = 0;
  for (const sub of subs.results) {
    try {
      const status = await sendPush(env, sub, payload);
      if (status === 404 || status === 410) {
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(sub.id).run();
      } else if (status >= 400) {
        console.error(`push: endpoint returned ${status} for sub ${sub.id}`);
      } else {
        sent++;
      }
    } catch (err) {
      console.error(`push: send failed for sub ${sub.id}:`, err);
    }
  }
  return sent;
}

export async function saveSubscription(
  env: UEnv,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  // An endpoint belongs to one browser; a new sign-in on it moves it to that user.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, user_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
       user_id = excluded.user_id`,
  )
    .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now(), env.USER_ID)
    .run();
}

export async function deleteSubscription(env: UEnv, endpoint: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`)
    .bind(endpoint, env.USER_ID)
    .run();
}
