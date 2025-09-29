# Repository Audit Report

Artifacts:
- report/content-duplicates.json (byte-identical groups)
- report/ast-duplicates.json (JS/CJS/MJS identical logic by AST)

Guidance:
- Content duplicates can be deleted or canonicalized.
- AST duplicates indicate scripts are functionally the same (safe to consolidate).
