import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Emote reactions everyone on a channel can see.
// Each reaction is its own key (no shared counter): r/<channel>/<time>-<sender>-<emote index>.
// Viewers poll with ?since=<server time> and get the reactions sent after that.
const EMOTE_COUNT = 6;
const WINDOW_MS = 15_000;
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, n);

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "reactions", consistency: "strong" });
  const now = Date.now();

  if (req.method === "POST") {
    let body: { ch?: unknown; id?: unknown; i?: unknown } = {};
    try { body = await req.json(); } catch {}
    const ch = clean(body.ch, 40);
    const id = clean(body.id, 12).replace(/-/g, "");
    const i = Number(body.i);
    if (!ch || !id || !Number.isInteger(i) || i < 0 || i >= EMOTE_COUNT) {
      return Response.json({ ok: false }, { status: 400 });
    }
    await store.set(`r/${ch}/${now}-${id}-${i}`, "1");
    if (Math.random() < 0.05) context.waitUntil(cleanup(store, now));
    return Response.json({ ok: true, now });
  }

  const url = new URL(req.url);
  const ch = clean(url.searchParams.get("ch"), 40);
  const since = Number(url.searchParams.get("since")) || 0;
  if (!ch) return Response.json({ now, items: [] });

  const { blobs } = await store.list({ prefix: `r/${ch}/` });
  const items = blobs
    .map(({ key }) => {
      const [t, id, i] = key.slice(`r/${ch}/`.length).split("-");
      return { t: Number(t), id, i: Number(i) };
    })
    .filter((x) => x.t > since && x.t > now - WINDOW_MS && x.i >= 0 && x.i < EMOTE_COUNT)
    .sort((a, b) => a.t - b.t)
    .slice(-30);

  return Response.json({ now, items }, { headers: { "cache-control": "no-store" } });
};

// drop reactions older than a minute so listing stays fast
async function cleanup(store: ReturnType<typeof getStore>, now: number) {
  const { blobs } = await store.list({ prefix: "r/" });
  const old = blobs.filter(({ key }) => Number(key.split("/")[2]?.split("-")[0]) < now - 60_000);
  await Promise.all(old.map(({ key }) => store.delete(key)));
}

export const config: Config = {
  path: "/api/react",
  method: ["GET", "POST"],
};
