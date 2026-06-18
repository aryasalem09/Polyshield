const PATHISH_KEY = /(^|_|-)(path|file|filepath|dir|directory|cwd|target|dest|destination|src|source|location|output|input)s?$/i;

function looksLikePath(key, value) {
  if (typeof value !== "string" || !value) return false;
  if (PATHISH_KEY.test(key)) return true;
  if (value.includes("..")) return true;
  // If it's short and contains a slash, but isn't a URL/date?
  // Let's refine the heuristics.
  if (value.length < 256 && (value.includes("/") || value.includes("\\"))) {
     // A short string with a slash might be a path. But wait, URLs have slashes.
     if (value.startsWith("http://") || value.startsWith("https://")) return false; // not a local path
     // If it's a date like 01/01/2024, it won't resolve to a real path usually, but checking it is cheap.
     return true;
  }
  return false;
}
console.log(looksLikePath("arg", "link/secret.txt")); // true
