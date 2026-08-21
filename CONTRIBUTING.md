# Contributing

## Development checks

```bash
npm ci
npm audit
npm run all
```

Changes to `src/` must include corresponding tests and a rebuilt `dist/index.js`. Do not include live credentials or captured Issue content in fixtures.

## Security-sensitive changes

Provider authentication, subprocess environments, GitHub mutation, replay execution, command construction, and report-marker parsing are security boundaries. Contributions in these areas should include both a positive test and a denial/abuse test.

## Releases

Use semantic version tags. Keep the movable major tag aligned only after release verification succeeds. Security-sensitive consumers should pin the immutable commit SHA.
