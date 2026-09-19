// SPDX-License-Identifier: MIT
import { SOURCES, rawUrl, sourcesFor } from "./sources.js";
import { stateName, verifyConfig } from "./token.js";
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

function validCatalogUploadAuth(request, env) {
  const header = request.headers.get("x-lista-catalog-token") || "";
  const configured = typeof env.CATALOG_UPLOAD_SECRET === "string"
    ? env.CATALOG_UPLOAD_SECRET.trim()
    : "";

  return Boolean(configured && header === configured);
}

async function catalogUpload(request, env, pathname) {
  if (!validCatalogUploadAuth(request, env)) {
    return json(401, { error: "unauthorized" });
  }

  const target = new URL("https://catalog.internal" + pathname);
  const headers = new Headers(request.headers);

  // Authentication is verified at the public Worker boundary. The Durable
  // Object is not publicly routable, so it receives only this internal marker.
  headers.delete("x-lista-catalog-token");
  headers.set("x-lista-internal-upload", "1");

  return catalogStub(env).fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.body
  }));
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
        refresh_interval_hours: 12,
        catalog_builder: "github-actions",
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

    if (
      request.method === "POST" &&
      (url.pathname === "/_catalog/upload/start" ||
       url.pathname === "/_catalog/upload/commit" ||
       url.pathname === "/_catalog/dead/mark" ||
       url.pathname === "/_catalog/dead/clear")
    ) {
      return catalogUpload(
        request,
        env,
        url.pathname.replace("/_catalog", "")
      );
    }

    if (url.pathname === "/_catalog/dead/list" && request.method === "GET") {
      return catalogUpload(request, env, "/dead/list");
    }

    const uploadChunk = url.pathname.match(
      /^\/_catalog\/upload\/chunk\/([A-Za-z0-9._-]+)\/(\d+)$/
    );
    if (uploadChunk && request.method === "PUT") {
      return catalogUpload(
        request,
        env,
        "/upload/chunk/" + uploadChunk[1] + "/" + uploadChunk[2]
      );
    }

    const channelMatch = url.pathname.match(/^\/channel\/([A-Za-z0-9_.-]+)$/);
    if (channelMatch && (request.method === "GET" || request.method === "HEAD")) {
      const token = channelMatch[1];

      /* Verify the HMAC at the public Worker boundary. Durable Object
       * instances can outlive individual deployments, so authentication must
       * not depend on which object isolate happens to serve the channel. */
      try {
        await verifyConfig(token, String(env.TOKEN_SECRET || "").trim());
      } catch {
        return new Response("invalid channel token", {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
            "X-Lista-Token-Error": "invalid"
          }
        });
      }

      const separator = token.lastIndexOf(".");
      const payload = token.slice(0, separator);
      const stub = env.CHANNEL_FAILOVER.getByName(stateName(token));
      const target = new URL("https://channel.internal/");

      return stub.fetch(new Request(target, {
        method: request.method,
        headers: {
          "X-Lista-Internal-Channel": "1",
          "X-Lista-Channel-Payload": payload
        }
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
  }
};
