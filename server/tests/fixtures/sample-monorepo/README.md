# Stand-in fixture monorepo

This is a **stand-in fixture**, not the real demo repo. It exists only so the
T2 Oxc extraction spike has a small, hand-counted TypeScript monorepo to run
against until a real repo (GestiKo, via task T13) is covered. Every test and report that
uses it must label it a stand-in.

Hand-counted expectations (see `server/tests/extraction_fixture.rs`):

- Packages (islands): 4 — `@fixture/shared`, `@fixture/api`, `@fixture/web`, `@fixture/cli`
- Source files parsed: 12
- Import specifiers (static `import` + `export ... from`): 16
- Resolved: 14
- Unresolved: 2 — `./does-not-exist` and `@fixture/ghost`, both in `packages/api/src/broken.ts`
- Cross-island bridges: `api -> shared` 3, `web -> shared` 3, `cli -> shared` 1, `cli -> api` 1
- Dead file (no importers, not an entry point): `packages/shared/src/dead.ts`
- Route file (exposes endpoints): `packages/api/src/routes/users.ts`

Cross-package `@fixture/shared` imports resolve through the `paths` mapping
in the root `tsconfig.json`, which `oxc_resolver` discovers automatically.
There is deliberately no `node_modules/` in this fixture.
