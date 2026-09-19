// SPDX-License-Identifier: MIT
import { normalizeName } from "./normalize.js";
import { parseM3UResponse, parseSaimoCatalog } from "./parsers.js";
import { fetchCurrentSource } from "./upstream.js";
import { encodeConfig } from "./token.js";

function addVariants(target, incoming) {
  const known = new Set(target.variants.map((variant) => variant.url));
  for (const variant of incoming.variants) {
    if (!known.has(variant.url)) {
      target.variants.push(variant);
      known.add(variant.url);
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
      const response = await fetchCurrentSource(source, fetchImpl);
      if (source.format === "saimo-catalog") {
        const items = parseSaimoCatalog(await response.text(), source);
        for (const item of items) mergeItem(map, item);
        count = items.length;
      } else {
        count = await parseM3UResponse(response, source, async (item) => mergeItem(map, item));
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

function compactVariant(variant) {
  const out = { u: variant.url };
  if (variant.referer) out.r = variant.referer;
  if (variant.userAgent) out.a = variant.userAgent;
  return out;
}

export function renderLiveM3U(items, origin) {
  const lines = ["#EXTM3U"];

  for (const item of items) {
    if (!item.variants.length) continue;

    const attrs = [
      'tvg-name="' + escapeAttr(item.name) + '"',
      item.logo ? 'tvg-logo="' + escapeAttr(item.logo) + '"' : "",
      item.group ? 'group-title="' + escapeAttr(item.group) + '"' : ""
    ].filter(Boolean).join(" ");

    lines.push("#EXTINF:-1 " + attrs + "," + item.name);

    const needsResolver =
      item.variants.length > 1 ||
      item.variants.some((variant) => variant.referer || variant.userAgent);

    if (!needsResolver) {
      lines.push(item.variants[0].url);
      continue;
    }

    const token = encodeConfig({
      n: item.name,
      v: item.variants.slice(0, 8).map(compactVariant)
    });
    lines.push(origin + "/channel/" + token);
  }

  return lines.join("\n") + "\n";
}
