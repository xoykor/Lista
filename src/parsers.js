// SPDX-License-Identifier: MIT

function attribute(line, name) {
  const match = line.match(new RegExp(name + '="([^"]*)"', "i"));
  return match ? match[1] : "";
}

export function parseExtinf(line) {
  const comma = line.lastIndexOf(",");
  const title = comma >= 0 ? line.slice(comma + 1).trim() : "";
  return {
    name: attribute(line, "tvg-name") || attribute(line, "tvg-id") || title,
    title,
    logo: attribute(line, "tvg-logo"),
    group: attribute(line, "group-title")
  };
}

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return { lines: lines.slice(0, -1), tail: lines.at(-1) || "" };
}

export async function parseM3UResponse(response, source, onItem) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending = null;
  let referer = "";
  let userAgent = "";
  let count = 0;

  async function consume(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      referer = "";
      userAgent = "";
      return;
    }
    if (line.startsWith("#EXTVLCOPT:http-referrer=")) {
      referer = line.slice("#EXTVLCOPT:http-referrer=".length).trim();
      return;
    }
    if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
      userAgent = line.slice("#EXTVLCOPT:http-user-agent=".length).trim();
      return;
    }
    if (line.startsWith("#")) return;

    if (pending && /^https?:\/\//i.test(line)) {
      const name = pending.name || pending.title;
      if (name) {
        await onItem({
          name,
          logo: pending.logo,
          group: pending.group,
          variants: [{
            url: line,
            referer: referer || null,
            userAgent: userAgent || null,
            origin: source.id
          }]
        });
        count += 1;
      }
    }

    pending = null;
    referer = "";
    userAgent = "";
  }

  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    const split = splitLines(buffer);
    buffer = split.tail;
    for (const line of split.lines) await consume(line);
  }

  buffer += decoder.decode();
  if (buffer) await consume(buffer);
  return count;
}

export function parseSaimoCatalog(text, source) {
  const items = [];
  let item = null;
  let variant = null;

  function flush() {
    if (item && item.name && item.variants.length) items.push(item);
    item = null;
    variant = null;
  }

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("canal:")) {
      flush();
      item = { name: line.slice(6).trim(), logo: "", group: "", variants: [] };
      continue;
    }
    if (!item) continue;

    if (line.startsWith("logo:")) {
      item.logo = line.slice(5).trim();
      continue;
    }
    if (line.startsWith("categoria:")) {
      item.group = line.slice(10).trim();
      continue;
    }
    if (line.startsWith("fonte:")) {
      variant = {
        url: line.slice(6).trim(),
        referer: null,
        userAgent: null,
        origin: source.id
      };
      if (/^https?:\/\//i.test(variant.url)) item.variants.push(variant);
      else variant = null;
      continue;
    }
    if (!variant) continue;

    if (line.startsWith("referer:")) {
      variant.referer = line.slice(8).trim() || null;
    } else if (line.startsWith("agente:")) {
      variant.userAgent = line.slice(7).trim() || null;
    } else if (line.startsWith("chave:")) {
      // A ClearKey line marks the preceding source as DRM-protected.
      // This service does not carry keys or bypass protected streams, so the
      // variant is removed while the channel's non-DRM fallbacks remain.
      const index = item.variants.indexOf(variant);
      if (index >= 0) item.variants.splice(index, 1);
      variant = null;
    }
  }

  flush();
  return items;
}
