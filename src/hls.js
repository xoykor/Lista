// SPDX-License-Identifier: MIT
import { USER_AGENT } from "./upstream.js";

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

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

export function looksLikePlaylist(url, contentType) {
  const lowerType = String(contentType || "").toLowerCase();
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }

  return path.endsWith(".m3u8") ||
    path.endsWith(".m3u") ||
    path.endsWith(".txt") ||
    lowerType.includes("mpegurl") ||
    lowerType.includes("m3u") ||
    lowerType.startsWith("text/plain");
}

export function absolutizePlaylist(text, base) {
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

export async function fetchVariant(variant, fetchImpl = fetch, depth = 0, timeoutMs = 12000) {
  if (depth > 2) return { ok: false, status: 508 };

  const timer = timeoutSignal(timeoutMs);
  try {
    const upstream = await fetchImpl(variant.u, {
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
    const trimmed = text.trim();

    if (!trimmed.startsWith("#EXTM3U")) {
      /* Some sources use .txt as a wrapper around the actual media URL.
       * Follow a small, bounded number of wrapper hops instead of sending the
       * text document itself to the media player. */
      const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() || "";
      if (/^https?:\/\//i.test(firstLine)) {
        return fetchVariant(
          { ...variant, u: firstLine },
          fetchImpl,
          depth + 1,
          timeoutMs
        );
      }
      return { ok: false, status: 502 };
    }

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
