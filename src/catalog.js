// SPDX-License-Identifier: MIT
import { normalizeName } from "./normalize.js";
import { parseM3UResponse, parseSaimoCatalog } from "./parsers.js";
import { fetchCurrentSource } from "./upstream.js";
import { fetchPlutoCatalog } from "./providers/pluto.js";
import { signConfig } from "./token.js";

function variantKey(variant) {
  if (variant.url) return "url:" + variant.url;
  if (variant.provider && variant.channelId) {
    return "provider:" + variant.provider + ":" + variant.channelId;
  }
  return JSON.stringify(variant);
}

function addVariants(target, incoming) {
  const known = new Set(target.variants.map(variantKey));
  for (const variant of incoming.variants) {
    const key = variantKey(variant);
    if (!known.has(key)) {
      target.variants.push(variant);
      known.add(key);
    }
  }
}

export function mergeItem(map, incoming) {
  const key = normalizeName(incoming.name);
  if (!key || !incoming.variants || !incoming.variants.length) return;

  const current = map.get(key);
  if (!current) {
    map.set(key, {
      key,
      name: incoming.name,
      logo: incoming.logo || "",
      group: incoming.group || "",
      variants: [...incoming.variants]
    });
    return;
  }

  if (!current.logo && incoming.logo) current.logo = incoming.logo;
  if (!current.group && incoming.group) current.group = incoming.group;
  addVariants(current, incoming);
}

export async function buildCatalog(sources, fetchImpl = fetch) {
  const map = new Map();
  const status = [];

  for (const source of sources) {
    let count = 0;
    try {
      if (source.format === "pluto-provider") {
        const items = await fetchPlutoCatalog(source, fetchImpl);
        for (const item of items) mergeItem(map, item);
        count = items.length;
      } else {
        const response = await fetchCurrentSource(source, fetchImpl);
        if (source.format === "saimo-catalog") {
          const items = parseSaimoCatalog(await response.text(), source);
          for (const item of items) mergeItem(map, item);
          count = items.length;
        } else {
          count = await parseM3UResponse(
            response,
            source,
            async (item) => mergeItem(map, item)
          );
        }
      }

      status.push({ id: source.id, ok: true, count });
    } catch (error) {
      status.push({
        id: source.id,
        ok: false,
        count: 0,
        error: String(error && error.message ? error.message : error)
      });
    }
  }

  return { items: [...map.values()], status };
}

function escapeAttr(value) {
  return String(value || "").replace(/"/g, "'");
}

export function compactVariant(variant) {
  if (variant.provider === "pluto" && variant.channelId) {
    return { p: "pluto", c: variant.channelId };
  }

  const out = { u: variant.url };
  if (variant.referer) out.r = variant.referer;
  if (variant.userAgent) out.a = variant.userAgent;
  return out;
}

export function itemNeedsResolver(item) {
  return (
    item.variants.length > 1 ||
    item.variants.some(
      (variant) =>
        variant.provider ||
        variant.referer ||
        variant.userAgent
    )
  );
}

export async function renderLiveM3U(items, origin, tokenSecret) {
  const lines = ["#EXTM3U"];

  for (const item of items) {
    if (!item.variants.length) continue;

    const attrs = [
      'tvg-name="' + escapeAttr(item.name) + '"',
      item.logo ? 'tvg-logo="' + escapeAttr(item.logo) + '"' : "",
      item.group ? 'group-title="' + escapeAttr(item.group) + '"' : ""
    ].filter(Boolean).join(" ");

    lines.push("#EXTINF:-1 " + attrs + "," + item.name);

    if (!itemNeedsResolver(item)) {
      lines.push(item.variants[0].url);
      continue;
    }

    const token = await signConfig({
      n: item.name,
      v: item.variants.slice(0, 8).map(compactVariant)
    }, tokenSecret);

    lines.push(origin + "/channel/" + token);
  }

  return lines.join("\n") + "\n";
}


/**
 * Render a Worker-independent fallback playlist.
 *
 * Only direct URL variants are included. Dynamic providers are intentionally
 * skipped because their URLs/tokens expire and would make a "static" fallback
 * unreliable. Header hints are emitted using common EXT* directives when a
 * source requires Referer/User-Agent.
 */
export function renderStaticDirectM3U(items) {
  const lines = ["#EXTM3U"];
  let included = 0;
  let skipped = 0;

  for (const item of items) {
    if (!Array.isArray(item?.variants) || !item.variants.length) {
      skipped += 1;
      continue;
    }

    const variant = item.variants.find(
      (candidate) =>
        candidate &&
        !candidate.provider &&
        typeof candidate.url === "string" &&
        candidate.url.trim()
    );

    if (!variant) {
      skipped += 1;
      continue;
    }

    const attrs = [
      'tvg-name="' + escapeAttr(item.name) + '"',
      item.logo ? 'tvg-logo="' + escapeAttr(item.logo) + '"' : "",
      item.group ? 'group-title="' + escapeAttr(item.group) + '"' : ""
    ].filter(Boolean).join(" ");

    lines.push("#EXTINF:-1 " + attrs + "," + item.name);

    if (variant.referer) {
      lines.push("#EXTVLCOPT:http-referrer=" + variant.referer);
      lines.push("#EXTHTTP:{\"Referer\":\"" + String(variant.referer).replace(/\"/g, "'") + "\"}");
    }

    if (variant.userAgent) {
      lines.push("#EXTVLCOPT:http-user-agent=" + variant.userAgent);
    }

    lines.push(variant.url);
    included += 1;
  }

  return {
    body: lines.join("\n") + "\n",
    included,
    skipped
  };
}
