import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// "Sign in with Discord" for VOID CABLE chat.
// Only the `identify` scope is requested: Discord shares the person's ID, name and avatar, never their email.
// The session is a signed cookie (HMAC-SHA256 with SESSION_SECRET); nothing else is stored about the person.
//
// Netlify environment variables (scope: Functions):
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET  from the Discord Developer Portal app
//   SESSION_SECRET                             any long random string
// Redirect URL to register in Discord: https://<your site>/api/auth/callback

const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

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
    return u.exp > Date.now() ? (u as { id: string; name: string; avatar: string; exp: number }) : null;
  } catch { return null; }
}
const safeReturn = (r: string | null) => (r && /^[a-z0-9-]{1,40}$/.test(r) ? r : "");

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();
  const clientId = Netlify.env.get("DISCORD_CLIENT_ID");
  const clientSecret = Netlify.env.get("DISCORD_CLIENT_SECRET");
  const secret = Netlify.env.get("SESSION_SECRET");
  const configured = !!(clientId && clientSecret && secret);
  const redirectUri = `${url.origin}/api/auth/callback`;

  if (action === "me") {
    const user = configured ? await sessionUser(req) : null;
    let admin = false;
    if (user) admin = (await getStore({ name: "chat", consistency: "strong" }).get(`admin/${user.id}`)) !== null;
    return Response.json(
      { configured, user: user ? { id: user.id, name: user.name, avatar: user.avatar } : null, admin },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (!configured) return Response.json({ error: "Chat sign-in isn't set up yet." }, { status: 503 });

  if (action === "login") {
    const state = b64u(crypto.getRandomValues(new Uint8Array(18)));
    const back = safeReturn(url.searchParams.get("r"));
    const to = new URL("https://discord.com/oauth2/authorize");
    to.search = new URLSearchParams({ client_id: clientId!, response_type: "code", redirect_uri: redirectUri, scope: "identify", state, prompt: "none" }).toString();
    const h = new Headers({ location: to.toString(), "cache-control": "no-store" });
    h.append("set-cookie", cookie("vc_state", `${state}.${back}`, 600, "/api/auth"));
    return new Response(null, { status: 302, headers: h });
  }

  if (action === "callback") {
    const [state, back] = (readCookie(req, "vc_state") || "").split(".");
    const code = url.searchParams.get("code");
    const home = `/?chat=1${back ? "#" + back : ""}`;
    const fail = (why: string) => {
      const h = new Headers({ location: `/?chat=1&signin=${why}${back ? "#" + back : ""}` });
      h.append("set-cookie", cookie("vc_state", "", 0, "/api/auth"));
      return new Response(null, { status: 302, headers: h });
    };
    if (!state || state !== url.searchParams.get("state") || !code) return fail("expired");

    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
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
    const payload = Buffer.from(JSON.stringify({ id: d.id, name, avatar, exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
    const h = new Headers({ location: home, "cache-control": "no-store" });
    h.append("set-cookie", cookie("vc_session", `${payload}.${await sign(payload, secret!)}`, SESSION_DAYS * 86400));
    h.append("set-cookie", cookie("vc_state", "", 0, "/api/auth"));
    return new Response(null, { status: 302, headers: h });
  }

  if (action === "logout" && req.method === "POST") {
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", cookie("vc_session", "", 0));
    return new Response(JSON.stringify({ ok: true }), { headers: h });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

export const config: Config = {
  path: ["/api/auth/login", "/api/auth/callback", "/api/auth/me", "/api/auth/logout"],
};
