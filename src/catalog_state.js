// SPDX-License-Identifier: MIT
import { DurableObject } from "cloudflare:workers";
import { normalizeName } from "./normalize.js";

export const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PLACEHOLDER_ORIGIN = "https://lista.internal.invalid";
const MAX_CHUNK_BYTES = 128 * 1024;

function json(status, value) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export class CatalogState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async deleteKeys(keys) {
    for (let start = 0; start < keys.length; start += 128) {
      await this.ctx.storage.delete(keys.slice(start, start + 128));
    }
  }

  async hasAllKeys(keys) {
    for (let start = 0; start < keys.length; start += 128) {
      const batch = keys.slice(start, start + 128);
      const saved = await this.ctx.storage.get(batch);
      if (saved.size !== batch.length) {
        return { ok: false, saved, batch };
      }
    }
    return { ok: true };
  }

  authorized(request) {
    return request.headers.get("x-lista-internal-upload") === "1";
  }

  async metadata() {
    const generation = await this.ctx.storage.get("activeGeneration") || "";
    return {
      generation,
      itemCount: Number(await this.ctx.storage.get("itemCount") || 0),
      refreshedAt: Number(await this.ctx.storage.get("refreshedAt") || 0),
      chunkCount: Number(await this.ctx.storage.get("chunkCount") || 0),
      upstreams: await this.ctx.storage.get("upstreams") || [],
      revision: await this.ctx.storage.get("revision") || null
    };
  }

  async startUpload(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const value = await request.json();
    const generation = String(value?.generation || "");
    const chunkCount = Number(value?.chunk_count || 0);

    if (!/^[A-Za-z0-9._-]{1,80}$/.test(generation)) {
      return json(400, { error: "invalid generation" });
    }
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 4096) {
      return json(400, { error: "invalid chunk_count" });
    }

    await this.ctx.storage.put("pendingGeneration", generation);
    await this.ctx.storage.put("pendingChunkCount", chunkCount);
    await this.ctx.storage.put("pendingItemCount", Number(value?.item_count || 0));
    await this.ctx.storage.put("pendingUpstreams", value?.upstreams || []);
    await this.ctx.storage.put("pendingRevision", value?.revision || null);
    return json(200, { ok: true, generation, chunk_count: chunkCount });
  }

  async putChunk(request, generation, index) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const pending = await this.ctx.storage.get("pendingGeneration");
    const count = Number(await this.ctx.storage.get("pendingChunkCount") || 0);

    if (generation !== pending || index < 0 || index >= count) {
      return json(409, { error: "upload generation mismatch" });
    }

    const declared = Number(request.headers.get("content-length") || "0");
    if (declared > MAX_CHUNK_BYTES) {
      return json(413, { error: "chunk too large" });
    }

    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CHUNK_BYTES) {
      return json(413, { error: "chunk too large" });
    }

    await this.ctx.storage.put("gen:" + generation + ":" + index, body);
    return json(200, { ok: true, index });
  }

  async putBatch(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const value = await request.json();
    const generation = String(value?.generation || "");
    const chunkCount = Number(value?.chunk_count || 0);
    const start = Number(value?.start || 0);
    const chunks = Array.isArray(value?.chunks) ? value.chunks : [];
    const final = Boolean(value?.final);

    if (!/^[A-Za-z0-9._-]{1,80}$/.test(generation)) {
      return json(400, { error: "invalid generation" });
    }
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 4096) {
      return json(400, { error: "invalid chunk_count" });
    }
    if (!Number.isInteger(start) || start < 0 || start >= chunkCount) {
      return json(400, { error: "invalid start" });
    }
    if (!chunks.length || chunks.length > 64 || start + chunks.length > chunkCount) {
      return json(400, { error: "invalid chunks" });
    }

    const encoder = new TextEncoder();
    const entries = {};
    for (let offset = 0; offset < chunks.length; offset += 1) {
      const body = String(chunks[offset] || "");
      if (encoder.encode(body).byteLength > MAX_CHUNK_BYTES) {
        return json(413, { error: "chunk too large", index: start + offset });
      }
      entries["gen:" + generation + ":" + (start + offset)] = body;
    }

    const pending = await this.ctx.storage.get("pendingGeneration");

    if (start === 0) {
      if (pending && pending !== generation) {
        const oldPendingCount = Number(
          await this.ctx.storage.get("pendingChunkCount") || 0
        );
        const oldPendingKeys = [];
        for (let index = 0; index < oldPendingCount; index += 1) {
          oldPendingKeys.push("gen:" + pending + ":" + index);
        }
        if (oldPendingKeys.length) {
          await this.deleteKeys(oldPendingKeys);
        }
      }

      await this.ctx.storage.put({
        pendingGeneration: generation,
        pendingChunkCount: chunkCount,
        pendingItemCount: Number(value?.item_count || 0),
        pendingUpstreams: value?.upstreams || [],
        pendingRevision: value?.revision || null
      });
    } else if (pending !== generation) {
      return json(409, { error: "upload generation mismatch" });
    }

    await this.ctx.storage.put(entries);

    if (!final) {
      return json(200, {
        ok: true,
        generation,
        start,
        count: chunks.length,
        final: false
      });
    }

    if (start + chunks.length !== chunkCount) {
      return json(400, { error: "final batch does not end at chunk_count" });
    }

    const keys = [];
    for (let index = 0; index < chunkCount; index += 1) {
      keys.push("gen:" + generation + ":" + index);
    }

    const complete = await this.hasAllKeys(keys);
    if (!complete.ok) {
      for (const key of complete.batch) {
        if (!complete.saved.has(key)) {
          return json(409, {
            error: "missing chunk",
            index: Number(key.slice(key.lastIndexOf(":") + 1))
          });
        }
      }
      return json(409, { error: "missing chunk" });
    }

    const old = await this.metadata();
    const now = Date.now();

    await this.ctx.storage.put({
      activeGeneration: generation,
      chunkCount,
      itemCount: Number(await this.ctx.storage.get("pendingItemCount") || 0),
      upstreams: await this.ctx.storage.get("pendingUpstreams") || [],
      revision: await this.ctx.storage.get("pendingRevision") || null,
      refreshedAt: now
    });

    await this.ctx.storage.delete([
      "pendingGeneration",
      "pendingChunkCount",
      "pendingItemCount",
      "pendingUpstreams",
      "pendingRevision"
    ]);

    if (old.generation && old.generation !== generation) {
      const oldKeys = [];
      for (let index = 0; index < old.chunkCount; index += 1) {
        oldKeys.push("gen:" + old.generation + ":" + index);
      }
      if (oldKeys.length) {
        await this.deleteKeys(oldKeys);
      }
    }

    return json(200, {
      ok: true,
      generation,
      item_count: Number(await this.ctx.storage.get("itemCount") || 0),
      refreshed_at: new Date(now).toISOString(),
      committed: true
    });
  }

  async commitUpload(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const value = await request.json();
    const generation = String(value?.generation || "");
    const pending = await this.ctx.storage.get("pendingGeneration");
    const count = Number(await this.ctx.storage.get("pendingChunkCount") || 0);

    if (!generation || generation !== pending || !count) {
      return json(409, { error: "no matching pending upload" });
    }

    for (let index = 0; index < count; index += 1) {
      const chunk = await this.ctx.storage.get("gen:" + generation + ":" + index);
      if (typeof chunk !== "string") {
        return json(409, { error: "missing chunk", index });
      }
    }

    const old = await this.metadata();
    const now = Date.now();

    await this.ctx.storage.put("activeGeneration", generation);
    await this.ctx.storage.put("chunkCount", count);
    await this.ctx.storage.put(
      "itemCount",
      Number(await this.ctx.storage.get("pendingItemCount") || 0)
    );
    await this.ctx.storage.put(
      "upstreams",
      await this.ctx.storage.get("pendingUpstreams") || []
    );
    await this.ctx.storage.put(
      "revision",
      await this.ctx.storage.get("pendingRevision") || null
    );
    await this.ctx.storage.put("refreshedAt", now);

    await this.ctx.storage.delete("pendingGeneration");
    await this.ctx.storage.delete("pendingChunkCount");
    await this.ctx.storage.delete("pendingItemCount");
    await this.ctx.storage.delete("pendingUpstreams");
    await this.ctx.storage.delete("pendingRevision");

    if (old.generation && old.generation !== generation) {
      for (let index = 0; index < old.chunkCount; index += 1) {
        await this.ctx.storage.delete("gen:" + old.generation + ":" + index);
      }
    }

    return json(200, {
      ok: true,
      generation,
      item_count: Number(await this.ctx.storage.get("itemCount") || 0),
      refreshed_at: new Date(now).toISOString()
    });
  }

  async markDead(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const value = await request.json();
    const name = String(value?.name || "").trim();
    const key = normalizeName(name);
    if (!key) return json(400, { error: "invalid channel name" });

    await this.ctx.storage.put("dead:" + key, {
      name,
      key,
      markedAt: Date.now()
    });

    return json(200, { ok: true, key });
  }

  async clearDead(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const value = await request.json();
    const key = normalizeName(String(value?.name || value?.key || ""));
    if (!key) return json(400, { error: "invalid channel name" });

    await this.ctx.storage.delete("dead:" + key);
    return json(200, { ok: true, key });
  }

  async listDead(request) {
    if (!this.authorized(request)) return json(401, { error: "unauthorized" });

    const rows = await this.ctx.storage.list({ prefix: "dead:" });
    const channels = [...rows.values()]
      .filter((value) => value && typeof value === "object" && value.key)
      .sort((a, b) => Number(b.markedAt || 0) - Number(a.markedAt || 0));

    return json(200, {
      count: channels.length,
      channels
    });
  }

  async playlistResponse(origin, headOnly = false) {
    const meta = await this.metadata();

    if (!meta.generation || !meta.chunkCount) {
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
    const generation = meta.generation;
    const chunkCount = meta.chunkCount;
    let index = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        if (index >= chunkCount) {
          controller.close();
          return;
        }

        const chunk = await storage.get("gen:" + generation + ":" + index);
        index += 1;

        if (typeof chunk === "string") {
          controller.enqueue(
            new TextEncoder().encode(chunk.split(PLACEHOLDER_ORIGIN).join(origin))
          );
        }
      }
    });

    return new Response(stream, { status: 200, headers });
  }

  async statusResponse() {
    const meta = await this.metadata();
    const now = Date.now();

    return json(200, {
      cached: Boolean(meta.generation && meta.chunkCount),
      stale: meta.refreshedAt > 0
        ? now - meta.refreshedAt >= REFRESH_INTERVAL_MS
        : true,
      item_count: meta.itemCount,
      generation: meta.generation || null,
      revision: meta.revision,
      refreshed_at: meta.refreshedAt
        ? new Date(meta.refreshedAt).toISOString()
        : null,
      next_refresh_at: meta.refreshedAt
        ? new Date(meta.refreshedAt + REFRESH_INTERVAL_MS).toISOString()
        : null,
      refresh_interval_hours: 12,
      upstreams: meta.upstreams
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/upload/batch" && request.method === "POST") {
      return this.putBatch(request);
    }

    if (url.pathname === "/upload/start" && request.method === "POST") {
      return this.startUpload(request);
    }

    const chunk = url.pathname.match(/^\/upload\/chunk\/([A-Za-z0-9._-]+)\/(\d+)$/);
    if (chunk && request.method === "PUT") {
      return this.putChunk(request, chunk[1], Number(chunk[2]));
    }

    if (url.pathname === "/upload/commit" && request.method === "POST") {
      return this.commitUpload(request);
    }

    if (url.pathname === "/dead/mark" && request.method === "POST") {
      return this.markDead(request);
    }

    if (url.pathname === "/dead/clear" && request.method === "POST") {
      return this.clearDead(request);
    }

    if (url.pathname === "/dead/list" && request.method === "GET") {
      return this.listDead(request);
    }

    if (url.pathname === "/playlist" &&
        (request.method === "GET" || request.method === "HEAD")) {
      return this.playlistResponse(
        url.searchParams.get("origin") || PLACEHOLDER_ORIGIN,
        request.method === "HEAD"
      );
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.statusResponse();
    }

    return new Response("not found\n", { status: 404 });
  }
}
