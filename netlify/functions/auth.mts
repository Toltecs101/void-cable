import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Sign-in for VOID CABLE chat. Google is the main way in; Discord still works if its keys are set.
// Google: only the account's ID is kept. Google also sends the person's name and picture; they are thrown away
// and the person picks a chat name instead (names are unique, so nobody can pose as someone else).
// Discord: only the `identify` scope is requested (ID, name, avatar; never email).
// The session is a signed cookie (HMAC-SHA256 with SESSION_SECRET).
//
// Netlify environment variables:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET    Google Cloud OAuth client (Web application)
//     redirect URL to register: https://<your site>/api/auth/google
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET  optional, Discord Developer Portal app
//     redirect URL to register: https://<your site>/api/auth/callback
//   SESSION_SECRET                            any long random string

const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");
type User = { id: string; name: string; avatar: string; exp: number };

async function sign(data: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
function cookie(name: string, value: string, maxAge: number, path = "/") {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function readCookie(req: Request, name: string) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
async function sessionUser(req: Request) {
  const secret = Netlify.env.get("SESSION_SECRET");
  const raw = readCookie(req, "vc_session");
  if (!secret || !raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || (await sign(payload, secret)) !== sig) return null;
  try {
    const u = JSON.parse(Buffer.from(payload, "base64url").toString());
    return u.exp > Date.now() ? (u as User) : null;
  } catch { return null; }
}
async function sessionCookie(u: Omit<User, "exp">, secret: string) {
  const payload = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  return cookie("vc_session", `${payload}.${await sign(payload, secret)}`, SESSION_DAYS * 86400);
}
const safeReturn = (r: string | null) => (r && /^[a-z0-9-]{1,40}$/.test(r) ? r : "");

// chat names
const LINK_RE = /(https?:\/\/|www\.|discord\.gg|\b[a-z0-9-]+\.(com|net|org|gg|io|ly|me|tv|xyz|co|app)\b)/i;
const RESERVED = /^(admin|administrator|mod|moderator|staff|owner|system|voidcable|voidcabletv|void|official|support|anonymous)$/;
const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
function cleanName(raw: unknown) {
  const n = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (n.length < 2 || n.length > 20) return { error: "Pick a name 2 to 20 characters long." };
  if (!/^[A-Za-z0-9 _.\-]+$/.test(n)) return { error: "Use letters, numbers, spaces, _ . or - only." };
  if (LINK_RE.test(n)) return { error: "Names can't look like links." };
  const key = normName(n);
  if (key.length < 2) return { error: "Use at least two letters or numbers." };
  if (RESERVED.test(key)) return { error: "That name is taken." };
  return { name: n, key };
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();
  const secret = Netlify.env.get("SESSION_SECRET");
  const google = { id: Netlify.env.get("GOOGLE_CLIENT_ID"), secret: Netlify.env.get("GOOGLE_CLIENT_SECRET") };
  const discord = { id: Netlify.env.get("DISCORD_CLIENT_ID"), secret: Netlify.env.get("DISCORD_CLIENT_SECRET") };
  const providers = { google: !!(secret && google.id && google.secret), discord: !!(secret && discord.id && discord.secret) };
  const configured = providers.google || providers.discord;
  const store = getStore({ name: "chat", consistency: "strong" });

  if (action === "me") {
    const user = configured ? await sessionUser(req) : null;
    const admin = user ? (await store.get(`admin/${user.id}`)) !== null : false;
    return Response.json(
      { configured, providers, user: user ? { id: user.id, name: user.name, avatar: user.avatar } : null, needsName: !!user && !user.name, admin },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (!configured) return Response.json({ error: "Chat sign-in isn't set up yet." }, { status: 503 });

  if (action === "login") {
    const want = url.searchParams.get("p");
    const p = want === "discord" && providers.discord ? "discord" : providers.google ? "google" : "discord";
    const state = b64u(crypto.getRandomValues(new Uint8Array(18)));
    const back = safeReturn(url.searchParams.get("r"));
    const to =
      p === "google"
        ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
        : new URL("https://discord.com/oauth2/authorize");
    to.search = new URLSearchParams(
      p === "google"
        ? { client_id: google.id!, response_type: "code", redirect_uri: `${url.origin}/api/auth/google`, scope: "openid profile", state, prompt: "select_account" }
        : { client_id: discord.id!, response_type: "code", redirect_uri: `${url.origin}/api/auth/callback`, scope: "identify", state, prompt: "none" },
    ).toString();
    const h = new Headers({ location: to.toString(), "cache-control": "no-store" });
    h.append("set-cookie", cookie("vc_state", `${state}.${back}`, 600, "/api/auth"));
    return new Response(null, { status: 302, headers: h });
  }

  if (action === "callback" || action === "google") {
    const [state, back] = (readCookie(req, "vc_state") || "").split(".");
    const code = url.searchParams.get("code");
    const home = `/?chat=1${back ? "#" + back : ""}`;
    const fail = (why: string) => {
      const h = new Headers({ location: `/?chat=1&signin=${why}${back ? "#" + back : ""}` });
      h.append("set-cookie", cookie("vc_state", "", 0, "/api/auth"));
      return new Response(null, { status: 302, headers: h });
    };
    if (!state || state !== url.searchParams.get("state") || !code) return fail("expired");

    let user: Omit<User, "exp">;
    if (action === "google") {
      if (!providers.google) return fail("off");
      const tok = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: google.id!, client_secret: google.secret!, grant_type: "authorization_code", code, redirect_uri: `${url.origin}/api/auth/google` }),
      });
      if (!tok.ok) return fail("google");
      const { id_token } = (await tok.json()) as { id_token?: string };
      // The token came straight from Google over HTTPS, so its contents can be read directly.
      let claims: { sub?: string; aud?: string; iss?: string; exp?: number } = {};
      try { claims = JSON.parse(Buffer.from(String(id_token).split(".")[1], "base64url").toString()); } catch {}
      const okIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
      if (!claims.sub || claims.aud !== google.id || !okIss || (claims.exp || 0) * 1000 < Date.now()) return fail("google");
      const id = "g" + String(claims.sub).replace(/\D/g, "");
      const nick = (await store.get(`nick/${id}`)) || "";
      user = { id, name: nick, avatar: "" };
    } else {
      if (!providers.discord) return fail("off");
      const tok = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: discord.id!, client_secret: discord.secret!, grant_type: "authorization_code", code, redirect_uri: `${url.origin}/api/auth/callback` }),
      });
      if (!tok.ok) return fail("discord");
      const { access_token } = (await tok.json()) as { access_token: string };
      const me = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${access_token}` } });
      if (!me.ok) return fail("discord");
      const d = (await me.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
      const name = String(d.global_name || d.username || "viewer").replace(/[\u0000-\u001f]/g, "").slice(0, 32);
      const avatar = d.avatar
        ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(d.id) >> 22n) % 6n)}.png`;
      user = { id: d.id, name, avatar };
    }

    const h = new Headers({ location: home, "cache-control": "no-store" });
    h.append("set-cookie", await sessionCookie(user, secret!));
    h.append("set-cookie", cookie("vc_state", "", 0, "/api/auth"));
    return new Response(null, { status: 302, headers: h });
  }

  // pick a chat name (Google sign-ins)
  if (action === "name" && req.method === "POST") {
    const user = await sessionUser(req);
    if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {}
    const c = cleanName(body.name);
    if ("error" in c) return Response.json({ error: c.error }, { status: 400 });
    const owner = await store.get(`name/${c.key}`);
    if (owner && owner !== user.id) return Response.json({ error: "Someone already has that name." }, { status: 409 });
    const old = await store.get(`nick/${user.id}`);
    if (old && normName(old) !== c.key) await store.delete(`name/${normName(old)}`);
    await Promise.all([store.set(`name/${c.key}`, user.id), store.set(`nick/${user.id}`, c.name)]);
    const next = { id: user.id, name: c.name, avatar: user.avatar };
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", await sessionCookie(next, secret!));
    return new Response(JSON.stringify({ ok: true, user: next }), { headers: h });
  }

  if (action === "logout" && req.method === "POST") {
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", cookie("vc_session", "", 0));
    return new Response(JSON.stringify({ ok: true }), { headers: h });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

export const config: Config = {
  path: ["/api/auth/login", "/api/auth/callback", "/api/auth/google", "/api/auth/me", "/api/auth/name", "/api/auth/logout"],
};
