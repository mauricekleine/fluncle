# Spinup Brand Context

Source basis: `packages/skills/copywriting-spinup/SKILL.md` (brand voice and style), `docs/seo/features.md`, `docs/seo/seo-guidelines.md`, `docs/seo/writing-examples.md`, and current repo docs.

## Current Positioning

Spinup is an API-first cloud agent runtime platform for running isolated, persistent agent environments behind a stable API.

The product thesis:

- An agent should be a long-lived runtime object.
- Each agent gets its own environment.
- Harnesses should be swappable.
- Skills, secrets, network policy, snapshots, and lifecycle controls belong to the agent model.
- Spinup sits above raw sandbox infrastructure and single-harness hosting.

## Narrative Order

For most content:

1. Start with the real workload problem.
2. Name the category: cloud agent runtime.
3. Explain Spinup's difference: isolated environments, harness portability, agent-level controls.
4. End with the lowest-friction next step.

For social posts, start even closer to the build:

1. What happened.
2. What it revealed.
3. Why that matters for agents.
4. How Spinup thinks about it.

## Voice Pillars

Spinup should sound:

- Technically concrete.
- Calm and high-signal.
- Category-shaping without buzzword inflation.
- Honest about current maturity.
- Reader-facing and action-oriented.
- Outcome-first before architecture in cold-entry content.

## Preferred Terms

Use:

- cloud agent runtime
- isolated agent environment
- persistent sandbox for AI agents
- secure code execution
- harness
- harness portability
- control plane
- execution plane
- runtime model
- persistent state
- snapshots
- skills
- secrets
- network policy
- Firecracker
- Amazon Linux 2023

Avoid:

- AI platform
- AI workspace
- always-on server
- safe AI
- framework when meaning harness
- dashboard when meaning control plane
- backend infrastructure when meaning execution plane
- workflow automation

## Cold-Audience Vocabulary Bridge

Do not force internal Spinup terms too early. Use plain-language outcomes first, then name the term.

Examples:

- "swap the AI tool without rebuilding the setup" before "harness portability"
- "an environment that keeps files between runs" before "persistent sandbox"
- "one controlled environment per agent" before "isolated agent environment"
- "the layer that owns the agent, environment, and controls" before "control plane"

## Safe Claims

Use these without additional proof:

- Spinup is an API-first cloud agent runtime platform.
- Spinup is built around isolated, persistent agent environments.
- The product direction centers on harness portability, skills, secrets, network policy, and snapshots.
- The repo contains the web app, API, auth, contracts, DB, and control-plane foundation.
- The repo includes a Firecracker-based provisioning path.
- Creating an agent currently auto-queues environment provisioning.
- The current guest baseline is Amazon Linux 2023.

## Claims to Avoid Without Source

Do not invent:

- Customer counts.
- Revenue.
- Public pricing.
- Reliability metrics.
- Restore-time benchmarks.
- Performance superiority.
- Security certifications.
- Migration speed.
- Production scale.
- Publicly supported integrations not confirmed by current docs.

## Core Messages

### Agents need real runtime environments

Many agent workloads need files, packages, browsers, tools, secrets, and state. Once that happens, the infrastructure question changes.

### Spinup sits above raw sandbox infrastructure

Sandbox APIs solve part of the problem. Spinup's wedge is the agent runtime control plane above the sandbox.

### Harnesses are swappable

Claude Code, Hermes, OpenClaw, and other harnesses should plug into the runtime. The environment and controls should not be rebuilt around each tool.

### Security is a runtime property

Talk about isolation, secrets projection, state containment, lifecycle controls, and network policy. Avoid vague "secure by default" claims.

## CTAs

Use low-friction, current-maturity CTAs:

- "join early access"
- "request access"
- "follow the build"
- "full write-up in the comments"
- "I'm writing more about this as we build"

Avoid hard enterprise-sales CTAs unless the user asks for sales copy.
