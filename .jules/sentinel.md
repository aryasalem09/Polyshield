## 2024-05-15 - Fail-Open Bypass in Object Tree Traversal
**Vulnerability:** The sandbox path checking (`assertPathArgsInScope`) and rewriting (`remapArgs`) functions silently returned (`return;` and `return value;`) when an object tree exceeded 8 levels of depth. This fail-open condition allowed deeply nested path arguments (e.g., `a.b.c.d.e.f.g.h.i.filepath = "../escape.txt"`) to bypass the scope limits entirely.
**Learning:** Security bounds checks that limit processing depth (like recursion limits) must fail securely. Silently returning from a check implies the check passed, meaning anything beyond the bound is unchecked and allowed.
**Prevention:** Always fail closed (throw an explicit error or return a safe rejection state) when resource bounds prevent a full security inspection.
