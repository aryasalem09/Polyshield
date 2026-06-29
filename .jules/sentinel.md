## 2024-06-29 - [Fail Closed] Missing Constraint Rejection on Recursive Validations
**Vulnerability:** A silent bypass of scope enforcement via recursion limits in `assertPathArgsInScope` and `remapArgs`. When depth `> 8`, the checks were returning silently instead of throwing, allowing deeply nested path arguments to bypass path scoping restrictions.
**Learning:** Security checks that traverse arbitrary tree structures must fail closed. When hitting maximum depth/constraints in validation logic, do not silently exit as it effectively allows potentially dangerous input to proceed unvalidated.
**Prevention:** Ensure all constraint limits explicitly throw errors (fail closed) instead of silently exiting/returning in all traversal and validation routines.
