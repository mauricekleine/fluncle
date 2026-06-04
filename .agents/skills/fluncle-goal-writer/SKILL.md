---
name: fluncle-goal-writer
description: "Draft compact, paste-ready Codex `/goal` prompts for Fluncle work. Use when the user asks to turn a Fluncle feature slice, implementation plan, PR follow-up, review comment, blocker, release task, or validation task into a durable `/goal` objective, especially when the prompt must stay under 4,000 characters and align with this repo's README, PRODUCT.md, and agent guidance."
---

# Fluncle Goal Writer

Use this skill to produce one paste-ready `/goal <objective>` prompt, not an implementation plan. The output should be a durable completion contract for another Codex agent: one coherent outcome, clear boundaries, evidence, verification, and stop conditions.

## Grounding

Read `README.md`, `PRODUCT.md`, and `.agents/skills/fluncle-operator/SKILL.md` first. Then read only the local references needed for the slice:

- `package.json` and `turbo.json` for root scripts and workspace shape
- `PRODUCT.md` before UI, product copy, or brand work
- `.agents/skills/fluncle-operator/references/cli-contract.md` for CLI behavior and JSON contracts
- `.agents/skills/fluncle-operator/references/raycast.md` for Raycast behavior and local binary assumptions
- `.agents/skills/fluncle-operator/references/vps-deploy.md` for VPS deployment and standalone binary tasks
- `apps/cli/src/` for CLI command behavior
- `apps/raycast/src/` for Raycast command behavior
- `apps/web/src/routes/api/` and `apps/web/src/lib/server/` for public/admin API behavior, Spotify, Telegram, and Turso flows
- relevant files, tests, PR notes, or proof artifacts named by the user

Use current Codex goal guidance as the model: a goal is for long-running work with a durable objective, validation loop, and explicit completion/blocker boundary. It is not a backlog dump, broad roadmap, or exploratory brainstorm.

## Workflow

1. Identify the single outcome.
   - If there are multiple independent outcomes, propose separate goals and pick the first only when the user asked for the prompt.
   - If the desired output is an RFC, doc, review, or brief, make that artifact the objective instead of implying implementation.

2. Decide whether to ask before drafting.
   - Ask only when scope, safety, product direction, paid infrastructure, production data, live deploys, or external sends cannot be inferred.
   - Otherwise make reasonable assumptions and keep them explicit inside the goal.

3. Draft in this exact shape:

```text
/goal <one-sentence objective>

Required reading:
- ...

Constraints/non-goals:
- ...

Acceptance criteria:
- ...

Verification:
- ...

Stop and ask:
- ...
```

4. Keep it compact.
   - Hard limit: 4,000 characters.
   - Aim for 2,400-3,400 characters so edits do not overflow.
   - Prefer file paths and commands over explanatory prose.
   - Refer to a local doc instead of embedding long background.
   - Remove analysis, rationale, and history from the final prompt unless it changes scope.

5. Validate before responding.
   - Save or pipe the draft through `scripts/check_goal_prompt.py`.
   - If it fails length or required-section checks, shorten and rerun.
   - Final output must be only the `/goal` prompt unless the user explicitly asked to write it to a file.

## Content Rules

- Start with `/goal`.
- Preserve Fluncle domain terms from the docs and code: track, Spotify, Telegram, Turso, public archive, admin API, CLI, Raycast, standalone binary, production profile, and local profile.
- Include exact paths, commands, PR numbers, and artifacts when known.
- Include one verifiable stopping condition.
- Do not invent credentials, production state, validation results, deploy permission, customer data, or secrets.
- Do not include a preamble like "Here is the prompt".
- Do not include private analysis in the final prompt; do that reasoning before final output.
- Do not exceed 4,000 characters.

## Validator

Run:

```sh
python packages/skills/goal-writer/scripts/check_goal_prompt.py /tmp/goal.txt
```

Or pipe:

```sh
printf '%s' "$GOAL_PROMPT" | python packages/skills/goal-writer/scripts/check_goal_prompt.py -
```
