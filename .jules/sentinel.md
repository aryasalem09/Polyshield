## 2025-06-20 - [Path Traversal Sandbox Bypass via Max Depth Limit]
**Vulnerability:** A path traversal bypass was discovered where malicious path arguments (e.g. `../../../etc/passwd`) could be passed to local tools because the security checks `assertPathArgsInScope` and `remapArgs` silently returned when an argument depth limit (> 8 levels) was reached.
**Learning:** Security validation functions must fail closed. When traversing arbitrarily nested structures, reaching a recursion/iteration limit and simply aborting or returning silently allows deeper nested properties to bypass the check entirely.
**Prevention:** When enforcing validation or traversal limits on untrusted data structures, always throw an error if the limit is exceeded, enforcing a secure default.
