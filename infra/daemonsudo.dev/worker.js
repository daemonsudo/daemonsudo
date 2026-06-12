/**
 * daemonsudo.dev — Cloudflare Worker.
 *
 * POST /ping  → opt-in telemetry collector (README documents the payload:
 *               exactly { version, anon_id }). Each valid ping becomes one
 *               Analytics Engine data point; anything malformed is dropped
 *               silently. Always answers 200 — the client fails silent anyway.
 * everything else → redirect to the GitHub repo.
 */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ping") {
      if (req.method === "POST") {
        try {
          const { version, anon_id } = await req.json();
          if (typeof version === "string" && typeof anon_id === "string" && env.PINGS) {
            env.PINGS.writeDataPoint({
              blobs: [version.slice(0, 32)],
              indexes: [anon_id.slice(0, 32)],
            });
          }
        } catch {
          /* malformed ping — drop */
        }
      }
      return new Response("ok", { status: 200 });
    }
    return Response.redirect("https://github.com/daemonsudo/daemonsudo", 302);
  },
};
