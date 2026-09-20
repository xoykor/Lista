// SPDX-License-Identifier: MIT

/*
 * Taxonomia canônica.
 *
 * Regra central: só classificar quando houver evidência no upstream, no nome
 * explicitamente prefixado ou numa fonte auxiliar confiável. Em caso de
 * conflito, o chamador deixa em "Outros".
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
    "Mistério", "Romance", "Suspense", "Terror", "Faroeste",
    "Lançamentos", "Nacional", "Clássicos", "Infantil", "Religiosos",
    "Shows", "Outros"
  ]),
  Séries: Object.freeze([
    "Netflix", "Prime Video", "Disney+", "Max", "Apple TV+", "Paramount+",
    "Globoplay", "Crunchyroll", "Star+", "Discovery+", "Hulu", "Peacock",
    "Starz", "MGM+", "AMC+", "Universal+",
    "Anime", "Doramas", "Novelas",
    "Ação", "Aventura", "Animação", "Comédia", "Crime", "Documentário",
    "Drama", "Família", "Fantasia", "Ficção Científica", "Mistério",
    "Romance", "Suspense", "Terror", "Outros"
  ])
});

export const TAXONOMY_SECTIONS = Object.freeze(["TV", "Filmes", "Séries"]);

export const SERIES_PROVIDER_CATEGORIES = Object.freeze(new Set([
  "Netflix", "Prime Video", "Disney+", "Max", "Apple TV+", "Paramount+",
  "Globoplay", "Crunchyroll", "Star+", "Discovery+", "Hulu", "Peacock",
  "Starz", "MGM+", "AMC+", "Universal+"
]));

export const SERIES_SPECIAL_CATEGORIES = Object.freeze(new Set([
  "Anime", "Doramas", "Novelas"
]));

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

const MOVIE_RULES = [
  ["Ficção Científica", [
    "ficcao cientifica", "ficcao cientifica e fantasia", "science fiction",
    "sci fi", "scifi"
  ]],
  ["Ação", ["acao", "action", "acao e aventura"]],
  ["Aventura", ["aventura", "adventure"]],
  ["Animação", ["animacao", "animation", "animated", "desenhos", "desenho"]],
  ["Comédia", ["comedia", "comedy", "humor"]],
  ["Crime", ["crime", "criminal", "policial"]],
  ["Documentário", [
    "documentario", "documentarios", "documentary", "documentaries", "docs",
    "biografia documental"
  ]],
  ["Drama", ["drama"]],
  ["Família", ["familia", "family"]],
  ["Fantasia", ["fantasia", "fantasy"]],
  ["Guerra", ["guerra", "war"]],
  ["Mistério", ["misterio", "mystery"]],
  ["Romance", ["romance", "romantico", "romantica"]],
  ["Suspense", ["suspense", "thriller"]],
  ["Terror", ["terror", "horror"]],
  ["Faroeste", ["faroeste", "western", "velho oeste"]],
  ["Lançamentos", [
    "lancamentos", "lancamento", "novidades", "estreias", "estreia",
    "recem adicionados", "recentes"
  ]],
  ["Nacional", [
    "nacional", "nacionais", "brasileiro", "brasileiros", "brasil",
    "cinema brasileiro"
  ]],
  ["Clássicos", ["classicos", "classico", "classic", "classics"]],
  ["Infantil", ["infantil", "kids", "criancas", "crianca"]],
  ["Religiosos", ["religioso", "religiosos", "gospel", "cristao", "cristaos"]],
  ["Shows", ["shows", "show", "concertos", "concerto", "concert", "musicais"]]
];

const SERIES_PROVIDERS = [
  ["Netflix", ["netflix", "netflix originals", "netflix original"]],
  ["Prime Video", [
    "prime video", "amazon prime", "amazon prime video",
    "amazon originals", "amazon original", "prime originals", "prime original"
  ]],
  ["Disney+", ["disney plus", "disneyplus", "disney originals", "disney original"]],
  ["Max", [
    "hbo max", "max originals", "max original", "max series", "hbo originals",
    "hbo original", "hbo series"
  ]],
  ["Apple TV+", [
    "apple tv plus", "apple tv", "apple originals", "apple original"
  ]],
  ["Paramount+", [
    "paramount plus", "paramountplus", "paramount originals",
    "paramount original"
  ]],
  ["Globoplay", ["globoplay", "globo play", "globoplay originals", "globoplay original"]],
  ["Crunchyroll", ["crunchyroll"]],
  ["Star+", ["star plus", "starplus"]],
  ["Discovery+", ["discovery plus", "discoveryplus"]],
  ["Hulu", ["hulu"]],
  ["Peacock", ["peacock", "peacock tv"]],
  ["Starz", ["starz"]],
  ["MGM+", ["mgm plus", "mgmplus", "epix"]],
  ["AMC+", ["amc plus", "amcplus"]],
  ["Universal+", ["universal plus", "universalplus"]]
];

const SERIES_SPECIAL = [
  ["Anime", ["anime", "animes"]],
  ["Doramas", [
    "dorama", "doramas", "k drama", "k dramas", "kdrama", "kdramas",
    "korean drama", "drama coreano", "dramas coreanos"
  ]],
  ["Novelas", ["novela", "novelas", "telenovela", "telenovelas"]]
];

const TV_RULES = [
  ["Abertos", [
    "abertos", "aberto", "tv aberta", "tv abertas",
    "globo", "sbt", "record tv", "recordtv", "band", "redetv", "rede tv",
    "tv brasil", "tv cultura", "gazeta"
  ]],
  ["Esportes", [
    "esportes", "esporte", "sports", "sport", "futebol", "football", "soccer",
    "espn", "sportv", "sport tv", "premiere", "bandsports", "band sports",
    "combate", "ufc", "nba", "nfl", "nosso futebol", "caze tv", "cazetv",
    "goat", "xsports", "n sports", "nsports", "fuel tv", "tnt sports",
    "paramount plus jogo", "disney plus jogo", "prime video jogo"
  ]],
  ["Notícias", [
    "noticias", "noticia", "news", "jornalismo", "jornal", "cnn brasil",
    "cnn", "globonews", "bandnews", "band news", "record news",
    "jovem pan news", "jp news", "times brasil", "bbc news", "bloomberg",
    "cnbc", "euronews", "france 24", "al jazeera"
  ]],
  ["Infantil", [
    "infantil", "kids", "criancas", "crianca", "cartoon network", "cartoonito",
    "tooncast", "boomerang", "nickelodeon", "nick jr", "nick junior",
    "discovery kids", "disney channel", "disney junior", "gloob", "gloobinho",
    "baby tv", "babytv"
  ]],
  ["Documentários", [
    "documentarios", "documentario", "documentary", "discovery channel",
    "discovery science", "discovery civilization", "history", "history 2",
    "h2", "animal planet", "nat geo", "natgeo", "national geographic",
    "smithsonian"
  ]],
  ["Música", [
    "musica", "music", "musical", "mtv live", "mtv hits", "trace",
    "music box", "vevo"
  ]],
  ["Religiosos", [
    "religiosos", "religioso", "religiao", "gospel", "catolico", "catolica",
    "igreja", "cancao nova", "canção nova", "rede vida", "tv aparecida",
    "novo tempo", "rit tv"
  ]],
  ["Educativo", [
    "educativo", "educacao", "educational", "escola", "futura",
    "tv escola", "univesp"
  ]],
  ["Internacional", [
    "internacional", "international", "world", "exterior", "latino",
    "latinos", "espanha", "portugal", "italia", "franca", "france",
    "alemao", "alemanha"
  ]],
  ["Regionais", [
    "regionais", "regional", "locais", "local", "afiliadas", "afiliada",
    "globos norte", "globos nordeste", "globos sul", "globos sudeste",
    "sbt regionais", "record regionais"
  ]],
  ["Variedades", [
    "variedades", "variety", "lifestyle", "gnt", "tlc", "food network",
    "home health", "travel box", "fashion tv"
  ]],
  ["Entretenimento", [
    "entretenimento", "entertainment", "filmes e series", "filmes series",
    "telecine", "hbo", "cinemax", "warner", "tnt", "space", "amc",
    "sony channel", "sony", "universal tv", "studio universal", "axn",
    "fx", "star channel", "paramount network", "comedy central",
    "megapix", "cinemonde", "darkflix", "tcm"
  ]]
];

function match(text, rules) {
  for (const [canonical, aliases] of rules) {
    if (any(text, aliases)) return canonical;
  }
  return "";
}

function providerFromExplicitName(value) {
  const text = normalizeTaxonomyText(value);
  if (!text) return "";

  for (const [provider, aliases] of SERIES_PROVIDERS) {
    for (const alias of aliases) {
      if (
        text === alias ||
        text.startsWith(alias + " ") &&
          /^(?:netflix|prime video|amazon prime|amazon prime video|disney plus|hbo max|max originals|max original|max series|apple tv plus|apple tv|paramount plus|globoplay|crunchyroll|star plus|discovery plus|hulu|peacock|starz|mgm plus|amc plus|universal plus)\b/.test(text)
      ) {
        return provider;
      }
    }
  }

  return "";
}

export function hasEpisodeSyntax(value) {
  const text = String(value || "");
  return (
    /(?:^|[^A-Za-z0-9])[ST]\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}(?:[^A-Za-z0-9]|$)/i.test(text) ||
    /(?:^|[^A-Za-z0-9])\d{1,3}\s*[xX]\s*\d{1,4}(?:[^A-Za-z0-9]|$)/.test(text) ||
    /(?:^|[^A-Za-z0-9])T\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}(?:[^A-Za-z0-9]|$)/i.test(text) ||
    /(?:temporada|temp)\s*\d{1,3}.*(?:episodio|episódio|ep)\s*\d{1,4}/i.test(text)
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

function sourceGroup(item) {
  return normalizeTaxonomyText(item?.rawGroup || item?.group);
}

export function classifyTaxonomy(item) {
  if (item?.sectionHint && TAXONOMY[item.sectionHint]) {
    const section = item.sectionHint;
    const supplied = String(item.categoryHint || "").trim();
    if (supplied && TAXONOMY[section].includes(supplied)) {
      return { section, category: supplied };
    }

    const group = sourceGroup(item);
    if (section === "TV") {
      const joined = group + " " + normalizeTaxonomyText(item.name);
      return { section, category: match(joined, TV_RULES) || "Outros" };
    }
    if (section === "Filmes") {
      return { section, category: match(group, MOVIE_RULES) || "Outros" };
    }

    return {
      section,
      category:
        match(group, SERIES_PROVIDERS) ||
        providerFromExplicitName(item.name) ||
        match(group, SERIES_SPECIAL) ||
        match(group, MOVIE_RULES) ||
        "Outros"
    };
  }

  const group = sourceGroup(item);
  const name = String(item?.name || "");
  const kind = String(item?.kindHint || "");
  const urlHint = urlSectionHint(item);

  const seriesSignal =
    hasEpisodeSyntax(name) ||
    urlHint === "Séries" ||
    any(group, [
      "series", "serie", "seriados", "seriado", "temporada",
      "anime", "animes", "dorama", "doramas", "novela", "novelas"
    ]);
  const movieSignal =
    urlHint === "Filmes" ||
    any(group, ["filmes", "filme", "movies", "movie", "cinema", "vod"]);
  const mixedEntertainment = any(group, [
    "filmes e series", "filme e serie", "filmes series", "movies and series"
  ]);

  let section = "";

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
    return { section, category: match(group, MOVIE_RULES) || "Outros" };
  }

  return {
    section,
    category:
      match(group, SERIES_PROVIDERS) ||
      providerFromExplicitName(name) ||
      match(group, SERIES_SPECIAL) ||
      match(group, MOVIE_RULES) ||
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

  for (const section of TAXONOMY_SECTIONS) {
    for (const category of TAXONOMY[section]) {
      if (category === "Outros") continue;
      for (const item of buckets.get(section + "\u0000" + category) || []) out.push(item);
    }
  }

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
    sections[section].categories[category] =
      (sections[section].categories[category] || 0) + 1;
    if (category === "Outros") otherItems += 1;
  }

  return { total: items?.length || 0, other_items: otherItems, sections };
}
