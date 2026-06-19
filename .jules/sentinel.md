## 2024-05-24 - File URL and Cross-Platform Path Traversal Bypass
**Vulnerability:** Path-scope enforcement could be bypassed by using `file://` URLs or providing cross-platform absolute paths (e.g. `C:\Windows\System32` on a POSIX runner).
**Learning:** `path.resolve` interprets `file:///etc/passwd` incorrectly (`/tmp/sandbox/file:/etc/passwd`), causing the path traversal check to falsely authorize it because it appears to be inside the base sandbox scope. `path.isAbsolute` does not recognize absolute paths for other operating systems.
**Prevention:** Always normalize paths across platforms using regex or platform-agnostic tools before making security decisions, and ensure URIs (like `file://`) are decoded via `fileURLToPath` before checking scope inclusion.
