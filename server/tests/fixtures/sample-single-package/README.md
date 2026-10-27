# Stand-in single-package fixture

This is a **stand-in fixture**, not a real repo. It models the single-package
shape from the 2026-10-26 amendment: one TypeScript frontend package plus one
Python backend in a single repo, with feature/module directories instead of
workspace packages.

Hand-counted expectations (see `server/tests/extraction_fixture.rs`):

- Source files parsed: 9 (7 Python, 2 TypeScript)
- Import specifiers: 8
- Resolved: 6
- Unresolved: 2 — `fastapi` in `backend/app/modules/users/router.py` and
  `missing_module_xyz` in `backend/app/modules/users/repository.py`
- Feature/module islands include `backend/app/modules/users`,
  `backend/app/modules/orders`, `frontend/src/features/users`, and
  `frontend/src/features/orders`
