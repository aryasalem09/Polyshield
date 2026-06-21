## 2024-05-24 - Fail-open Depth Limits in Recursive Validation
**Vulnerability:** The sandbox path enforcement (`assertPathArgsInScope`) bounded its recursive JSON argument traversal with a silent return `if (depth > 8) return;`. An attacker could bypass path scope validation by nesting path arguments 9 levels deep.
**Learning:** Security checks that traverse arbitrary tree structures must fail closed. Truncating the search space silently assumes the unchecked portion is benign, leading to bypasses.
**Prevention:** Always throw an error when a security recursion limit is exceeded, rather than returning silently.
