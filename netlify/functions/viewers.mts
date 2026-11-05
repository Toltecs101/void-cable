import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Each viewer pings every ~25s. A ping writes its own key (no shared counter),
// keyed by a 30-second bucket: v/<bucket>/<channel>/<viewer>.
// Counting = listing the current and previous bucket.
const BUCKET_MS = 30_000;

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "viewers", consistency: "strong" });
  const bucket = Math.floor(Date.now() / BUCKET_MS);

  if (req.method === "POST") {
    let body: { ch?: unknown; id?: unknown } = {};
    try { body = await req.json(); } catch {}
    const ch = String(body.ch ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
    const id = String(body.id ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
    if (ch && id) await store.set(`v/${bucket}/${ch}/${id}`, "1");
    if (Math.random() < 0.1) context.waitUntil(cleanup(store, bucket));
  }

  // newest bucket wins, so someone who just switched channels counts once, on the new one
  const lastChannel = new Map<string, string>();
  for (const b of [bucket - 1, bucket]) {
    const { blobs } = await store.list({ prefix: `v/${b}/` });
    for (const { key } of blobs) {
      const [, , ch, id] = key.split("/");
      if (ch && id) lastChannel.set(id, ch);
    }
  }
  const channels: Record<string, number> = {};
  for (const ch of lastChannel.values()) channels[ch] = (channels[ch] ?? 0) + 1;

  return Response.json(
    { total: lastChannel.size, channels },
    { headers: { "cache-control": "no-store" } },
  );
};

// delete buckets older than a minute so the store stays small
async function cleanup(store: ReturnType<typeof getStore>, bucket: number) {
  const { directories } = await store.list({ prefix: "v/", directories: true });
  for (const dir of directories) {
    const b = Number(dir.replace(/\/$/, "").split("/").pop());
    if (!Number.isFinite(b) || b >= bucket - 2) continue;
    const { blobs } = await store.list({ prefix: `v/${b}/` });
    await Promise.all(blobs.map(({ key }) => store.delete(key)));
  }
}

export const config: Config = {
  path: "/api/viewers",
  method: ["GET", "POST"],
};
