// SPDX-License-Identifier: MIT

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlEncode(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return base64ToBytes(base64);
}

export function encodeConfig(config) {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(config)));
}

export function decodeConfig(token) {
  if (!token || token.length > 16384) throw new Error("invalid token");
  const value = JSON.parse(new TextDecoder().decode(base64urlDecode(token)));

  if (!value || !Array.isArray(value.v) || value.v.length < 1 || value.v.length > 16) {
    throw new Error("invalid config");
  }

  for (const variant of value.v) {
    if (!variant || typeof variant.u !== "string" || !/^https?:\/\//i.test(variant.u)) {
      throw new Error("invalid variant");
    }
  }
  return value;
}

export function stateName(token) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return "channel-" + (hash >>> 0).toString(16).padStart(8, "0");
}
