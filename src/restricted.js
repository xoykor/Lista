// SPDX-License-Identifier: MIT

export function isRestrictedText(name = "", group = "") {
  const text = (String(name) + " " + String(group))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return /(?:\bxxx\b|\+18\b|\b18\+|onlyfans|only.?priva|porn|porno|erotic|erotico|\bsex(?:o)?\b|sex.?prive|sexy|hustler|playboy|\badult(?:o|a|os|as)\b|\badult\b(?!\s+swim))/i.test(text);
}
