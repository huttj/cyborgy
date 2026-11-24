// Users, magic-link sign-in and admin approval.
//
// Anyone can ask for access with their email. A new address becomes a
// 'pending' user and the admins get an email + push. Only approved users get
// email from us (a magic link), so a mistyped or fake signup never causes a
// bounce. An email in the ADMIN_EMAILS secret is approved at once; the first
// one to sign in claims the owner row (user 1, the data from before users).
import type { Env, UEnv, UserRow } from "./types";
import { createLoginToken, now } from "./db";
import { pushToUser } from "./push";

export const OWNER_ID = 1;
const FROM = "cyborgy <hello@cyborgy.app>";
/** Cap on open requests, so a flood of signups cannot flood the admins. */
const MAX_PENDING = 50;
/** Magic links per user per 15 minutes. */
const MAX_LINKS = 3;

/** A user-scoped Env: USER_ID set, TIMEZONE = the user's zone. */
export function forUser(env: Env, user: Pick<UserRow, "id" | "timezone">): UEnv {
  return { ...env, USER_ID: user.id, TIMEZONE: user.timezone || env.TIMEZONE };
}

export async function getUser(env: Env, id: number): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

/** The owner's Env (Telegram bot, Shortcut endpoint, ?key= fallback). */
export async function ownerEnv(env: Env): Promise<UEnv> {
  const owner = await getUser(env, OWNER_ID);
  return forUser(env, owner ?? { id: OWNER_ID, timezone: null });
}

export async function approvedUsers(env: Env): Promise<UserRow[]> {
  return (await env.DB.prepare(`SELECT * FROM users WHERE status = 'approved' ORDER BY id`).all<UserRow>())
    .results;
}

function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

const isTimezone = (tz: string | null | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

async function sendEmail(env: Env, to: string, subject: string, text: string, html: string): Promise<void> {
  if (!env.EMAIL) throw new Error("email is not configured (no EMAIL binding)");
  await env.EMAIL.send({ to, from: FROM, subject, text, html });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function linkEmail(intro: string, link: string, note: string): { text: string; html: string } {
  return {
    text: `${intro}\n\n${link}\n\n${note}`,
    html:
      `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;max-width:34em">` +
      `<p>${esc(intro)}</p>` +
      `<p><a href="${esc(link)}" style="display:inline-block;background:#e07a5f;color:#fff;padding:.6em 1.6em;border-radius:6px;text-decoration:none">Sign in to cyborgy</a></p>` +
      `<p style="color:#777;font-size:13px">${esc(note)}</p></div>`,
  };
}

async function sendMagicLink(env: Env, user: UserRow, ttlSeconds: number, intro: string): Promise<void> {
  const token = await createLoginToken(forUser(env, user), ttlSeconds);
  const link = `${env.PUBLIC_URL}/auth?t=${token}`;
  const minutes = Math.round(ttlSeconds / 60);
  const note =
    minutes >= 120
      ? `The link works once, for ${Math.round(minutes / 60)} hours.`
      : `The link works once, for ${minutes} minutes. If you did not ask for it, ignore this email.`;
  const { text, html } = linkEmail(intro, link, note);
  await sendEmail(env, user.email!, "Sign in to cyborgy", text, html);
}

export type SignInResult =
  | { kind: "link_sent" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

/** POST /login with an email: send a magic link, or file an access request. */
export async function requestSignIn(env: Env, rawEmail: string, timezone: string | null): Promise<SignInResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "error", message: "That does not look like an email address." };
  const tz = isTimezone(timezone) ? timezone : null;

  let user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>();
  if (!user && adminEmails(env).includes(email)) {
    // First admin sign-in claims the owner row; later admins get their own.
    user = await env.DB.prepare(
      `UPDATE users SET email = ?, timezone = COALESCE(timezone, ?) WHERE id = ? AND email IS NULL RETURNING *`,
    )
      .bind(email, tz, OWNER_ID)
      .first<UserRow>();
    if (!user) {
      user = await env.DB.prepare(
        `INSERT INTO users (email, status, is_admin, timezone, created_at, approved_at)
         VALUES (?, 'approved', 1, ?, ?, ?) RETURNING *`,
      )
        .bind(email, tz, now(), now())
        .first<UserRow>();
    }
  }
  if (!user) {
    const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`).first<{
      n: number;
    }>();
    if ((pending?.n ?? 0) >= MAX_PENDING) return { kind: "pending" };
    user = await env.DB.prepare(
      `INSERT INTO users (email, status, timezone, created_at) VALUES (?, 'pending', ?, ?) RETURNING *`,
    )
      .bind(email, tz, now())
      .first<UserRow>();
    await notifyAdminsOfRequest(env, email).catch((err) => console.error("signup notify:", err));
    return { kind: "pending" };
  }
  if (user.status !== "approved") return { kind: "pending" };

  if (tz && tz !== user.timezone) {
    await env.DB.prepare(`UPDATE users SET timezone = ? WHERE id = ?`).bind(tz, user.id).run();
  }
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_tokens WHERE user_id = ? AND expires_at > ?`,
  )
    .bind(user.id, now() + 600 - 900) // tokens made in the last 15 minutes (10-minute TTL)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_LINKS) {
    return { kind: "error", message: "Too many sign-in links. Use the last one, or wait 15 minutes." };
  }
  try {
    await sendMagicLink(env, user, 600, "Tap the button to sign in to cyborgy.");
  } catch (err) {
    console.error("magic link email:", err);
    return { kind: "error", message: "The sign-in email could not be sent. Try again later." };
  }
  return { kind: "link_sent" };
}

async function notifyAdminsOfRequest(env: Env, email: string): Promise<void> {
  const admins = (
    await env.DB.prepare(`SELECT * FROM users WHERE is_admin = 1 AND status = 'approved'`).all<UserRow>()
  ).results;
  const title = `Access request: ${email}`;
  const url = `${env.PUBLIC_URL}/#settings`;
  for (const admin of admins) {
    await pushToUser(forUser(env, admin), { title, body: "Approve or reject it in Settings.", url }).catch(
      (err) => console.error("signup push:", err),
    );
    if (admin.email) {
      await sendEmail(
        env,
        admin.email,
        title,
        `${email} asked for access to cyborgy.\n\nApprove or reject it in Settings: ${url}`,
        `<p style="font-family:system-ui,sans-serif">${esc(email)} asked for access to cyborgy.</p>` +
          `<p style="font-family:system-ui,sans-serif"><a href="${esc(url)}">Approve or reject it in Settings</a></p>`,
      ).catch((err) => console.error("signup email:", err));
    }
  }
}

/** Admin: list users for the Settings tab. */
export async function listUsers(env: Env): Promise<UserRow[]> {
  return (
    await env.DB.prepare(
      `SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`,
    ).all<UserRow>()
  ).results;
}

/** Admin: approve (and email a 24-hour sign-in link) or reject a user. */
export async function setUserStatus(
  env: Env,
  id: number,
  status: "approved" | "rejected",
): Promise<{ ok: boolean; error?: string; emailed?: boolean }> {
  if (id === OWNER_ID) return { ok: false, error: "The owner cannot be changed." };
  const user = await env.DB.prepare(
    `UPDATE users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END
     WHERE id = ? RETURNING *`,
  )
    .bind(status, status, now(), id)
    .first<UserRow>();
  if (!user) return { ok: false, error: "No such user." };
  if (status === "rejected") {
    // Sign them out everywhere.
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    return { ok: true };
  }
  try {
    await sendMagicLink(env, user, 24 * 3600, "You have access to cyborgy now. Tap the button to sign in.");
    return { ok: true, emailed: true };
  } catch (err) {
    console.error("approval email:", err);
    return { ok: true, emailed: false };
  }
}
