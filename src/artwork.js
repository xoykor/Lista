// SPDX-License-Identifier: GPL-3.0-or-later
import process from "node:process";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const NEGATIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function text(value) {
  return String(value || "").trim();
}

function stripDiacritics(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeArtworkTitle(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, " ")
    .replace(/\b(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})\b/gi, " ")
    .replace(/\b(?:temporada|season)\s*\d+\b/gi, " ")
    .replace(/\b(?:episodio|episódio|episode|ep)\s*\d+\b/gi, " ")
    .replace(/\b(?:4k|uhd|fhd|full\s*hd|hd|sd|2160p|1080p|720p|480p|hdr10?|dolby\s*vision|imax|bluray|blu\s*ray|brrip|webrip|web\s*dl|web-dl|h\.?26[45]|x26[45]|hevc|av1|dublado|legendado|dual(?:\s*audio)?|multi(?:\s*audio)?|nacional|pt\s*br|portugues|português)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function extractArtworkYear(value) {
  const matches = String(value || "").match(/\b(?:19\d{2}|20\d{2})\b/g) || [];
  if (!matches.length) return null;
  const year = Number(matches[matches.length - 1]);
  return Number.isInteger(year) ? year : null;
}

function cleanupDisplayTitle(value) {
  return text(value)
    .replace(/[\[\{][^\]\}]*[\]\}]/g, " ")
    .replace(/\b(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})\b.*$/i, " ")
    .replace(/\b(?:temporada|season)\s*\d+.*$/i, " ")
    .replace(/\b(?:episodio|episódio|episode|ep)\s*\d+.*$/i, " ")
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, " ")
    .replace(/\b(?:4k|uhd|fhd|full\s*hd|hd|sd|2160p|1080p|720p|480p|hdr10?|dolby\s*vision|imax|bluray|blu\s*ray|brrip|webrip|web\s*dl|web-dl|h\.?26[45]|x26[45]|hevc|av1|dublado|legendado|dual(?:\s*audio)?|multi(?:\s*audio)?|nacional|pt\s*br)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[-|:]+$/g, "")
    .trim();
}

export function artworkDescriptor(item) {
  if (!item || typeof item !== "object") return null;

  const group = text(item.group || item.rawGroup);
  const seriesTitle = text(item.seriesTitle);
  const name = text(item.name);
  const groupLower = stripDiacritics(group).toLowerCase();

  let kind = "";
  if (
    seriesTitle ||
    groupLower.startsWith("series") ||
    groupLower.includes("series |") ||
    /\b(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})\b/i.test(name)
  ) {
    kind = "tv";
  } else if (
    groupLower.startsWith("filmes") ||
    groupLower.includes("filmes |") ||
    text(item.section).toLowerCase() === "filmes"
  ) {
    kind = "movie";
  } else {
    return null;
  }

  const sourceTitle = kind === "tv" && seriesTitle ? seriesTitle : name;
  const query = cleanupDisplayTitle(sourceTitle);
  const normalized = normalizeArtworkTitle(query);
  if (normalized.length < 2) return null;

  return {
    kind,
    query,
    normalized,
    year: extractArtworkYear(sourceTitle) || extractArtworkYear(name)
  };
}

function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

function candidateTitles(result, kind) {
  return kind === "movie"
    ? [result?.title, result?.original_title]
    : [result?.name, result?.original_name];
}

function candidateYear(result, kind) {
  const date = kind === "movie" ? result?.release_date : result?.first_air_date;
  const match = String(date || "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function scoreTmdbCandidate(descriptor, result) {
  const titles = candidateTitles(result, descriptor.kind)
    .map(normalizeArtworkTitle)
    .filter(Boolean);

  let titleScore = 0;
  for (const candidate of titles) {
    titleScore = Math.max(
      titleScore,
      tokenSimilarity(descriptor.normalized, candidate)
    );
  }

  if (titleScore === 0) return 0;

  let score = titleScore;
  const expectedYear = descriptor.year;
  const actualYear = candidateYear(result, descriptor.kind);

  if (expectedYear && actualYear) {
    const difference = Math.abs(expectedYear - actualYear);
    if (difference === 0) score += 0.08;
    else if (difference === 1) score += 0.02;
    else score -= 0.18;
  }

  return Math.max(0, Math.min(1, score));
}

function cacheKey(descriptor) {
  return [
    descriptor.kind,
    descriptor.normalized,
    descriptor.year || ""
  ].join("|");
}

function normalizeCache(raw) {
  if (!raw || typeof raw !== "object") return { version: 1, entries: {} };
  if (raw.entries && typeof raw.entries === "object") {
    return {
      version: 1,
      entries: { ...raw.entries }
    };
  }
  return { version: 1, entries: { ...raw } };
}

function usableCacheEntry(entry, now) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.url) return true;
  const checkedAt = Date.parse(entry.checked_at || "");
  return Number.isFinite(checkedAt) && now - checkedAt < NEGATIVE_TTL_MS;
}

function assignArtwork(items, url) {
  if (!url) return 0;
  let assigned = 0;
  for (const item of items) {
    if (!text(item.logo)) {
      item.logo = url;
      assigned += 1;
    }
  }
  return assigned;
}

function tmdbUrl(path, params, apiKey) {
  const url = new URL(TMDB_API_BASE + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTmdbJson(url, { token, timeoutMs }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: "Bearer " + token } : {})
        }
      });

      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get("retry-after") || 1);
        await sleep(Math.max(250, Math.min(5000, retryAfter * 1000)));
        continue;
      }

      if (!response.ok) {
        throw new Error("TMDB HTTP " + response.status);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("TMDB request failed after retry");
}

async function lookupTmdb(descriptor, options) {
  const params = {
    query: descriptor.query,
    include_adult: "false",
    language: options.language,
    page: 1
  };
  if (descriptor.year) {
    if (descriptor.kind === "movie") params.year = descriptor.year;
    else params.first_air_date_year = descriptor.year;
  }

  const path = descriptor.kind === "movie" ? "/search/movie" : "/search/tv";
  const url = tmdbUrl(path, params, options.apiKey);
  const data = await fetchTmdbJson(url, options);
  const results = Array.isArray(data?.results) ? data.results : [];

  let best = null;
  let bestScore = 0;
  for (const result of results.slice(0, 10)) {
    if (!result?.poster_path) continue;
    const score = scoreTmdbCandidate(descriptor, result);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }

  if (!best || bestScore < options.minScore) {
    return { url: "", id: null, score: bestScore };
  }

  return {
    url: TMDB_IMAGE_BASE + best.poster_path,
    id: best.id || null,
    score: Number(bestScore.toFixed(3))
  };
}

export async function enrichArtwork(items, rawCache = {}, options = {}) {
  // Credenciais ficam somente no ambiente do CI; nunca entram nos artefatos publicados.
  const token = text(options.token ?? process.env.TMDB_API_TOKEN);
  const apiKey = text(options.apiKey ?? process.env.TMDB_API_KEY);
  const enabled = Boolean(token || apiKey);
  const cache = normalizeCache(rawCache);
  const now = Date.now();

  const report = {
    enabled,
    eligible_items: 0,
    unique_titles: 0,
    cache_hits: 0,
    lookups: 0,
    matched: 0,
    not_found: 0,
    failed: 0,
    items_enriched: 0,
    deferred_by_budget: 0
  };

  const groups = new Map();
  for (const item of items || []) {
    if (text(item?.logo)) continue;
    const descriptor = artworkDescriptor(item);
    if (!descriptor) continue;

    report.eligible_items += 1;
    const key = cacheKey(descriptor);
    let row = groups.get(key);
    if (!row) {
      row = { key, descriptor, items: [] };
      groups.set(key, row);
    }
    row.items.push(item);
  }

  const ordered = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  report.unique_titles = ordered.length;

  const pending = [];
  for (const group of ordered) {
    const entry = cache.entries[group.key];
    if (usableCacheEntry(entry, now)) {
      report.cache_hits += 1;
      report.items_enriched += assignArtwork(group.items, text(entry.url));
    } else {
      pending.push(group);
    }
  }

  if (!enabled || !pending.length) {
    return { cache, report };
  }

  const maxLookups = Math.max(
    0,
    Math.floor(Number(options.maxLookups ?? process.env.TMDB_MAX_LOOKUPS ?? 2000))
  );
  const concurrency = Math.max(
    1,
    Math.min(12, Math.floor(Number(options.concurrency ?? process.env.TMDB_CONCURRENCY ?? 6)))
  );
  const timeoutMs = Math.max(
    1000,
    Math.floor(Number(options.timeoutMs ?? process.env.TMDB_TIMEOUT_MS ?? 7000))
  );
  const minScore = Math.max(
    0.5,
    Math.min(1, Number(options.minScore ?? process.env.TMDB_MIN_SCORE ?? 0.86))
  );
  const language = text(options.language ?? process.env.TMDB_LANGUAGE) || "pt-BR";
  const selected = pending.slice(0, maxLookups);
  report.deferred_by_budget = Math.max(0, pending.length - selected.length);

  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;

      const group = selected[index];
      report.lookups += 1;

      try {
        const result = await lookupTmdb(group.descriptor, {
          token,
          apiKey,
          timeoutMs,
          minScore,
          language
        });

        const checkedAt = new Date().toISOString();
        cache.entries[group.key] = {
          url: result.url,
          tmdb_id: result.id,
          score: result.score,
          checked_at: checkedAt
        };

        if (result.url) {
          report.matched += 1;
          report.items_enriched += assignArtwork(group.items, result.url);
        } else {
          report.not_found += 1;
        }
      } catch {
        // Falhas de rede/API não viram cache negativo: a próxima execução
        // poderá tentar novamente sem prejudicar a geração da playlist.
        report.failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, selected.length)) }, () => worker())
  );

  return { cache, report };
}
