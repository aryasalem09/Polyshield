## 2024-05-24 - Initial Setup\n**Vulnerability:** None yet.\n**Learning:** Just starting.\n**Prevention:** None.

## 2024-05-24 - Sandbox Argument Traversal Fails Open
**Vulnerability:** Path and argument validation in the sandbox (`assertPathArgsInScope` and `remapArgs`) failed open. When validating arguments at a depth limit of 8, they would silently `return`, allowing arguments nested >8 levels deep to completely bypass sandbox validation logic while being passed unhindered to tools.
**Learning:** Security constraints that traverse arbitrarily nested user-provided structures (like JSON trees) must explicitly "fail closed" if they implement bounds checking like recursion depth limits.
**Prevention:** For any structure-traversing validation logic, ensure that reaching traversal limits immediately raises an error/exception to halt execution rather than silently aborting the validation.
