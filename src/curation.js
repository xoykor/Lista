// SPDX-License-Identifier: MIT
import { normalizeName } from "./normalize.js";

/*
 * Samsung/low-memory curation.
 *
 * This is intentionally deterministic: every refresh applies the same rules,
 * without requiring an LLM or a second service. The catalogue stays small by
 * keeping only major paid-TV brands and major streaming brands already present
 * in the upstream sources.
 */

const STREAMING_BRANDS = [
  "netflix",
  "apple tv",
  "prime video",
  "amazon prime",
  "disney plus",
  "hbo max",
  "max",
  "paramount plus",
  "crunchyroll",
  "globoplay",
  "dazn",
  "mubi",
  "discovery plus",
  "lionsgate plus",
  "starz",
  "amc plus",
  "peacock",
  "hulu",
  "plex",
  "rakuten",
  "samsung tv plus",
  "pluto tv",
  "runtime",
  "netmovies",
  "looke",
  "claro tv"
];

const PAID_TV_BRANDS = [
  "hbo",
  "cinemax",
  "telecine",
  "warner channel",
  "warner tv",
  "tnt",
  "tnt series",
  "space",
  "sony channel",
  "axn",
  "universal tv",
  "studio universal",
  "fx",
  "star channel",
  "paramount network",
  "amc",
  "lifetime",
  "history",
  "h2",
  "a e",
  "discovery channel",
  "discovery science",
  "discovery turbo",
  "investigation discovery",
  "animal planet",
  "tlc",
  "national geographic",
  "nat geo",
  "nat geo wild",
  "food network",
  "hgtv",
  "cartoon network",
  "discovery kids",
  "nickelodeon",
  "nick jr",
  "disney channel",
  "disney junior",
  "gloob",
  "gloobinho",
  "multishow",
  "gnt",
  "viva",
  "bis",
  "mtv",
  "sportv",
  "espn",
  "premiere",
  "bandsports",
  "combate",
  "nfl network",
  "nba tv",
  "ufc",
  "globonews",
  "cnn brasil",
  "cnn international",
  "bandnews",
  "record news",
  "bbc news",
  "bloomberg",
  "cnbc"
];

const NOISE = [
  "backup",
  "teste",
  "test",
  "offline",
  "alternativo",
  "alternative",
  "espelho",
  "mirror"
];

function words(value) {
  // Preserve service branding such as Disney+, Paramount+, Apple TV+ and AMC+
  // before the generic normalizer strips punctuation.
  return normalizeName(String(value || "").replace(/\+/g, " plus "));
}

function phraseMatch(text, phrase) {
  if (!text || !phrase) return false;
  return (" " + text + " ").includes(" " + phrase + " ");
}

function brandMatch(text) {
  // Exact "max" is allowed, but avoid matching unrelated names containing max.
  if (text === "max") return { kind: "streaming", brand: "max" };

  for (const brand of STREAMING_BRANDS) {
    if (brand === "max") continue;
    if (phraseMatch(text, brand)) {
      return { kind: "streaming", brand };
    }
  }

  for (const brand of PAID_TV_BRANDS) {
    if (phraseMatch(text, brand)) {
      return { kind: "paid-tv", brand };
    }
  }

  return null;
}

function itemMatch(item) {
  const name = words(item?.name);
  const group = words(item?.group);
  const joined = [name, group].filter(Boolean).join(" ");

  for (const noise of NOISE) {
    if (phraseMatch(joined, noise)) return null;
  }

  // Name has priority. Group is used only as a secondary signal so generic
  // items inside a branded group can still be considered.
  return brandMatch(name) || brandMatch(group);
}

function directVariantScore(variant) {
  if (!variant?.url || variant.provider) return -1000;

  const url = String(variant.url).toLowerCase();
  let score = 100;

  if (url.startsWith("https://")) score += 8;
  if (/\.m3u8(?:$|[?#])/.test(url)) score += 6;
  if (/\.(?:ts|mp4)(?:$|[?#])/.test(url)) score += 2;
  if (variant.referer) score -= 2;
  if (variant.userAgent) score -= 1;

  return score;
}

function bestDirectVariant(item) {
  const variants = (item?.variants || [])
    .filter((variant) => variant?.url && !variant.provider)
    .map((variant, index) => ({
      variant,
      index,
      score: directVariantScore(variant)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return variants[0]?.variant || null;
}

/*
 * Return a compact, deterministic subset for TVs with limited memory.
 *
 * The full catalogue already merges equivalent channel names. We still dedupe
 * here because curated matching can encounter cosmetic aliases. Only a single
 * direct variant is retained for the Samsung output.
 */
export function curateSamsungItems(items, { maxItems = 1500 } = {}) {
  const selected = new Map();
  let matched = 0;
  let skippedNoDirect = 0;

  for (const item of items || []) {
    const match = itemMatch(item);
    if (!match) continue;
    matched += 1;

    const direct = bestDirectVariant(item);
    if (!direct) {
      skippedNoDirect += 1;
      continue;
    }

    const key = normalizeName(item.name);
    if (!key) continue;

    const candidate = {
      ...item,
      variants: [direct],
      curation: match
    };

    const previous = selected.get(key);
    if (!previous) {
      selected.set(key, candidate);
      continue;
    }

    // Prefer streaming-brand matches, then HTTPS/direct simplicity.
    const previousKind = previous.curation?.kind === "streaming" ? 1 : 0;
    const candidateKind = match.kind === "streaming" ? 1 : 0;
    const previousScore = directVariantScore(previous.variants[0]);
    const candidateScore = directVariantScore(direct);

    if (
      candidateKind > previousKind ||
      (candidateKind === previousKind && candidateScore > previousScore)
    ) {
      selected.set(key, candidate);
    }
  }

  const curated = [...selected.values()]
    .sort((a, b) => {
      const aKind = a.curation?.kind === "streaming" ? 0 : 1;
      const bKind = b.curation?.kind === "streaming" ? 0 : 1;
      return aKind - bKind || String(a.name).localeCompare(String(b.name), "pt-BR");
    })
    .slice(0, Math.max(1, maxItems));

  return {
    items: curated,
    report: {
      input_items: Array.isArray(items) ? items.length : 0,
      matched_major_brands: matched,
      skipped_without_direct_url: skippedNoDirect,
      selected: curated.length,
      max_items: maxItems
    }
  };
}

export const SAMSUNG_STREAMING_BRANDS = Object.freeze([...STREAMING_BRANDS]);
export const SAMSUNG_PAID_TV_BRANDS = Object.freeze([...PAID_TV_BRANDS]);
