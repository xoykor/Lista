// SPDX-License-Identifier: MIT
import { DurableObject } from "cloudflare:workers";
import { decodeConfig } from "./token.js";
import { resolvePlutoStream } from "./providers/pluto.js";
import { fetchVariant } from "./hls.js";

const FAILURES_BEFORE_SWITCH = 3;
const LAST_GOOD_TTL_MS = 20000;
const MAX_CACHED_PLAYLIST_BYTES = 96 * 1024;
const PROVIDER_REFRESH_MARGIN_MS = 60 * 1000;

function simpleResponse(status, body = null, headers = {}) {
  return new Response(body, { status, headers });
}

export class ChannelFailover extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }
  async loadState() {
    const lastGoodIndex = await this.ctx.storage.get("lastGoodIndex");
    return {
      active: Number(await this.ctx.storage.get("active") || 0),
      failures: Number(await this.ctx.storage.get("failures") || 0),
      lastGood: await this.ctx.storage.get("lastGood"),
      lastGoodAt: Number(await this.ctx.storage.get("lastGoodAt") || 0),
      lastGoodIndex: typeof lastGoodIndex === "number" ? lastGoodIndex : -1
    };
  }

  providerKey(index, suffix) {
    return "provider:" + index + ":" + suffix;
  }

  async clearProviderCache(index) {
    await this.ctx.storage.delete(this.providerKey(index, "url"));
    await this.ctx.storage.delete(this.providerKey(index, "expiresAt"));
    await this.ctx.storage.delete(this.providerKey(index, "referer"));
    await this.ctx.storage.delete(this.providerKey(index, "userAgent"));
  }

  async resolveVariant(variant, index, forceRefresh = false) {
    if (variant.p !== "pluto") return variant;

    if (!forceRefresh) {
      const cachedUrl = await this.ctx.storage.get(this.providerKey(index, "url"));
      const expiresAt = Number(
        await this.ctx.storage.get(this.providerKey(index, "expiresAt")) || 0
      );

      if (
        typeof cachedUrl === "string" &&
        cachedUrl &&
        Date.now() + PROVIDER_REFRESH_MARGIN_MS < expiresAt
      ) {
        return {
          u: cachedUrl,
          r: await this.ctx.storage.get(this.providerKey(index, "referer")) || undefined,
          a: await this.ctx.storage.get(this.providerKey(index, "userAgent")) || undefined
        };
      }
    }

    const resolved = await resolvePlutoStream(variant.c);
    await this.ctx.storage.put(this.providerKey(index, "url"), resolved.url);
    await this.ctx.storage.put(this.providerKey(index, "expiresAt"), resolved.expiresAt);
    await this.ctx.storage.put(this.providerKey(index, "referer"), resolved.referer);
    await this.ctx.storage.put(this.providerKey(index, "userAgent"), resolved.userAgent);

    return {
      u: resolved.url,
      r: resolved.referer,
      a: resolved.userAgent
    };
  }

  async fetchConfiguredVariant(variant, index) {
    try {
      let resolved = await this.resolveVariant(variant, index);
      let result = await fetchVariant(resolved);

      // Pluto URLs are authenticated and can expire independently of our
      // cached catalogue. On an auth-style failure, refresh the anonymous
      // session once before treating the source as unavailable.
      if (
        variant.p === "pluto" &&
        !result.ok &&
        (result.status === 401 || result.status === 403 || result.status === 410)
      ) {
        await this.clearProviderCache(index);
        resolved = await this.resolveVariant(variant, index, true);
        result = await fetchVariant(resolved);
      }

      return result;
    } catch {
      return { ok: false, status: 504 };
    }
  }

  async markDeadChannel(name) {
    try {
      const stub = this.env.CATALOG_STATE.getByName("live");
      await stub.fetch(new Request("https://catalog.internal/dead/mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lista-Internal-Upload": "1"
        },
        body: JSON.stringify({ name })
      }));
    } catch {
      // Playback failure must still return promptly even if bookkeeping fails.
    }
  }

  async saveSuccess(index, result) {
    await this.ctx.storage.put("active", index);
    await this.ctx.storage.put("failures", 0);

    if (result.playlist) {
      const bytes = new TextEncoder().encode(result.playlist).byteLength;
      if (bytes <= MAX_CACHED_PLAYLIST_BYTES) {
        await this.ctx.storage.put("lastGood", result.playlist);
        await this.ctx.storage.put("lastGoodAt", Date.now());
        await this.ctx.storage.put("lastGoodIndex", index);
      }
    }
  }

  serveResult(result, headOnly) {
    if (result.redirect) {
      return simpleResponse(307, null, {
        "Location": result.redirect,
        "Cache-Control": "no-store"
      });
    }

    return simpleResponse(200, headOnly ? null : result.playlist, {
      "Content-Type": result.contentType,
      "Cache-Control": "no-cache, no-store",
      "Access-Control-Allow-Origin": "*"
    });
  }

  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return simpleResponse(405, "method not allowed", { "Allow": "GET, HEAD" });
    }

    if (request.headers.get("x-lista-internal-channel") !== "1") {
      return simpleResponse(403, "forbidden");
    }

    const payload = request.headers.get("x-lista-channel-payload") || "";
    let config;
    try {
      config = decodeConfig(payload);
    } catch {
      return simpleResponse(400, "invalid channel config");
    }

    const variants = config.v;
    const state = await this.loadState();
    const start = Math.min(Math.max(state.active, 0), variants.length - 1);

    const current = await this.fetchConfiguredVariant(variants[start], start);
    if (current.ok) {
      await this.saveSuccess(start, current);
      return this.serveResult(current, request.method === "HEAD");
    }

    const failures = state.failures + 1;
    await this.ctx.storage.put("failures", failures);

    const lastGoodFresh =
      typeof state.lastGood === "string" &&
      state.lastGoodIndex === start &&
      Date.now() - state.lastGoodAt <= LAST_GOOD_TTL_MS;

    if (lastGoodFresh && failures < FAILURES_BEFORE_SWITCH) {
      return simpleResponse(200, request.method === "HEAD" ? null : state.lastGood, {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        "X-Lista-Stale": "1"
      });
    }

    for (let offset = 1; offset < variants.length; offset += 1) {
      const index = (start + offset) % variants.length;
      const result = await this.fetchConfiguredVariant(variants[index], index);
      if (result.ok) {
        await this.saveSuccess(index, result);
        return this.serveResult(result, request.method === "HEAD");
      }
    }

    await this.ctx.storage.put("active", start);
    await this.ctx.storage.put("failures", 0);
    await this.ctx.storage.delete("lastGood");
    await this.ctx.storage.delete("lastGoodAt");
    await this.ctx.storage.delete("lastGoodIndex");

    await this.markDeadChannel(config.n || "");
    return simpleResponse(502, "all channel sources failed");
  }
}
