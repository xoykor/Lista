// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeName } from "./normalize.js";
import { isRestrictedText } from "./restricted.js";
import {
  canonicalGroupTitle,
  canonicalizeItem,
  orderCatalogByTaxonomy,
  SERIES_PROVIDER_CATEGORIES,
  SERIES_SPECIAL_CATEGORIES
} from "./taxonomy.js";

function clean(value) {
  return String(value || "").trim();
}

function attr(line, name) {
  const match = String(line).match(new RegExp(name + '="([^"]*)"', "i"));
  return match ? match[1] : "";
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function variantKey(variant) {
  return [
    clean(variant.url),
    clean(variant.referer),
    clean(variant.userAgent),
    clean(variant.language)
  ].join("\u0000");
}

function stripLanguageDecorators(value) {
  return String(value || "")
    .replace(/(?:^|[\s|\-_.\[\]()])(?:dub|dublado|dublada|leg|legendado|legendada)(?=$|[\s|\-_.\[\]()])/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function episodeIdentity(value) {
  const text = String(value || "");
  let match = text.match(/(?:^|[^A-Za-z0-9])[ST]\s*(\d{1,3})\s*[-._ ]*E\s*(\d{1,4})(?:[^A-Za-z0-9]|$)/i);
  if (!match) {
    match = text.match(/(?:^|[^A-Za-z0-9])(\d{1,3})\s*[xX]\s*(\d{1,4})(?:[^A-Za-z0-9]|$)/);
  }
  if (!match) {
    match = text.match(
      /(?:temporada|temp)\s*(\d{1,3}).*?(?:episodio|episódio|ep)\s*(\d{1,4})/i
    );
  }
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

function itemKey(item) {
  const section = item.section || item.sectionHint || "";
  if (section === "Séries") {
    const episode = episodeIdentity(item.name);
    const base = normalizeName(seriesBaseName(stripLanguageDecorators(item.seriesTitle || item.name)));
    if (episode && base) {
      return section + "\u0000" + base + "\u0000" + episode.season + "\u0000" + episode.episode;
    }
    return section + "\u0000" + normalizeName(stripLanguageDecorators(item.name));
  }

  if (section === "Filmes") {
    return section + "\u0000" + normalizeName(stripLanguageDecorators(item.name));
  }

  return section + "\u0000" + normalizeName(item.name);
}

function stripYear(title) {
  return clean(title).replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
}

export function seriesBaseName(value) {
  return stripYear(stripLanguageDecorators(String(value || "")))
    .replace(/^\s*(?:series?|série|seriados?)\s*[:|_\-]+\s*/i, "")
    .replace(/^\s*(?:netflix|prime\s+video|amazon\s+prime(?:\s+video)?|disney\s*\+|disney\s+plus|hbo\s+max|max|apple\s+tv\s*\+|apple\s+tv\s+plus|paramount\s*\+|paramount\s+plus|globoplay|crunchyroll|star\s*\+|star\s+plus|discovery\s*\+|discovery\s+plus|hulu|peacock|starz|mgm\s*\+|amc\s*\+|universal\s*\+)\s*[:|_\-]+\s*/i, "")
    .replace(/\s*[-|:]?\s*(?:S|T)\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}.*$/i, "")
    .replace(/\s*[-|:]?\s*\d{1,3}\s*[xX]\s*\d{1,4}.*$/, "")
    .replace(/\s*[-|:]?\s*(?:temporada|temp)\s*\d{1,3}\s*(?:episodio|episódio|ep)\s*\d{1,4}.*$/i, "")
    .replace(/\s*[-|:]?\s*(?:EP|EPISODIO|EPISÓDIO)\s*\d+.*$/i, "")
    .replace(/\s*[-|:]?\s*(?:temporada|temp)\s*\d{1,3}\s*$/i, "")
    .replace(/\s*\b(?:completo|completa)\b\s*$/i, "")
    .trim();
}

function titleKeys(value, section) {
  const source = section === "Séries"
    ? seriesBaseName(value)
    : stripYear(stripLanguageDecorators(value));
  const keys = new Set();
  const exact = normalizeName(source);
  if (exact.length >= 2) keys.add(exact);

  let loose = exact
    .replace(/^(?:series?|serie|seriado|seriados|filmes?|movie|movies|vod)\s+/, "")
    .replace(/^(?:netflix|prime video|amazon prime video|amazon prime|disney plus|hbo max|max|apple tv plus|apple tv|paramount plus|globoplay|crunchyroll|star plus|discovery plus|hulu|peacock|starz|mgm plus|amc plus|universal plus)\s+/, "")
    .replace(/^\d{1,3}\s+/, "")
    .replace(/\s+(?:dublado|dublada|legendado|legendada|dub|leg)$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (loose.length >= 3) keys.add(loose);
  return [...keys];
}

export function parseM3UText(text, source = {}) {
  const out = [];
  let pending = null;
  let referer = "";
  let userAgent = "";

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma = line.lastIndexOf(",");
      const title = comma >= 0 ? line.slice(comma + 1).trim() : "";
      pending = {
        name: attr(line, "tvg-name") || attr(line, "tvg-id") || title,
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title")
      };
      referer = "";
      userAgent = "";
      continue;
    }

    if (line.startsWith("#EXTVLCOPT:http-referrer=")) {
      referer = line.slice("#EXTVLCOPT:http-referrer=".length).trim();
      continue;
    }

    if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
      userAgent = line.slice("#EXTVLCOPT:http-user-agent=".length).trim();
      continue;
    }

    if (line.startsWith("#")) continue;

    if (pending && validHttpUrl(line)) {
      const item = {
        name: pending.name,
        logo: pending.logo,
        group: pending.group,
        rawGroup: pending.group,
        kindHint: source.kind || "",
        variants: [{
          url: line,
          referer: referer || null,
          userAgent: userAgent || null,
          origin: source.id || "",
          priority: Number(source.priority || 50)
        }]
      };
      canonicalizeItem(item);
      out.push(item);
    }

    pending = null;
    referer = "";
    userAgent = "";
  }

  return out;
}

export function parseSaimoCatalogText(text, source = {}) {
  const out = [];
  let item = null;
  let variant = null;

  function flush() {
    if (item?.name && item.variants.length) {
      item.sectionHint = "TV";
      item.kindHint = "live";
      canonicalizeItem(item);
      out.push(item);
    }
    item = null;
    variant = null;
  }

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("canal:")) {
      flush();
      item = {
        name: line.slice(6).trim(),
        logo: "",
        group: "",
        rawGroup: "",
        variants: []
      };
      continue;
    }
    if (!item) continue;

    if (line.startsWith("logo:")) {
      item.logo = line.slice(5).trim();
    } else if (line.startsWith("categoria:")) {
      item.group = line.slice(10).trim();
      item.rawGroup = item.group;
    } else if (line.startsWith("fonte:")) {
      const url = line.slice(6).trim();
      variant = validHttpUrl(url) ? {
        url,
        referer: null,
        userAgent: null,
        origin: source.id || "saimo-catalogo",
        priority: Number(source.priority || 5)
      } : null;
      if (variant) item.variants.push(variant);
    } else if (variant && line.startsWith("referer:")) {
      variant.referer = line.slice(8).trim() || null;
    } else if (variant && line.startsWith("agente:")) {
      variant.userAgent = line.slice(7).trim() || null;
    } else if (variant && line.startsWith("chave:")) {
      // DRM/ClearKey não entra na lista estática.
      const index = item.variants.indexOf(variant);
      if (index >= 0) item.variants.splice(index, 1);
      variant = null;
    }
  }

  flush();
  return out;
}

export function parseSaimoBases(text) {
  const bases = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const match = raw.match(/^base:\s*(\d+)\s+(https?:\/\/\S+)\s*$/i);
    if (!match) continue;
    bases[Number(match[1])] = match[2];
  }
  return bases;
}

export function resolveSaimoSource(value, bases) {
  const source = clean(value);
  if (!source) return "";
  if (validHttpUrl(source)) return source;

  const colon = source.indexOf(":");
  if (colon <= 0) return "";
  const index = Number(source.slice(0, colon));
  if (!Number.isInteger(index) || !bases[index]) return "";

  const rest = source.slice(colon + 1);
  if (!rest) return "";
  return bases[index] + rest + (rest.includes(".") ? "" : ".mp4");
}

function parseVersionFields(fields, bases, meta = {}) {
  const variants = [];

  for (const field of fields) {
    const equal = field.indexOf("=");
    if (equal <= 0) continue;
    const language = clean(field.slice(0, equal)).toLowerCase();
    if (!["dub", "leg"].includes(language)) continue;

    for (const raw of field.slice(equal + 1).split(",")) {
      const url = resolveSaimoSource(raw, bases);
      if (!validHttpUrl(url)) continue;
      variants.push({
        url,
        referer: null,
        userAgent: null,
        language,
        origin: meta.origin || "saimo-vod",
        priority: Number(meta.priority ?? (language === "dub" ? 3 : 4))
      });
    }
  }

  return variants;
}

function parseSaimoMovieLines(text, bases, meta = {}) {
  const out = [];

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    const fields = raw.split("\t");
    const name = clean(fields[0]);
    if (!name) continue;

    const variants = parseVersionFields(fields.slice(1), bases, meta);
    if (!variants.length) continue;

    out.push({
      name,
      logo: "",
      group: "Filmes",
      rawGroup: meta.rawGroup || "Filmes",
      sectionHint: "Filmes",
      categoryHint: meta.category || "",
      variants
    });
  }

  return out;
}

function episodeName(series, season, episode) {
  const s = String(Math.max(0, Number(season) || 0)).padStart(2, "0");
  const e = String(Math.max(0, Number(episode) || 0)).padStart(2, "0");
  return series + " S" + s + "E" + e;
}

function parseSaimoSeriesBlocks(text, bases, meta = {}) {
  const map = new Map();
  let series = "";

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;

    if (raw.startsWith("@")) {
      series = clean(raw.slice(1).split("\t")[0]);
      continue;
    }
    if (!series) continue;

    const fields = raw.split("\t");
    if (fields.length < 4) continue;

    const season = Number(fields[0]);
    const episode = Number(fields[1]);
    const language = clean(fields[2]).toLowerCase();
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    if (!["dub", "leg"].includes(language)) continue;

    const name = episodeName(series, season, episode);
    const key = normalizeName(name);
    let item = map.get(key);
    if (!item) {
      item = {
        name,
        seriesTitle: series,
        logo: "",
        group: meta.group || "Séries",
        rawGroup: meta.rawGroup || meta.group || "Séries",
        sectionHint: "Séries",
        categoryHint: meta.category || "",
        variants: []
      };
      map.set(key, item);
    }

    for (const source of fields[3].split(",")) {
      const url = resolveSaimoSource(source, bases);
      if (!validHttpUrl(url)) continue;
      item.variants.push({
        url,
        referer: null,
        userAgent: null,
        language,
        origin: meta.origin || "saimo-vod",
        priority: Number(meta.priority ?? (language === "dub" ? 3 : 4))
      });
    }
  }

  return [...map.values()].filter((item) => item.variants.length);
}

async function filesMatching(directory, regex) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readUtf8(file) {
  return readFile(file, "utf8");
}

function appendAll(target, rows) {
  for (const row of rows || []) target.push(row);
}

function addSpecialTitle(index, title, category) {
  const key = normalizeName(seriesBaseName(title));
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, category);
    return;
  }
  const previous = index.get(key);
  if (previous !== category) index.set(key, null);
}

async function loadSaimoSpecialSeriesIndex(redeflix) {
  const index = new Map();
  const idCategory = new Map();

  for (const [file, category] of [
    ["ids-animes.txt", "Anime"],
    ["ids-doramas.txt", "Doramas"]
  ]) {
    try {
      for (const line of (await readUtf8(path.join(redeflix, file))).split(/\r?\n/)) {
        const id = line.trim();
        if (id) idCategory.set(id, category);
      }
    } catch {
      // Metadata auxiliar opcional.
    }
  }

  try {
    const mapping = JSON.parse(
      await readUtf8(path.join(redeflix, "series-tmdb.json"))
    );
    for (const [compound, tmdb] of Object.entries(mapping || {})) {
      const category = idCategory.get(String(tmdb));
      if (!category) continue;
      const title = String(compound).split("\u001f").at(-1) || "";
      addSpecialTitle(index, title, category);
    }
  } catch {
    // O índice antigo pode não existir em forks/commits intermediários.
  }

  for (const [file, category] of [
    ["catalogo-animes.txt", "Anime"],
    ["catalogo-doramas.txt", "Doramas"]
  ]) {
    try {
      for (const line of (await readUtf8(path.join(redeflix, file))).split(/\r?\n/)) {
        const fields = line.split("\t");
        if (fields.length >= 2) addSpecialTitle(index, fields[1], category);
      }
    } catch {
      // Metadata auxiliar opcional.
    }
  }

  return index;
}

function applySaimoSpecialSeriesIndex(rows, index) {
  let classified = 0;
  for (const item of rows || []) {
    if (item.categoryHint) continue;
    const key = normalizeName(seriesBaseName(item.seriesTitle || item.name));
    const category = index.get(key);
    if (!category) continue;
    item.categoryHint = category;
    classified += 1;
  }
  return classified;
}

export async function loadSaimoVod(root) {
  const vod = path.join(root, "vod");
  const bases = parseSaimoBases(await readUtf8(path.join(vod, "indice.txt")));
  const items = [];
  const redeflix = path.join(vod, "redeflix");
  const specialSeries = await loadSaimoSpecialSeriesIndex(redeflix);
  let specialSeriesHits = 0;

  const movieFiles = await filesMatching(vod, /^filmes-(?:#|%23|[A-Z])\.txt$/i);
  for (const file of movieFiles) {
    appendAll(items, parseSaimoMovieLines(
      await readUtf8(path.join(vod, file)),
      bases,
      { origin: "saimo-vod", priority: 8 }
    ));
  }

  const seriesFiles = await filesMatching(vod, /^series-(?:#|%23|[A-Z])-\d+\.txt$/i);
  for (const file of seriesFiles) {
    const rows = parseSaimoSeriesBlocks(
      await readUtf8(path.join(vod, file)),
      bases,
      { origin: "saimo-vod", priority: 8 }
    );
    specialSeriesHits += applySaimoSpecialSeriesIndex(rows, specialSeries);
    appendAll(items, rows);
  }
  const extraMovies = path.join(redeflix, "links-filmes.txt");
  try {
    appendAll(items, parseSaimoMovieLines(
      await readUtf8(extraMovies),
      bases,
      { origin: "saimo-redeflix", priority: 1 }
    ));
  } catch {
    // O arquivo é opcional.
  }

  for (const [file, category] of [
    ["links-series.txt", ""],
    ["links-animes.txt", "Anime"],
    ["links-doramas.txt", "Doramas"]
  ]) {
    try {
      appendAll(items, parseSaimoSeriesBlocks(
        await readUtf8(path.join(redeflix, file)),
        bases,
        { origin: "saimo-redeflix", priority: 1, category }
      ));
    } catch {
      // Coleções opcionais não impedem a regeneração.
    }
  }

  Object.defineProperty(items, "metadataReport", {
    value: {
      special_series_titles: specialSeries.size,
      special_series_episode_hits: specialSeriesHits
    },
    enumerable: false
  });
  return items;
}

export async function loadLocalUpstreams({ saimoRoot, ramysRoot }) {
  const items = [];
  const sourceStats = {};

  const push = (id, rows) => {
    sourceStats[id] = rows.length;
    appendAll(items, rows);
  };

  push("saimo-catalogo", parseSaimoCatalogText(
    await readUtf8(path.join(saimoRoot, "catalogo.txt")),
    { id: "saimo-catalogo", priority: 1 }
  ));

  try {
    push("saimo-canais", parseM3UText(
      await readUtf8(path.join(saimoRoot, "canais.txt")),
      { id: "saimo-canais", kind: "live", priority: 2 }
    ));
  } catch {
    sourceStats["saimo-canais"] = 0;
  }

  const ramysFiles = [
    ["ramys-br01", "CanaisBR01.m3u8", "live", 10],
    ["ramys-br02", "CanaisBR02.m3u8", "live", 11],
    ["ramys-br03", "CanaisBR03.m3u8", "live", 12],
    ["ramys-br04", "CanaisBR04.m3u8", "live", 13],
    ["ramys-vod", "Filmes-Series.m3u8", "vod", 10]
  ];

  for (const [id, file, kind, priority] of ramysFiles) {
    try {
      push(id, parseM3UText(
        await readUtf8(path.join(ramysRoot, file)),
        { id, kind, priority }
      ));
    } catch {
      sourceStats[id] = 0;
    }
  }

  const vod = await loadSaimoVod(saimoRoot);
  push("saimo-vod", vod);
  if (vod.metadataReport) sourceStats["saimo-metadata"] = vod.metadataReport;

  return { items, sourceStats };
}

function categoryRank(section, category) {
  if (section === "Séries") {
    if (SERIES_PROVIDER_CATEGORIES.has(category)) return 30;
    if (SERIES_SPECIAL_CATEGORIES.has(category)) return 20;
    return 10;
  }
  return 10;
}

function evidenceOrigins(item) {
  const origins = new Set();
  for (const variant of item.variants || []) {
    if (variant?.origin) origins.add(String(variant.origin));
  }
  if (!origins.size) origins.add("unknown");
  return origins;
}

function addCategoryEvidence(map, key, section, category, origins) {
  if (!key || !category || category === "Outros") return;
  let row = map.get(key);
  if (!row) {
    row = new Map();
    map.set(key, row);
  }

  let evidence = row.get(category);
  if (!evidence) {
    evidence = { rank: categoryRank(section, category), origins: new Set() };
    row.set(category, evidence);
  }
  for (const origin of origins) evidence.origins.add(origin);
}

function resolveEvidence(map) {
  const resolved = new Map();
  let ambiguous = 0;

  for (const [key, categories] of map) {
    let bestRank = -1;
    for (const evidence of categories.values()) {
      if (evidence.rank > bestRank) bestRank = evidence.rank;
    }

    const top = [...categories.entries()]
      .filter(([, evidence]) => evidence.rank === bestRank)
      .sort((a, b) => b[1].origins.size - a[1].origins.size);

    if (
      top.length === 1 ||
      top[0][1].origins.size > (top[1]?.[1].origins.size || 0)
    ) {
      resolved.set(key, top[0][0]);
    } else {
      ambiguous += 1;
    }
  }

  return { resolved, ambiguous };
}

export function buildEnrichmentIndex(items) {
  const movieEvidence = new Map();
  const seriesEvidence = new Map();

  for (const item of items || []) {
    if (!item.group || item.group === "Outros") continue;
    const origins = evidenceOrigins(item);

    if (item.section === "Filmes") {
      for (const key of titleKeys(item.name, "Filmes")) {
        addCategoryEvidence(
          movieEvidence,
          key,
          "Filmes",
          item.group,
          origins
        );
      }
    } else if (item.section === "Séries") {
      for (const key of titleKeys(item.seriesTitle || item.name, "Séries")) {
        addCategoryEvidence(
          seriesEvidence,
          key,
          "Séries",
          item.group,
          origins
        );
      }
    }
  }

  const movies = resolveEvidence(movieEvidence);
  const series = resolveEvidence(seriesEvidence);

  return {
    movies: movies.resolved,
    series: series.resolved,
    report: {
      movie_keys: movies.resolved.size,
      series_keys: series.resolved.size,
      ambiguous_movie_keys: movies.ambiguous,
      ambiguous_series_keys: series.ambiguous
    }
  };
}

function lookupCategory(map, value, section) {
  for (const key of titleKeys(value, section)) {
    const category = map.get(key);
    if (category) return category;
  }
  return "";
}

export function applyEnrichment(items, index, report = null) {
  let movies = 0;
  let series = 0;

  for (const item of items || []) {
    if (item.section === "Filmes" && item.group === "Outros") {
      const category = lookupCategory(index.movies, item.name, "Filmes");
      if (category) {
        item.group = category;
        movies += 1;
      }
    } else if (item.section === "Séries" && item.group === "Outros") {
      const category = lookupCategory(
        index.series,
        item.seriesTitle || item.name,
        "Séries"
      );
      if (category) {
        item.group = category;
        series += 1;
      }
    }
  }

  if (report) {
    report.enriched_movies = movies;
    report.enriched_series = series;
  }
  return items;
}

function topUnclassifiedRawGroups(items, limit = 30) {
  const counts = new Map();
  for (const item of items || []) {
    if (item.group !== "Outros") continue;
    if (isRestrictedText(item.name, item.rawGroup || item.group)) continue;
    const raw = clean(item.rawGroup);
    if (!raw) continue;
    const key = item.section + " | " + raw;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([group, count]) => ({ group, count }));
}

function mergeVariants(target, incoming) {
  const known = new Set(target.variants.map(variantKey));
  for (const variant of incoming.variants || []) {
    const key = variantKey(variant);
    if (!known.has(key)) {
      target.variants.push(variant);
      known.add(key);
    }
  }
}

export function mergeCatalog(items, { report = null } = {}) {
  // Primeiro classifica tudo para que TV, Filmes e Séries com o mesmo nome
  // nunca sejam fundidos acidentalmente.
  for (const item of items || []) canonicalizeItem(item);

  const enrichment = buildEnrichmentIndex(items);
  const enrichmentReport = {};
  applyEnrichment(items, enrichment, enrichmentReport);

  if (report) {
    Object.assign(report, enrichment.report, enrichmentReport);
    report.top_unclassified_raw_groups = topUnclassifiedRawGroups(items);
  }

  const map = new Map();
  let restrictedRemoved = 0;

  for (const item of items || []) {
    if (!item?.name || !item.variants?.length) continue;
    if (isRestrictedText(item.name, item.rawGroup || item.group)) {
      restrictedRemoved += 1;
      continue;
    }

    const key = itemKey(item);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        ...item,
        variants: [...item.variants]
      });
      continue;
    }

    if (!current.logo && item.logo) current.logo = item.logo;
    if (current.group === "Outros" && item.group !== "Outros") current.group = item.group;

    const currentPriority = Math.min(...current.variants.map((variant) => Number(variant.priority || 50)));
    const incomingPriority = Math.min(...item.variants.map((variant) => Number(variant.priority || 50)));
    if (incomingPriority < currentPriority) {
      current.name = item.name;
      if (item.seriesTitle) current.seriesTitle = item.seriesTitle;
    }

    mergeVariants(current, item);
  }

  if (report) report.restricted_rows_removed = restrictedRemoved;

  for (const item of map.values()) {
    item.variants.sort((a, b) => {
      const langA = a.language === "dub" ? 0 : a.language === "leg" ? 1 : 2;
      const langB = b.language === "dub" ? 0 : b.language === "leg" ? 1 : 2;
      return (
        langA - langB ||
        Number(a.priority || 50) - Number(b.priority || 50) ||
        String(a.url || "").length - String(b.url || "").length
      );
    });
  }

  return orderCatalogByTaxonomy([...map.values()]);
}

function runtimeFallbackVariants(item, maxVariants = 6) {
  const primary = chooseVariant(item);
  if (!primary) return [];

  const language = clean(primary.language).toLowerCase();
  const out = [];
  const seen = new Set();

  for (const variant of item.variants || []) {
    if (!validHttpUrl(variant.url)) continue;

    // Um 307 não consegue transportar Referer/User-Agent para o player.
    // Essas fontes continuam protegidas pelo fallback da sanitização de 12h,
    // mas não entram no resolvedor leve do Worker.
    if (variant.referer || variant.userAgent) continue;

    const variantLanguage = clean(variant.language).toLowerCase();
    if (language && variantLanguage && variantLanguage !== language) continue;
    if (language && !variantLanguage) continue;

    if (seen.has(variant.url)) continue;
    seen.add(variant.url);
    out.push(variant);
    if (out.length >= maxVariants) break;
  }

  return out;
}

export function catalogItemId(item) {
  return createHash("sha256")
    .update(itemKey(item))
    .digest("hex")
    .slice(0, 20);
}

export function buildFailoverIndex(items, { maxVariants = 6 } = {}) {
  const shards = new Map();
  const ids = new Map();
  const digest = createHash("sha256");
  let entries = 0;
  let crossOriginEntries = 0;
  let sourceCount = 0;

  for (const item of items || []) {
    const variants = runtimeFallbackVariants(item, maxVariants);
    if (variants.length < 2) continue;

    const id = catalogItemId(item);
    const compact = variants.map((variant) => [
      variant.url,
      variant.origin || ""
    ]);
    const shard = id.slice(0, 2);

    let rows = shards.get(shard);
    if (!rows) {
      rows = {};
      shards.set(shard, rows);
    }
    rows[id] = compact;
    ids.set(item, id);

    const origins = new Set(
      variants.map((variant) => variant.origin).filter(Boolean)
    );
    if (origins.size > 1) crossOriginEntries += 1;

    entries += 1;
    sourceCount += variants.length;
    digest.update(id);
    digest.update(JSON.stringify(compact));
  }

  return {
    shards,
    ids,
    version: digest.digest("hex").slice(0, 12),
    report: {
      entries,
      cross_origin_entries: crossOriginEntries,
      variants: sourceCount,
      shards: shards.size
    }
  };
}

export function renderFailoverShards(index) {
  const files = new Map();
  for (const [prefix, rows] of index?.shards || []) {
    files.set(prefix + ".json", JSON.stringify(rows));
  }
  return files;
}

function stableHash32(value, seed) {
  let hash = seed | 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (((hash << 5) - hash) + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function cardLookupKey(name, group) {
  const value = String(group || "") + "\u0000" + String(name || "");
  return stableHash32(value, 0x13579bdf) +
    stableHash32(value, 0x2468ace1);
}

export function buildCardIndex(items) {
  const rows = new Map();
  const digest = createHash("sha256");
  let entries = 0;

  for (const item of items || []) {
    const logo = clean(item?.logo);
    if (!validHttpUrl(logo)) continue;

    const group = canonicalGroupTitle(item);
    const key = cardLookupKey(item.name, group);
    rows.set(key, logo);
  }

  const ordered = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, logo] of ordered) {
    digest.update(key);
    digest.update("\u0000");
    digest.update(logo);
    digest.update("\n");
    entries += 1;
  }

  return {
    rows,
    version: digest.digest("hex").slice(0, 12),
    report: { entries }
  };
}

export function renderCardShards(index, { prefixLengths = [1, 2] } = {}) {
  const files = new Map();
  const lengths = [...new Set(
    (prefixLengths || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 4)
  )];

  for (const prefixLength of lengths) {
    const shards = new Map();

    for (const [key, logo] of index?.rows || []) {
      const prefix = key.slice(0, prefixLength);
      let rows = shards.get(prefix);
      if (!rows) {
        rows = {};
        shards.set(prefix, rows);
      }
      rows[key] = logo;
    }

    for (const [prefix, rows] of shards) {
      files.set(prefix + ".json", JSON.stringify(rows));
    }
  }

  return files;
}

function escapeM3U(value) {
  return String(value || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

export function chooseVariant(item) {
  return (item.variants || []).find((variant) => validHttpUrl(variant.url)) || null;
}

export function renderCompactM3U(
  items,
  {
    maxBytes = 95 * 1024 * 1024,
    workerOrigin = "",
    failoverIndex = null,
    cardIndexBase = "",
    cardIndexVersion = "",
    cardIndexShardLength = 1
  } = {}
) {
  const lines = ["#EXTM3U"];
  if (cardIndexBase) {
    lines.push("#EXT-X-LISTA-CARDS:" + cardIndexBase.replace(/\/$/, ""));
    if (cardIndexVersion) {
      lines.push("#EXT-X-LISTA-CARDS-VERSION:" + cardIndexVersion);
    }
    if (Number(cardIndexShardLength) > 1) {
      lines.push(
        "#EXT-X-LISTA-CARDS-SHARD-LEN:" +
        Math.max(1, Math.min(4, Math.floor(Number(cardIndexShardLength))))
      );
    }
  }
  let bytes = Buffer.byteLength(lines.join("\n") + "\n");
  let included = 0;
  let omittedBySize = 0;

  for (const item of items || []) {
    const variant = chooseVariant(item);
    if (!variant) continue;

    const fallbackId = failoverIndex?.ids?.get(item) || "";
    const viaWorker = Boolean(fallbackId && workerOrigin);
    const playbackUrl = viaWorker
      ? workerOrigin.replace(/\/$/, "") +
        "/channel/" + fallbackId +
        "?v=" + encodeURIComponent(failoverIndex.version)
      : variant.url;

    // Deliberadamente sem tvg-name/logo duplicados: a lista precisa caber no
    // limite de blob do GitHub e o Blazzing já usa o título após a vírgula.
    const extinf =
      '#EXTINF:-1 group-title="' + escapeM3U(canonicalGroupTitle(item)) + '"' +
      (fallbackId ? ' x-lista-fallback="' + escapeM3U(fallbackId) + '"' : "") +
      "," + escapeM3U(item.name);

    const extra = [];
    if (!viaWorker && variant.referer) {
      extra.push("#EXTVLCOPT:http-referrer=" + escapeM3U(variant.referer));
    }
    if (!viaWorker && variant.userAgent) {
      extra.push("#EXTVLCOPT:http-user-agent=" + escapeM3U(variant.userAgent));
    }

    const block = [extinf, ...extra, playbackUrl].join("\n") + "\n";
    const blockBytes = Buffer.byteLength(block);

    if (bytes + blockBytes > maxBytes) {
      omittedBySize += 1;
      continue;
    }

    lines.push(block.slice(0, -1));
    bytes += blockBytes;
    included += 1;
  }

  return {
    body: lines.join("\n") + "\n",
    included,
    omittedBySize,
    bytes
  };
}

export function validateCatalog(items) {
  const errors = [];
  const seen = new Set();

  for (const item of items || []) {
    if (!item.name) errors.push("item without name");
    if (!["TV", "Filmes", "Séries"].includes(item.section)) {
      errors.push("invalid section: " + item.section);
    }
    if (!item.variants?.some((variant) => validHttpUrl(variant.url))) {
      errors.push("item without usable URL: " + item.name);
    }

    const key = itemKey(item);
    if (seen.has(key)) errors.push("duplicate canonical item: " + item.name);
    seen.add(key);

    if (errors.length >= 100) break;
  }

  return { ok: errors.length === 0, errors, items: items?.length || 0 };
}
