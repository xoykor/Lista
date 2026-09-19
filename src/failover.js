// SPDX-License-Identifier: MIT
import { DurableObject } from "cloudflare:workers";
import { decodeConfig } from "./token.js";
import { USER_AGENT } from "./upstream.js";

const FAILURES_BEFORE_SWITCH = 3;
const LAST_GOOD_TTL_MS = 20000;
const MAX_CACHED_PLAYLIST_BYTES = 96 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

function simpleResponse(status, body = null, headers = {}) {
  return new Response(body, { status, headers });
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function headersFor(variant) {
  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "User-Agent": variant.a || USER_AGENT
  });
  if (variant.r) headers.set("Referer", variant.r);
  return headers;
}

function looksLikePlaylist(url, contentType) {
  const lowerType = String(contentType || "").toLowerCase();
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }

  return path.endsWith(".m3u8") ||
    path.endsWith(".m3u") ||
    lowerType.includes("mpegurl") ||
    lowerType.includes("m3u");
}

function absolutizePlaylist(text, base) {
  const baseUrl = new URL(base);
  return String(text).split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (!trimmed.startsWith("#")) {
      try {
        return new URL(trimmed, baseUrl).href;
      } catch {
        return line;
      }
    }

    return line.replace(/URI="([^"]+)"/g, (whole, value) => {
      try {
        return 'URI="' + new URL(value, baseUrl).href + '"';
      } catch {
        return whole;
      }
    });
  }).join("\n");
}

async function fetchVariant(variant) {
  const timer = timeoutSignal(12000);
  try {
    const upstream = await fetch(variant.u, {
      headers: headersFor(variant),
      redirect: "follow",
      signal: timer.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      if (upstream.body) upstream.body.cancel();
      return { ok: false, status: upstream.status };
    }

    const finalUrl = upstream.url || variant.u;
    const contentType = upstream.headers.get("content-type") || "";

    if (!looksLikePlaylist(finalUrl, contentType)) {
      if (upstream.body) upstream.body.cancel();
      return { ok: true, redirect: finalUrl };
    }

    const declared = Number(upstream.headers.get("content-length") || "0");
    if (declared > MAX_PLAYLIST_BYTES) {
      if (upstream.body) upstream.body.cancel();
      return { ok: false, status: 413 };
    }

    const text = await upstream.text();
    if (!text.trimStart().startsWith("#EXTM3U")) return { ok: false, status: 502 };
    if (new TextEncoder().encode(text).byteLength > MAX_PLAYLIST_BYTES) {
      return { ok: false, status: 413 };
    }

    return {
      ok: true,
      playlist: absolutizePlaylist(text, finalUrl),
      contentType: "application/vnd.apple.mpegurl; charset=utf-8"
    };
  } catch {
    return { ok: false, status: 504 };
  } finally {
    timer.cancel();
  }
}

export class ChannelFailover extends DurableObject {
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

    const token = new URL(request.url).searchParams.get("token") || "";
    let config;
    try {
      config = decodeConfig(token);
    } catch {
      return simpleResponse(400, "invalid channel token");
    }

    const variants = config.v;
    const state = await this.loadState();
    const start = Math.min(Math.max(state.active, 0), variants.length - 1);

    const current = await fetchVariant(variants[start]);
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
      const result = await fetchVariant(variants[index]);
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

    return simpleResponse(502, "all channel sources failed");
  }
}
