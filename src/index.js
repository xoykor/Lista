// SPDX-License-Identifier: MIT
import { SOURCES, rawUrl, sourcesFor } from "./sources.js";
import { buildCatalog, renderLiveM3U } from "./catalog.js";
import { stateName } from "./token.js";
export { ChannelFailover } from "./failover.js";

const LIVE_CACHE_MS = 5 * 60 * 1000;
let liveCache = null;
let liveBuild = null;

function json(status, value) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function publicSource(source) {
  const raw = rawUrl(source);
  const value = {
    id: source.id,
    kind: source.kind,
    format: source.format,
    priority: source.priority
  };

  if (source.provider) {
    value.provider = source.provider;
    value.region = source.region || null;
    value.dynamic = true;
  } else {
    value.repository = source.owner + "/" + source.repo;
    value.branch = source.branch;
    value.path = source.path;
    value.raw = raw;
    value.dynamic = false;
  }

  return value;
}

async function livePlaylist(request) {
  const now = Date.now();

  if (liveCache && now < liveCache.expiresAt) {
    return new Response(liveCache.body, {
      headers: {
        "Content-Type": "audio/x-mpegurl; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "X-Lista-Cache": "hit"
      }
    });
  }

  if (!liveBuild) {
    liveBuild = (async () => {
      const built = await buildCatalog(sourcesFor("live"));
      const origin = new URL(request.url).origin;
      const body = renderLiveM3U(built.items, origin);

      liveCache = {
        body,
        status: built.status,
        itemCount: built.items.length,
        expiresAt: Date.now() + LIVE_CACHE_MS
      };
      return liveCache;
    })().finally(() => {
      liveBuild = null;
    });
  }

  const built = await liveBuild;
  return new Response(built.body, {
    headers: {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Lista-Cache": "miss"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return json(200, {
        service: "Lista Auto-Healing",
        live: "/list.m3u8",
        health: "/healthz",
        sources: "/sources.json",
        status: "/status.json",
        vod: "/vod.m3u8"
      });
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      return new Response(request.method === "HEAD" ? null : "ok\n", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (url.pathname === "/sources.json" && request.method === "GET") {
      return json(200, SOURCES.map(publicSource));
    }

    if (url.pathname === "/status.json" && request.method === "GET") {
      if (!liveCache) {
        return json(200, { cached: false, item_count: 0, upstreams: [] });
      }
      return json(200, {
        cached: Date.now() < liveCache.expiresAt,
        item_count: liveCache.itemCount,
        expires_at: new Date(liveCache.expiresAt).toISOString(),
        upstreams: liveCache.status
      });
    }

    if ((url.pathname === "/list.m3u8" || url.pathname === "/live.m3u8") &&
        (request.method === "GET" || request.method === "HEAD")) {
      const result = await livePlaylist(request);
      if (request.method === "HEAD") {
        return new Response(null, { status: result.status, headers: result.headers });
      }
      return result;
    }

    const channelMatch = url.pathname.match(/^\/channel\/([A-Za-z0-9_-]+)$/);
    if (channelMatch && (request.method === "GET" || request.method === "HEAD")) {
      const token = channelMatch[1];
      const stub = env.CHANNEL_FAILOVER.getByName(stateName(token));
      const target = new URL("https://channel.internal/");
      target.searchParams.set("token", token);
      return stub.fetch(new Request(target, {
        method: request.method,
        headers: request.headers
      }));
    }

    if (url.pathname === "/vod.m3u8") {
      return json(501, {
        error: "vod_index_pending",
        detail: "VOD sources are registered; the 128 MB-safe deduplicating index is the next stage.",
        sources: sourcesFor("vod").map((source) => source.id)
      });
    }

    return new Response("not found\n", { status: 404 });
  }
};
