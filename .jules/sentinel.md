## 2024-05-18 - Path Traversal Bypass via Argument Tree Depth Limit
**Vulnerability:** A vulnerability was discovered in `src/sandbox.js` where deeply nested arguments could bypass the filesystem scope checks due to a silent return when the recursion depth limit (8) was exceeded.
**Learning:** Security checks that traverse arbitrary tree structures (like argument objects) must fail closed (explicitly throw errors) when constraints like recursion depth limits are exceeded, rather than returning silently.
**Prevention:** Always ensure that boundary checks fail securely and explicitly handle failure conditions. Avoid silent returns that could allow dangerous payloads to pass uninspected.
