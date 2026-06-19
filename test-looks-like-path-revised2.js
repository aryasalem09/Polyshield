import { isAbsolute } from 'node:path';

const PATHISH_KEY = /(^|_|-)(path|file|filepath|dir|directory|cwd|target|dest|destination|src|source|location|output|input)s?$/i;

function looksLikePath(key, value) {
  if (typeof value !== "string" || !value) return false;
  if (PATHISH_KEY.test(key)) return true;
  if (value.includes("..")) return true;
  if (isAbsolute(value)) return true;
  if (/^[.~][/\\]/.test(value)) return true; // ./  ../  ~/

  // A string with a slash is likely a path if it's not too long and doesn't contain spaces or newlines
  if (value.length < 256 && !value.includes('\n') && /^[^:\s]+[/\\][^:\s]+/.test(value)) return true;

  return false;
}

console.log(looksLikePath("arg", "link/secret.txt")); // true
console.log(looksLikePath("arg", "01/01/2024")); // false because it's a date... wait, test it
console.log(looksLikePath("arg", "http://example.com/foo")); // false because of :
console.log(looksLikePath("arg", "Hello world\nthis/is a test")); // false
