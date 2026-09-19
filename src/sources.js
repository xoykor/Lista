// SPDX-License-Identifier: MIT

export const SOURCES = [
  { id: "saimo-catalogo", owner: "gabrielsaimo", repo: "SaimoPlayer", branch: "main", path: "catalogo.txt", format: "saimo-catalog", kind: "live", priority: 0 },
  { id: "pluto-br", provider: "pluto", region: "BR", format: "pluto-provider", kind: "live", priority: 5 },
  { id: "saimo-canais", owner: "gabrielsaimo", repo: "SaimoPlayer", branch: "main", path: "canais.txt", format: "m3u", kind: "live", priority: 10 },
  { id: "saimo-1", owner: "gabrielsaimo", repo: "SaimoPlayer", branch: "main", path: "1.m3u", format: "m3u", kind: "vod", priority: 10 },
  { id: "saimo-3", owner: "gabrielsaimo", repo: "SaimoPlayer", branch: "main", path: "3.m3u", format: "m3u", kind: "vod", priority: 11 },
  { id: "ramys-br01", owner: "Ramys", repo: "Iptv-Brasil-2026", branch: "master", path: "CanaisBR01.m3u8", format: "m3u", kind: "live", priority: 20 },
  { id: "ramys-br02", owner: "Ramys", repo: "Iptv-Brasil-2026", branch: "master", path: "CanaisBR02.m3u8", format: "m3u", kind: "live", priority: 21 },
  { id: "ramys-br03", owner: "Ramys", repo: "Iptv-Brasil-2026", branch: "master", path: "CanaisBR03.m3u8", format: "m3u", kind: "live", priority: 22 },
  { id: "ramys-br04", owner: "Ramys", repo: "Iptv-Brasil-2026", branch: "master", path: "CanaisBR04.m3u8", format: "m3u", kind: "live", priority: 23 },
  { id: "ramys-filmes-series", owner: "Ramys", repo: "Iptv-Brasil-2026", branch: "master", path: "Filmes-Series.m3u8", format: "m3u", kind: "vod", priority: 20 }
];

export function rawUrl(source) {
  if (!source.owner || !source.repo || !source.branch || !source.path) return null;
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return "https://raw.githubusercontent.com/" + source.owner + "/" + source.repo + "/" + source.branch + "/" + path;
}

export function githubContentsUrl(source) {
  if (!source.owner || !source.repo || !source.branch || !source.path) return null;
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return "https://api.github.com/repos/" + source.owner + "/" + source.repo + "/contents/" + path + "?ref=" + encodeURIComponent(source.branch);
}

export function sourcesFor(kind) {
  return SOURCES.filter((source) => source.kind === kind).sort((a, b) => a.priority - b.priority);
}
