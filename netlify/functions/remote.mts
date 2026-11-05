import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Phone remote. A TV shows a 5-digit code; the phone sends commands for that code,
// the TV polls for them. The TV also posts what it's playing so the phone can show it.
//   commands: c/<code>/<time>-<rand>  (one key each, value = JSON command)
//   state:    s/<code>                (latest "now playing" from the TV)
const COMMANDS = new Set(["up", "down", "sound", "full", "tune", "react"]);
const WINDOW_MS = 30_000;

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "remote", consistency: "strong" });
  const url = new URL(req.url);
  const now = Date.now();
  if (url.searchParams.get("ping")) return Response.json({ ok: true, now });

  if (req.method === "POST") {
    let body: { code?: unknown; cmd?: unknown; arg?: unknown; state?: unknown } = {};
    try { body = await req.json(); } catch {}
    const code = String(body.code ?? "");
    if (!/^\d{5}$/.test(code)) return Response.json({ ok: false }, { status: 400 });

    if (body.state && typeof body.state === "object") {
      const st = body.state as Record<string, unknown>;
      const safe = {
        ch: String(st.ch ?? "").slice(0, 40),
        num: String(st.num ?? "").slice(0, 8),
        name: String(st.name ?? "").slice(0, 40),
        title: String(st.title ?? "").slice(0, 160),
        sound: !!st.sound,
      };
      await store.setJSON(`s/${code}`, safe);
      return Response.json({ ok: true, now });
    }

    const cmd = String(body.cmd ?? "");
    if (!COMMANDS.has(cmd)) return Response.json({ ok: false }, { status: 400 });
    const arg = body.arg == null ? null : String(body.arg).slice(0, 40);
    const rand = Math.random().toString(36).slice(2, 8);
    await store.setJSON(`c/${code}/${now}-${rand}`, { cmd, arg });
    if (Math.random() < 0.05) context.waitUntil(cleanup(store, now));
    return Response.json({ ok: true, now });
  }

  const code = String(url.searchParams.get("code") ?? "");
  if (!/^\d{5}$/.test(code)) return Response.json({ now, cmds: [], state: null });
  const since = Number(url.searchParams.get("since")) || 0;

  const { blobs } = await store.list({ prefix: `c/${code}/` });
  const fresh = blobs
    .map(({ key }) => ({ key, t: Number(key.split("/")[2]?.split("-")[0]) }))
    .filter((x) => x.t > since && x.t > now - WINDOW_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-20);
  const cmds = (await Promise.all(fresh.map(async (x) => ({ t: x.t, ...((await store.get(x.key, { type: "json" })) ?? {}) }))))
    .filter((c) => c.cmd);
  const state = await store.get(`s/${code}`, { type: "json" });

  return Response.json({ now, cmds, state }, { headers: { "cache-control": "no-store" } });
};

// drop commands older than two minutes
async function cleanup(store: ReturnType<typeof getStore>, now: number) {
  const { blobs } = await store.list({ prefix: "c/" });
  const old = blobs.filter(({ key }) => Number(key.split("/")[2]?.split("-")[0]) < now - 120_000);
  await Promise.all(old.map(({ key }) => store.delete(key)));
}

export const config: Config = {
  path: "/api/remote",
  method: ["GET", "POST"],
};
