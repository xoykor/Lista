// SPDX-License-Identifier: MIT

export function normalizeName(value) {
  let text = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return text
    .replace(/\b(?:uhd|fhd|hd|sd|4k|hq|1080p|720p|480p)\b/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
