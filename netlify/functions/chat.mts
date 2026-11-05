import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Per-channel chat. Anyone can read; posting needs a Google (or Discord) sign-in (see auth.mts).
// Each message is its own key, so nothing is read-modify-written:
//   m/<channel>/<13-digit time>-<rand>   message JSON
//   d/<channel>/<message key>            "deleted" marker so open pages drop it
//   ban/<user id>, admin/<user id>, rl/<user id> (last post time); Google ids start with "g"
// Messages older than 24 hours are cleaned up.
//
// Moderator: set ADMIN_CODE in Netlify; a signed-in person who sends "/admin <code>" becomes a moderator.

const MAX_LEN = 200;
const KEEP_MS = 24 * 3600e3;
const GAP_MS = 2500;
const LINK_RE = /(https?:\/\/|www\.|discord\.gg|\b[a-z0-9-]+\.(com|net|org|gg|io|ly|me|tv|xyz|co|app)\b)/i;
const enc = new TextEncoder();
const okCh = (c: unknown) => typeof c === "string" && /^[a-z0-9-]{1,40}$/.test(c);

async function sessionUser(req: Request) {
  const secret = Netlify.env.get("SESSION_SECRET");
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)vc_session=([^;]+)/);
  if (!secret || !m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const good = Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(payload))).toString("base64url");
  if (good !== sig) return null;
  try {
    const u = JSON.parse(Buffer.from(payload, "base64url").toString());
    return u.exp > Date.now() ? (u as { id: string; name: string; avatar: string }) : null;
  } catch { return null; }
}
const keyTime = (k: string) => Number(k.split("/").pop()?.split("-")[0]) || 0;
const err = (error: string, status: number) => Response.json({ error }, { status });

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "chat", consistency: "strong" });
  const now = Date.now();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const ch = url.searchParams.get("ch");
    if (!okCh(ch)) return Response.json({ now, msgs: [], deleted: [] });
    const since = Number(url.searchParams.get("since")) || 0;
    const [{ blobs }, gone] = await Promise.all([store.list({ prefix: `m/${ch}/` }), store.list({ prefix: `d/${ch}/` })]);
    const deleted = gone.blobs.map((b) => b.key.slice(`d/${ch}/`.length));
    const dead = new Set(deleted);
    const fresh = blobs
      .map((b) => b.key)
      .filter((k) => !dead.has(k) && keyTime(k) > since && keyTime(k) > now - KEEP_MS)
      .sort()
      .slice(since ? -40 : -30);
    const msgs = (await Promise.all(fresh.map(async (k) => {
      const m = (await store.get(k, { type: "json" })) as Record<string, unknown> | null;
      return m ? { key: k, ...m } : null;
    }))).filter(Boolean);
    return Response.json({ now, msgs, deleted: since ? deleted : [] }, { headers: { "cache-control": "no-store" } });
  }

  if (req.method !== "POST") return err("Not allowed", 405);
  const user = await sessionUser(req);
  if (!user) return err("Sign in with Discord to chat.", 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const isAdmin = (await store.get(`admin/${user.id}`)) !== null;

  if (body.action === "claim") {
    const code = Netlify.env.get("ADMIN_CODE");
    if (!code || String(body.code ?? "") !== code) return err("That code isn't right.", 403);
    await store.set(`admin/${user.id}`, "1");
    return Response.json({ ok: true });
  }

  if (body.action === "delete" || body.action === "ban") {
    if (!isAdmin) return err("Only moderators can do that.", 403);
    const ch = body.ch;
    if (!okCh(ch)) return err("Unknown channel.", 400);
    if (body.action === "delete") {
      const key = String(body.key ?? "");
      if (!key.startsWith(`m/${ch}/`)) return err("Unknown message.", 400);
      await Promise.all([store.delete(key), store.set(`d/${ch}/${key}`, "1")]);
      return Response.json({ ok: true });
    }
    const uid = String(body.uid ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
    if (!uid) return err("Unknown person.", 400);
    await store.set(`ban/${uid}`, "1");
    const { blobs } = await store.list({ prefix: `m/${ch}/` });
    const theirs = (await Promise.all(blobs.slice(-200).map(async ({ key }) => {
      const m = (await store.get(key, { type: "json" })) as { uid?: string } | null;
      return m && m.uid === uid ? key : null;
    }))).filter(Boolean) as string[];
    await Promise.all(theirs.flatMap((k) => [store.delete(k), store.set(`d/${ch}/${k}`, "1")]));
    return Response.json({ ok: true, removed: theirs.length });
  }

  // send a message
  if ((await store.get(`ban/${user.id}`)) !== null) return err("You can't post in this chat.", 403);
  if (!user.name) return err("Pick a chat name first.", 400);
  const ch = body.ch;
  if (!okCh(ch)) return err("Unknown channel.", 400);
  const text = String(body.text ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return err("Type a message first.", 400);
  if (text.length > MAX_LEN) return err(`Keep it under ${MAX_LEN} characters.`, 400);
  if (LINK_RE.test(text)) return err("Links aren't allowed in chat.", 400);
  const last = Number(await store.get(`rl/${user.id}`)) || 0;
  if (now - last < GAP_MS) return err("Slow down a little.", 429);
  await store.set(`rl/${user.id}`, String(now));

  const key = `m/${ch}/${now}-${Math.random().toString(36).slice(2, 8)}`;
  const msg = { uid: user.id, name: user.name, avatar: user.avatar, text, t: now };
  await store.setJSON(key, msg);
  if (Math.random() < 0.04) context.waitUntil(cleanup(store, now));
  return Response.json({ ok: true, msg: { key, ...msg } });
};

async function cleanup(store: ReturnType<typeof getStore>, now: number) {
  for (const prefix of ["m/", "d/"]) {
    const { blobs } = await store.list({ prefix });
    const old = blobs.filter(({ key }) => {
      const t = prefix === "m/" ? keyTime(key) : keyTime(key.split("/").slice(2).join("/"));
      return t && t < now - KEEP_MS;
    });
    await Promise.all(old.map(({ key }) => store.delete(key)));
  }
}

export const config: Config = {
  path: "/api/chat",
  method: ["GET", "POST"],
};
