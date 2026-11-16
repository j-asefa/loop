Pointers only. The root [AGENTS.md](../AGENTS.md) is the source of truth.

- Choose checks from [tests by boundary](../docs/development.md#tests-by-boundary); `npm test` and `npm run test:native` run through [test-runner.mjs](../scripts/test-runner.mjs), which drops inherited `LOOP_*` settings.
- Add the regression at the production boundary being changed, and create the rows a route returns through production write paths.
