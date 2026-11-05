import type { Config } from "@netlify/functions";

// Playback log: which tape, how long it took to start, what went wrong.
// Written to the function log only (readable in Netlify's logs), nothing is stored.
const str = (v: unknown, n = 60) => String(v ?? "").replace(/[^\w.\-:]/g, "").slice(0, n);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);

export default async (req: Request) => {
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch {}
  const line = {
    ch: str(b.ch, 40), tape: str(b.tape, 120), brk: !!b.brk, mbps: num(b.mbps), at: num(b.at), ms: num(b.ms),
    result: str(b.result, 20), net: str(b.net, 8), dev: str(b.dev, 8), code: num(b.code), rs: num(b.rs), ns: num(b.ns), buf: num(b.buf),
  };
  console.log("VCDIAG " + JSON.stringify(line));
  return new Response(null, { status: 204 });
};

export const config: Config = { path: "/api/diag", method: "POST" };
