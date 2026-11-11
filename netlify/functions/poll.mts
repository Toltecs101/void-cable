import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

// Viewer poll. One vote per device, and a device can change its vote.
// Each vote is its own key (no shared counter): v/<poll>/<device>-<option index>.
// Counting is a key listing, so nothing has to be read or locked.
const MAX_OPTS = 12;
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, n);

async function tally(store: ReturnType<typeof getStore>, poll: string, id: string) {
  const prefix = `v/${poll}/`;
  const { blobs } = await store.list({ prefix });
  const counts = new Array(MAX_OPTS).fill(0);
  let mine = -1;
  for (const { key } of blobs) {
    const rest = key.slice(prefix.length);
    const cut = rest.lastIndexOf("-");
    const who = rest.slice(0, cut);
    const opt = Number(rest.slice(cut + 1));
    if (!Number.isInteger(opt) || opt < 0 || opt >= MAX_OPTS) continue;
    counts[opt]++;
    if (id && who === id) mine = opt;
  }
  return { counts, mine };
}

export default async (req: Request) => {
  const store = getStore({ name: "polls", consistency: "strong" });

  if (req.method === "POST") {
    let body: { poll?: unknown; id?: unknown; opt?: unknown } = {};
    try { body = await req.json(); } catch {}
    const poll = clean(body.poll, 40);
    const id = clean(body.id, 40).replace(/-/g, "");
    const opt = Number(body.opt);
    if (!poll || id.length < 8 || !Number.isInteger(opt) || opt < 0 || opt >= MAX_OPTS) {
      return Response.json({ ok: false }, { status: 400 });
    }
    // drop this device's earlier vote, then record the new one
    const { blobs } = await store.list({ prefix: `v/${poll}/${id}-` });
    await Promise.all(blobs.map(({ key }) => store.delete(key)));
    await store.set(`v/${poll}/${id}-${opt}`, "1");
    return Response.json({ ok: true, ...(await tally(store, poll, id)) }, { headers: { "cache-control": "no-store" } });
  }

  const url = new URL(req.url);
  const poll = clean(url.searchParams.get("poll"), 40);
  const id = clean(url.searchParams.get("id"), 40).replace(/-/g, "");
  if (!poll) return Response.json({ counts: [], mine: -1 });
  return Response.json(await tally(store, poll, id), { headers: { "cache-control": "no-store" } });
};

export const config: Config = {
  path: "/api/poll",
  method: ["GET", "POST"],
};
