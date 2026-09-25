# Agent setup

This is a deepsec scanning workspace. Each registered project has its
own setup prompt at `data/<id>/SETUP.md` — open the relevant one when
asked to set a project up.

## Common tasks

- **Set up a project for scanning**: read `data/<id>/SETUP.md` and
  follow it (read `node_modules/deepsec/SKILL.md`, then fill
  `data/<id>/INFO.md` from the target codebase).
- **Add a new project**: follow [Adding another project](./README.md#adding-another-project) to update the config and project context.
- **Write a custom matcher** (only after a real true-positive shows you
  a pattern worth keeping): read
  `node_modules/deepsec/dist/docs/writing-matchers.md`.

## Reference

The deepsec skill is at `node_modules/deepsec/SKILL.md` (after
`pnpm install`). The full docs ship at
`node_modules/deepsec/dist/docs/`.
