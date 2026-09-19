// SPDX-License-Identifier: MIT
import { SOURCES, rawUrl, sourcesFor } from "./sources.js";
import { stateName } from "./token.js";
export { ChannelFailover } from "./failover.js";
export { CatalogState } from "./catalog_state.js";

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

function catalogStub(env) {
  return env.CATALOG_STATE.getByName("live");
}

async function catalogPlaylist(request, env) {
  const target = new URL("https://catalog.internal/playlist");
  target.searchParams.set("origin", new URL(request.url).origin);

  return catalogStub(env).fetch(new Request(target, {
    method: request.method
  }));
}

async function catalogStatus(env) {
  return catalogStub(env).fetch("https://catalog.internal/status");
}

async function forceCatalogRefresh(env) {
  const response = await catalogStub(env).fetch(new Request(
    "https://catalog.internal/refresh?force=1",
    { method: "POST" }
  ));

  if (!response.ok) {
    const detail = await response.text();
    throw new Error("scheduled catalog refresh failed: " + detail);
  }

  return response;
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
        vod: "/vod.m3u8",
        refresh_interval_hours: 3,
        failover: "reactive"
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
      return catalogStatus(env);
    }

    if ((url.pathname === "/list.m3u8" || url.pathname === "/live.m3u8") &&
        (request.method === "GET" || request.method === "HEAD")) {
      return catalogPlaylist(request, env);
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
        detail: "VOD compact-index integration is in progress.",
        sources: sourcesFor("vod").map((source) => source.id)
      });
    }

    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(forceCatalogRefresh(env));
  }
};
