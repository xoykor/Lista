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
    const values = await this.ctx.storage.get([
      "active",
      "failures",
      "lastGood",
      "lastGoodAt",
      "lastGoodIndex"
    ]);

    const lastGoodIndex = values.get("lastGoodIndex");
    return {
      active: Number(values.get("active") || 0),
      failures: Number(values.get("failures") || 0),
      lastGood: values.get("lastGood"),
      lastGoodAt: Number(values.get("lastGoodAt") || 0),
      lastGoodIndex: typeof lastGoodIndex === "number" ? lastGoodIndex : -1
    };
  }

  providerKey(index, suffix) {
    return "provider:" + index + ":" + suffix;
  }

  async clearProviderCache(index) {
    await this.ctx.storage.delete([
      this.providerKey(index, "url"),
      this.providerKey(index, "expiresAt"),
      this.providerKey(index, "referer"),
      this.providerKey(index, "userAgent")
    ]);
  }

  async resolveVariant(variant, index, forceRefresh = false) {
    if (variant.p !== "pluto") return variant;

    if (!forceRefresh) {
      const keys = [
        this.providerKey(index, "url"),
        this.providerKey(index, "expiresAt"),
        this.providerKey(index, "referer"),
        this.providerKey(index, "userAgent")
      ];
      const cached = await this.ctx.storage.get(keys);
      const cachedUrl = cached.get(keys[0]);
      const expiresAt = Number(cached.get(keys[1]) || 0);

      if (
        typeof cachedUrl === "string" &&
        cachedUrl &&
        Date.now() + PROVIDER_REFRESH_MARGIN_MS < expiresAt
      ) {
        return {
          u: cachedUrl,
          r: cached.get(keys[2]) || undefined,
          a: cached.get(keys[3]) || undefined
        };
      }
    }

    const resolved = await resolvePlutoStream(variant.c);
    await this.ctx.storage.put({
      [this.providerKey(index, "url")]: resolved.url,
      [this.providerKey(index, "expiresAt")]: resolved.expiresAt,
      [this.providerKey(index, "referer")]: resolved.referer,
      [this.providerKey(index, "userAgent")]: resolved.userAgent
    });

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

  async saveSuccess(index, result) {
    const values = {
      active: index,
      failures: 0
    };

    if (result.playlist) {
      const bytes = new TextEncoder().encode(result.playlist).byteLength;
      if (bytes <= MAX_CACHED_PLAYLIST_BYTES) {
        values.lastGood = result.playlist;
        values.lastGoodAt = Date.now();
        values.lastGoodIndex = index;
      }
    }

    await this.ctx.storage.put(values);
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

    await this.ctx.storage.put({
      active: start,
      failures: 0
    });
    await this.ctx.storage.delete([
      "lastGood",
      "lastGoodAt",
      "lastGoodIndex"
    ]);

    return simpleResponse(502, "all channel sources failed");
  }
}
