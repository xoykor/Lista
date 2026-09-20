// SPDX-License-Identifier: MIT

/*
 * Taxonomia canônica da lista.
 *
 * A classificação nunca inventa metadados. Quando as duas fontes não oferecem
 * informação suficiente, o item cai em "Outros" em vez de ser colocado numa
 * categoria errada.
 */

export const TAXONOMY = Object.freeze({
  TV: Object.freeze([
    "Abertos", "Esportes", "Notícias", "Infantil", "Documentários",
    "Entretenimento", "Variedades", "Música", "Religiosos", "Educativo",
    "Internacional", "Regionais", "Outros"
  ]),
  Filmes: Object.freeze([
    "Ação", "Aventura", "Animação", "Comédia", "Crime", "Documentário",
    "Drama", "Família", "Fantasia", "Ficção Científica", "Guerra",
    "Mistério", "Romance", "Suspense", "Terror", "Faroeste", "Outros"
  ]),
  Séries: Object.freeze([
    "Netflix", "Prime Video", "Disney+", "Max", "Apple TV+", "Paramount+",
    "Globoplay", "Crunchyroll", "Star+", "Discovery+", "Anime", "Doramas",
    "Novelas", "Ação", "Aventura", "Animação", "Comédia", "Crime",
    "Documentário", "Drama", "Família", "Fantasia", "Ficção Científica",
    "Mistério", "Romance", "Suspense", "Terror", "Outros"
  ])
});

export const TAXONOMY_SECTIONS = Object.freeze(["TV", "Filmes", "Séries"]);

export function normalizeTaxonomyText(value) {
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

function phrase(text, value) {
  return (" " + text + " ").includes(" " + value + " ");
}

function any(text, values) {
  return values.some((value) => phrase(text, value));
}

const MOVIE_GENRES = [
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

const SERIES_PROVIDERS = [
  ["Netflix", ["netflix"]],
  ["Prime Video", ["prime video", "amazon prime", "amazon originals", "prime originals"]],
  ["Disney+", ["disney plus", "disneyplus"]],
  ["Max", ["hbo max", "max originals", "max original"]],
  ["Apple TV+", ["apple tv plus", "apple tv"]],
  ["Paramount+", ["paramount plus", "paramountplus"]],
  ["Globoplay", ["globoplay", "globo play"]],
  ["Crunchyroll", ["crunchyroll"]],
  ["Star+", ["star plus", "starplus"]],
  ["Discovery+", ["discovery plus", "discoveryplus"]]
];

const SERIES_SPECIAL = [
  ["Anime", ["anime", "animes"]],
  ["Doramas", ["dorama", "doramas", "k drama", "kdrama", "korean drama"]],
  ["Novelas", ["novela", "novelas", "telenovela", "telenovelas"]]
];

const TV_RULES = [
  ["Abertos", ["abertos", "aberto", "tv aberta", "tv abertas"]],
  ["Esportes", ["esportes", "esporte", "sports", "sport", "futebol", "football",
    "soccer", "espn", "sportv", "premiere", "bandsports", "combate", "ufc", "nba", "nfl"]],
  ["Notícias", ["noticias", "noticia", "news", "jornalismo", "jornal", "cnn",
    "globonews", "bandnews", "record news", "bbc news", "bloomberg", "cnbc"]],
  ["Infantil", ["infantil", "kids", "criancas", "crianca", "cartoon", "nickelodeon",
    "nick jr", "discovery kids", "disney junior", "gloob", "gloobinho"]],
  ["Documentários", ["documentarios", "documentario", "documentary", "discovery channel",
    "discovery science", "history", "animal planet", "nat geo", "national geographic"]],
  ["Música", ["musica", "music", "musical", "mtv", "bis"]],
  ["Religiosos", ["religiosos", "religioso", "religiao", "gospel", "catolico", "igreja"]],
  ["Educativo", ["educativo", "educacao", "educational", "escola"]],
  ["Internacional", ["internacional", "international", "world", "exterior"]],
  ["Regionais", ["regionais", "regional", "locais", "local"]],
  ["Variedades", ["variedades", "variety", "lifestyle"]],
  ["Entretenimento", ["entretenimento", "entertainment", "filmes e series", "telecine",
    "hbo", "cinemax", "warner", "amc", "sony channel", "universal tv"]]
];

function match(text, rules) {
  for (const [canonical, aliases] of rules) {
    if (any(text, aliases)) return canonical;
  }
  return "";
}

export function hasEpisodeSyntax(value) {
  const text = String(value || "");
  return (
    /(?:^|[^A-Za-z0-9])[ST]\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}(?:[^A-Za-z0-9]|$)/i.test(text) ||
    /(?:^|[^A-Za-z0-9])\d{1,3}\s*[xX]\s*\d{1,4}(?:[^A-Za-z0-9]|$)/.test(text) ||
    /(?:^|[^A-Za-z0-9])T\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}(?:[^A-Za-z0-9]|$)/i.test(text)
  );
}

function urlSectionHint(item) {
  let movie = false;
  for (const variant of item?.variants || []) {
    if (!variant?.url) continue;
    try {
      const path = new URL(variant.url).pathname.toLowerCase();
      if (/(?:^|\/)series(?:\/|$)/.test(path)) return "Séries";
      if (/(?:^|\/)(?:movie|movies|filme|filmes|vod)(?:\/|$)/.test(path)) movie = true;
    } catch {
      // URL inválida será descartada na sanitização.
    }
  }
  return movie ? "Filmes" : "";
}

export function classifyTaxonomy(item) {
  if (item?.sectionHint && TAXONOMY[item.sectionHint]) {
    const section = item.sectionHint;
    const supplied = String(item.categoryHint || "").trim();
    if (supplied && TAXONOMY[section].includes(supplied)) {
      return { section, category: supplied };
    }

    const group = normalizeTaxonomyText(item.group);
    if (section === "TV") return { section, category: match(group, TV_RULES) || "Outros" };
    if (section === "Filmes") return { section, category: match(group, MOVIE_GENRES) || "Outros" };

    return {
      section,
      category:
        match(group, SERIES_PROVIDERS) ||
        match(group, SERIES_SPECIAL) ||
        match(group, MOVIE_GENRES) ||
        "Outros"
    };
  }

  const group = normalizeTaxonomyText(item?.group);
  const name = String(item?.name || "");
  const kind = String(item?.kindHint || "");
  const urlHint = urlSectionHint(item);

  const seriesSignal =
    hasEpisodeSyntax(name) ||
    urlHint === "Séries" ||
    any(group, ["series", "serie", "seriados", "seriado", "temporada", "anime",
      "animes", "dorama", "doramas", "novela", "novelas"]);
  const movieSignal =
    urlHint === "Filmes" ||
    any(group, ["filmes", "filme", "movies", "movie", "cinema", "vod"]);
  const mixedEntertainment = any(group, [
    "filmes e series", "filme e serie", "filmes series", "movies and series"
  ]);

  let section = "";

  // Arquivos chamados "Canais" às vezes carregam VOD junto. A URL /series/
  // ou /movie/ e grupos inequívocos vencem o rótulo do arquivo. Já o grupo
  // ambíguo "Filmes e Séries" continua TV quando não há evidência na URL.
  if (kind === "live" && mixedEntertainment && !urlHint && !hasEpisodeSyntax(name)) {
    section = "TV";
  } else if (seriesSignal) {
    section = "Séries";
  } else if (movieSignal) {
    section = "Filmes";
  } else if (kind === "vod") {
    section = "Filmes";
  } else {
    section = "TV";
  }

  if (section === "TV") {
    const joined = group + " " + normalizeTaxonomyText(name);
    return { section, category: match(joined, TV_RULES) || "Outros" };
  }

  if (section === "Filmes") {
    return { section, category: match(group, MOVIE_GENRES) || "Outros" };
  }

  return {
    section,
    category:
      match(group, SERIES_PROVIDERS) ||
      match(group, SERIES_SPECIAL) ||
      match(group, MOVIE_GENRES) ||
      "Outros"
  };
}

export function canonicalizeItem(item) {
  const { section, category } = classifyTaxonomy(item);
  item.section = section;
  item.group = category;
  return item;
}

export function canonicalizeCatalogItems(items) {
  for (const item of items || []) canonicalizeItem(item);
  return { items: items || [], report: summarizeTaxonomy(items || []) };
}

export function canonicalGroupTitle(item) {
  const section = String(item?.section || "").trim();
  const category = String(item?.group || "").trim();
  return section && category ? section + " | " + category : (category || section);
}

export function orderCatalogByTaxonomy(items) {
  const buckets = new Map();
  const extras = [];

  for (const item of items || []) {
    const section = item.section || "TV";
    const category = item.group || "Outros";
    if (!TAXONOMY[section]?.includes(category)) {
      extras.push(item);
      continue;
    }
    const key = section + "\u0000" + category;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  const out = [];

  // Conteúdo classificado vem primeiro. Como o GitHub impõe 100 MiB por blob,
  // isso evita que centenas de milhares de "Outros" consumam o arquivo antes
  // de filmes e séries que já têm metadados úteis.
  for (const section of TAXONOMY_SECTIONS) {
    for (const category of TAXONOMY[section]) {
      if (category === "Outros") continue;
      for (const item of buckets.get(section + "\u0000" + category) || []) out.push(item);
    }
  }

  // Depois entram os itens sem classificação específica, ainda separados pela
  // seção correta.
  for (const section of TAXONOMY_SECTIONS) {
    for (const item of buckets.get(section + "\u0000Outros") || []) out.push(item);
  }

  for (const item of extras) out.push(item);
  return out;
}

export function summarizeTaxonomy(items) {
  const sections = {};
  let otherItems = 0;
  for (const section of TAXONOMY_SECTIONS) {
    sections[section] = { total: 0, categories: {} };
  }

  for (const item of items || []) {
    const section = item.section || "TV";
    const category = item.group || "Outros";
    if (!sections[section]) sections[section] = { total: 0, categories: {} };
    sections[section].total += 1;
    sections[section].categories[category] = (sections[section].categories[category] || 0) + 1;
    if (category === "Outros") otherItems += 1;
  }

  return { total: items?.length || 0, other_items: otherItems, sections };
}
