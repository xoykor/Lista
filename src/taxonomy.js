// SPDX-License-Identifier: MIT

/*
 * Canonical catalogue taxonomy.
 *
 * Upstream IPTV playlists use thousands of incompatible group-title spellings
 * ("BR | FILMES | AÇÃO", "VOD: ACAO", "AÇÃO FILMES", ...).  This module
 * collapses them into a small deterministic taxonomy before publication.
 *
 * Important: classification is deliberately local and deterministic.  The
 * refresh job must be able to process hundreds of thousands of rows without an
 * LLM, an external database, or per-item network calls.
 */

export const TAXONOMY = Object.freeze({
  TV: Object.freeze([
    "Abertos",
    "Esportes",
    "Notícias",
    "Infantil",
    "Documentários",
    "Entretenimento",
    "Variedades",
    "Música",
    "Religiosos",
    "Educativo",
    "Internacional",
    "Regionais",
    "Outros"
  ]),
  Filmes: Object.freeze([
    "Ação",
    "Aventura",
    "Animação",
    "Comédia",
    "Crime",
    "Documentário",
    "Drama",
    "Família",
    "Fantasia",
    "Ficção Científica",
    "Guerra",
    "Mistério",
    "Romance",
    "Suspense",
    "Terror",
    "Faroeste",
    "Outros"
  ]),
  Séries: Object.freeze([
    "Ação",
    "Aventura",
    "Animação",
    "Anime",
    "Comédia",
    "Crime",
    "Documentário",
    "Drama",
    "Família",
    "Fantasia",
    "Ficção Científica",
    "Mistério",
    "Romance",
    "Suspense",
    "Terror",
    "Doramas",
    "Novelas",
    "Outros"
  ])
});

export const TAXONOMY_SECTIONS = Object.freeze(["TV", "Filmes", "Séries"]);

const KNOWN_LIVE_ORIGINS = new Set([
  "saimo-catalogo",
  "saimo-canais",
  "pluto-br"
]);

const SERIES_MARKERS = [
  "series",
  "serie",
  "seriados",
  "seriado",
  "temporada",
  "temporadas",
  "anime",
  "animes",
  "dorama",
  "doramas",
  "k drama",
  "kdrama",
  "novela",
  "novelas"
];

const MOVIE_MARKERS = [
  "filmes",
  "filme",
  "movies",
  "movie",
  "cinema",
  "vod"
];

const LIVE_MARKERS = [
  "canais",
  "canal",
  "tv aberta",
  "tv ao vivo",
  "ao vivo",
  "live tv",
  "live",
  "abertos",
  "esportes",
  "sports",
  "noticias",
  "news",
  "infantil",
  "kids",
  "documentarios",
  "variedades"
];

const MIXED_ENTERTAINMENT = [
  "filmes e series",
  "filme e serie",
  "filmes series",
  "movies and series",
  "movies series"
];

const FILM_GENRES = [
  ["Ficção Científica", ["ficcao cientifica", "science fiction", "sci fi", "scifi"]],
  ["Ação", ["acao", "action"]],
  ["Aventura", ["aventura", "adventure"]],
  ["Animação", ["animacao", "animation", "animated"]],
  ["Comédia", ["comedia", "comedy"]],
  ["Crime", ["crime", "criminal"]],
  ["Documentário", ["documentario", "documentary", "documentaries", "docs"]],
  ["Drama", ["drama"]],
  ["Família", ["familia", "family"]],
  ["Fantasia", ["fantasia", "fantasy"]],
  ["Guerra", ["guerra", "war"]],
  ["Mistério", ["misterio", "mystery"]],
  ["Romance", ["romance", "romantico", "romantica"]],
  ["Suspense", ["suspense", "thriller"]],
  ["Terror", ["terror", "horror"]],
  ["Faroeste", ["faroeste", "western"]]
];

const SERIES_SPECIAL = [
  ["Anime", ["anime", "animes"]],
  ["Doramas", ["dorama", "doramas", "k drama", "kdrama", "korean drama"]],
  ["Novelas", ["novela", "novelas", "telenovela", "telenovelas"]]
];

const TV_GROUP_RULES = [
  ["Abertos", ["abertos", "aberto", "tv aberta", "tv abertas"]],
  ["Esportes", [
    "esportes", "esporte", "sports", "sport", "futebol", "football", "soccer",
    "espn", "sportv", "premiere", "bandsports", "combate", "ufc", "nba", "nfl"
  ]],
  ["Notícias", [
    "noticias", "noticia", "news", "jornalismo", "jornal", "cnn", "globonews",
    "bandnews", "record news", "bbc news", "bloomberg", "cnbc"
  ]],
  ["Infantil", [
    "infantil", "kids", "criancas", "crianca", "cartoon", "nickelodeon", "nick jr",
    "discovery kids", "disney junior", "gloob", "gloobinho"
  ]],
  ["Documentários", [
    "documentarios", "documentario", "documentary", "discovery channel",
    "discovery science", "history", "animal planet", "nat geo", "national geographic"
  ]],
  ["Música", ["musica", "music", "musical", "mtv", "bis"]],
  ["Religiosos", ["religiosos", "religioso", "religiao", "gospel", "catolico", "igreja"]],
  ["Educativo", ["educativo", "educacao", "educational", "escola"]],
  ["Internacional", ["internacional", "international", "world", "exterior"]],
  ["Regionais", ["regionais", "regional", "locais", "local"]],
  ["Variedades", ["variedades", "variety", "lifestyle"]],
  ["Entretenimento", [
    "entretenimento", "entertainment", "filmes e series", "filmes", "filme",
    "series", "serie", "cinema", "telecine", "hbo", "cinemax", "warner"
  ]]
];

const TV_NAME_RULES = [
  ["Esportes", [
    "espn", "sportv", "premiere", "bandsports", "combate", "caze tv", "nba tv",
    "nfl network", "ufc"
  ]],
  ["Notícias", [
    "cnn brasil", "globonews", "bandnews", "record news", "bbc news", "bloomberg", "cnbc"
  ]],
  ["Infantil", [
    "cartoon network", "discovery kids", "nickelodeon", "nick jr", "disney junior",
    "gloob", "gloobinho"
  ]],
  ["Documentários", [
    "animal planet", "discovery channel", "discovery science", "history", "nat geo",
    "national geographic"
  ]],
  ["Música", ["mtv", "bis"]],
  ["Entretenimento", [
    "hbo", "cinemax", "telecine", "warner channel", "warner tv", "axn", "amc",
    "sony channel", "universal tv", "studio universal", "star channel", "fx"
  ]]
];

function normalizeTaxonomyText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " e ")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseMatch(text, phrase) {
  if (!text || !phrase) return false;
  return (" " + text + " ").includes(" " + phrase + " ");
}

function hasAnyPhrase(text, phrases) {
  return phrases.some((phrase) => phraseMatch(text, phrase));
}

function hasKnownLiveOrigin(item) {
  return (item?.variants || []).some((variant) => {
    if (variant?.provider === "pluto") return true;
    return KNOWN_LIVE_ORIGINS.has(String(variant?.origin || ""));
  });
}

function hasEpisodeSyntax(name) {
  const text = String(name || "");
  return (
    /(?:^|[^A-Za-z0-9])[ST]\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}(?:[^A-Za-z0-9]|$)/i.test(text) ||
    /(?:^|[^A-Za-z0-9])\d{1,3}\s*[xX]\s*\d{1,4}(?:[^A-Za-z0-9]|$)/.test(text)
  );
}

function urlHint(item) {
  let sawMovieFile = false;

  for (const variant of item?.variants || []) {
    if (!variant?.url) continue;

    let url;
    try {
      url = new URL(variant.url);
    } catch {
      continue;
    }

    const path = url.pathname.toLowerCase();
    if (/(?:^|\/)series(?:\/|$)/.test(path)) return "Séries";
    if (/(?:^|\/)(?:movie|movies|filme|filmes|vod)(?:\/|$)/.test(path)) return "Filmes";
    if (/(?:^|\/)live(?:\/|$)/.test(path)) return "TV";
    if (/\.(?:mp4|mkv|avi|mov|webm|m4v)(?:$|[?#])/.test(path)) {
      sawMovieFile = true;
    }
  }

  return sawMovieFile ? "Filmes" : "";
}

function classifySection(item) {
  const group = normalizeTaxonomyText(item?.group);
  const name = String(item?.name || "");
  const hint = urlHint(item);

  // Provider-native/Saimo catalogue rows are live channels even when their
  // editorial category is named "Filmes" or "Séries".
  if (hasKnownLiveOrigin(item)) return "TV";

  // Episode syntax is stronger evidence than a broad upstream package name.
  if (hasEpisodeSyntax(name)) return "Séries";
  if (hint === "Séries") return "Séries";

  // "Filmes e Séries" is frequently a live-TV package category.  Use a URL
  // hint when one exists; otherwise keep it under TV/Entretenimento.
  if (hasAnyPhrase(group, MIXED_ENTERTAINMENT)) {
    return hint === "Filmes" ? "Filmes" : "TV";
  }

  if (hasAnyPhrase(group, SERIES_MARKERS)) return "Séries";
  if (hasAnyPhrase(group, MOVIE_MARKERS)) return "Filmes";

  if (hint) return hint;
  if (hasAnyPhrase(group, LIVE_MARKERS)) return "TV";

  return "TV";
}

function matchRules(text, rules) {
  for (const [canonical, phrases] of rules) {
    if (hasAnyPhrase(text, phrases)) return canonical;
  }
  return "";
}

function movieOrSeriesCategory(section, group) {
  if (section === "Séries") {
    const special = matchRules(group, SERIES_SPECIAL);
    if (special) return special;
  }

  return matchRules(group, FILM_GENRES) || "Outros";
}

function tvCategory(group, name) {
  const byGroup = matchRules(group, TV_GROUP_RULES);
  if (byGroup) return byGroup;

  const byName = matchRules(name, TV_NAME_RULES);
  if (byName) return byName;

  return "Outros";
}

export function classifyTaxonomy(item) {
  const section = classifySection(item);
  const group = normalizeTaxonomyText(item?.group);
  const name = normalizeTaxonomyText(item?.name);

  if (section === "Filmes" || section === "Séries") {
    return {
      section,
      category: movieOrSeriesCategory(section, group)
    };
  }

  return {
    section: "TV",
    category: tvCategory(group, name)
  };
}

/*
 * Mutate items in place to avoid duplicating a catalogue that can exceed half
 * a million rows.  The restricted-content filter must run before this pass,
 * because the original group-title is intentionally replaced here.
 */
export function canonicalizeCatalogItems(items) {
  for (const item of items || []) {
    const classified = classifyTaxonomy(item);
    item.section = classified.section;
    item.group = classified.category;
  }

  return {
    items: items || [],
    report: summarizeTaxonomy(items || [])
  };
}

export function canonicalGroupTitle(item) {
  const section = String(item?.section || "").trim();
  const category = String(item?.group || "").trim();

  if (section && category) return section + " | " + category;
  if (category) return category;
  return section;
}

/*
 * Bucket instead of Array.sort(): O(n) ordering is materially cheaper for the
 * 500k+ entry fallback while still producing a stable section/category layout.
 */
export function orderCatalogByTaxonomy(items) {
  const buckets = new Map();
  const extras = [];

  for (const item of items || []) {
    const section = String(item?.section || "TV");
    const category = String(item?.group || "Outros");
    const key = section + "\u0000" + category;

    if (!TAXONOMY[section]?.includes(category)) {
      extras.push(item);
      continue;
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  }

  const ordered = [];
  for (const section of TAXONOMY_SECTIONS) {
    for (const category of TAXONOMY[section]) {
      const bucket = buckets.get(section + "\u0000" + category);
      if (bucket) ordered.push(...bucket);
    }
  }

  ordered.push(...extras);
  return ordered;
}

export function summarizeTaxonomy(items) {
  const counts = new Map();

  for (const item of items || []) {
    const section = String(item?.section || "TV");
    const category = String(item?.group || "Outros");
    const key = section + "\u0000" + category;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const sections = {};
  let otherItems = 0;

  for (const section of TAXONOMY_SECTIONS) {
    const categories = {};
    let total = 0;

    for (const category of TAXONOMY[section]) {
      const count = counts.get(section + "\u0000" + category) || 0;
      if (count) categories[category] = count;
      total += count;
      if (category === "Outros") otherItems += count;
    }

    sections[section] = { total, categories };
  }

  return {
    total: Array.isArray(items) ? items.length : 0,
    other_items: otherItems,
    sections
  };
}
