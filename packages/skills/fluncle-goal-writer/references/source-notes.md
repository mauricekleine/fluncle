# Source Notes

Use these notes only when updating the skill. Do not load them for ordinary goal writing unless the user asks why the skill is shaped this way.

## Local Source

- `README.md` is the local source of truth for repo layout, root workflows, environment surfaces, CLI commands, Raycast setup, web deployment, publishing behavior, and CLI releases.
- `PRODUCT.md` is the product and design source of truth for audience, purpose, brand personality, anti-references, design principles, and accessibility.
- `.agents/skills/fluncle-operator/SKILL.md` captures repo-specific operating rules for the Bun/Turborepo monorepo, CLI, Raycast extension, web app, Turso-backed publishing flow, and deployment surfaces.
- `.agents/skills/fluncle-operator/references/cli-contract.md`, `.agents/skills/fluncle-operator/references/raycast.md`, and `.agents/skills/fluncle-operator/references/vps-deploy.md` provide deeper Fluncle-specific workflow details.
- `packages/skills/goal-writer` is intentionally not part of the Bun workspace; it is a bundled agent skill, not a runtime package.

## Codex Goal Guidance

Current OpenAI Codex materials describe goals as durable objectives for long-running work. The relevant behavior to preserve in this skill:

- A goal is for work that may span turns, resumes, or long validation loops.
- A good goal states the outcome and stopping condition, not every execution step.
- Completion should be evidence-based.
- Boundaries matter: scope, non-goals, verification, and stop/ask conditions prevent aimless background autonomy.
- Use goals for coherent long-running work, not loose backlogs or exploratory planning.

References:

- `https://developers.openai.com/codex/use-cases`
- `https://developers.openai.com/codex/use-cases/follow-goals`
- `https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex`
