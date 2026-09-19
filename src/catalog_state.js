// SPDX-License-Identifier: MIT
import { DurableObject } from "cloudflare:workers";
import { buildCatalog, renderLiveM3U } from "./catalog.js";
import { sourcesFor } from "./sources.js";

export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
const PLACEHOLDER_ORIGIN = "https://lista.internal.invalid";
const CHUNK_TARGET_CHARS = 32 * 1024;

function json(status, value) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function chunkByLines(text, target = CHUNK_TARGET_CHARS) {
  const chunks = [];
  let current = "";

  for (const line of String(text).split("\n")) {
    const next = line + "\n";
    if (current && current.length + next.length > target) {
      chunks.push(current);
      current = "";
    }
    current += next;
  }

  if (current) chunks.push(current);
  return chunks;
}

export class CatalogState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.refreshPromise = null;
  }

  async metadata() {
    return {
      itemCount: Number(await this.ctx.storage.get("itemCount") || 0),
      refreshedAt: Number(await this.ctx.storage.get("refreshedAt") || 0),
      chunkCount: Number(await this.ctx.storage.get("chunkCount") || 0),
      upstreams: await this.ctx.storage.get("upstreams") || [],
      lastError: await this.ctx.storage.get("lastError") || null
    };
  }

  async storeBody(body, built) {
    const chunks = chunkByLines(body);
    const previousCount = Number(await this.ctx.storage.get("chunkCount") || 0);

    for (let index = 0; index < chunks.length; index += 1) {
      await this.ctx.storage.put("body:" + index, chunks[index]);
    }

    for (let index = chunks.length; index < previousCount; index += 1) {
      await this.ctx.storage.delete("body:" + index);
    }

    const now = Date.now();
    await this.ctx.storage.put("chunkCount", chunks.length);
    await this.ctx.storage.put("itemCount", built.items.length);
    await this.ctx.storage.put("upstreams", built.status);
    await this.ctx.storage.put("refreshedAt", now);
    await this.ctx.storage.delete("lastError");

    return {
      ok: true,
      refreshed: true,
      item_count: built.items.length,
      chunk_count: chunks.length,
      refreshed_at: new Date(now).toISOString(),
      upstreams: built.status
    };
  }

  async refresh(force = false) {
    const meta = await this.metadata();
    const age = Date.now() - meta.refreshedAt;

    if (!force && meta.chunkCount > 0 && age >= 0 && age < REFRESH_INTERVAL_MS) {
      return {
        ok: true,
        refreshed: false,
        cached: true,
        item_count: meta.itemCount,
        refreshed_at: new Date(meta.refreshedAt).toISOString(),
        next_refresh_at: new Date(meta.refreshedAt + REFRESH_INTERVAL_MS).toISOString(),
        upstreams: meta.upstreams
      };
    }

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const built = await buildCatalog(sourcesFor("live"));

        if (!built.items.length) {
          throw new Error("refresh produced an empty live catalog");
        }

        const body = renderLiveM3U(built.items, PLACEHOLDER_ORIGIN);
        return await this.storeBody(body, built);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        await this.ctx.storage.put("lastError", {
          message,
          at: Date.now()
        });

        const old = await this.metadata();
        if (old.chunkCount > 0) {
          return {
            ok: false,
            refreshed: false,
            stale_kept: true,
            item_count: old.itemCount,
            refreshed_at: old.refreshedAt
              ? new Date(old.refreshedAt).toISOString()
              : null,
            error: message
          };
        }

        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  async playlistResponse(origin, headOnly = false) {
    let meta = await this.metadata();

    if (!meta.chunkCount) {
      await this.refresh(true);
      meta = await this.metadata();
    }

    if (!meta.chunkCount) {
      return new Response("catalog unavailable\n", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const headers = {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Lista-Refreshed-At": String(meta.refreshedAt)
    };

    if (headOnly) return new Response(null, { status: 200, headers });

    const storage = this.ctx.storage;
    const chunkCount = meta.chunkCount;
    let index = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        if (index >= chunkCount) {
          controller.close();
          return;
        }

        const chunk = await storage.get("body:" + index);
        index += 1;

        if (typeof chunk === "string") {
          const rendered = chunk.split(PLACEHOLDER_ORIGIN).join(origin);
          controller.enqueue(new TextEncoder().encode(rendered));
        }
      }
    });

    return new Response(stream, { status: 200, headers });
  }

  async statusResponse() {
    const meta = await this.metadata();
    const now = Date.now();

    return json(200, {
      cached: meta.chunkCount > 0,
      stale: meta.refreshedAt > 0
        ? now - meta.refreshedAt >= REFRESH_INTERVAL_MS
        : true,
      item_count: meta.itemCount,
      refreshed_at: meta.refreshedAt
        ? new Date(meta.refreshedAt).toISOString()
        : null,
      next_refresh_at: meta.refreshedAt
        ? new Date(meta.refreshedAt + REFRESH_INTERVAL_MS).toISOString()
        : null,
      refresh_interval_hours: 3,
      upstreams: meta.upstreams,
      last_error: meta.lastError
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh" && request.method === "POST") {
      try {
        const result = await this.refresh(url.searchParams.get("force") === "1");
        return json(result.ok ? 200 : 503, result);
      } catch (error) {
        return json(503, {
          ok: false,
          error: String(error && error.message ? error.message : error)
        });
      }
    }

    if (url.pathname === "/playlist" &&
        (request.method === "GET" || request.method === "HEAD")) {
      const origin = url.searchParams.get("origin") || PLACEHOLDER_ORIGIN;
      return this.playlistResponse(origin, request.method === "HEAD");
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.statusResponse();
    }

    return new Response("not found\n", { status: 404 });
  }
}
