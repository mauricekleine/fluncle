---
name: copywriting-maurice
description: Write Spinup copy in Maurice Kleine's personal builder voice while preserving Spinup's current brand, terminology, product claims, and content strategy. Use when drafting or editing Spinup LinkedIn posts, X posts or threads, founder updates, build-in-public posts, product announcements, launch posts, technical explainers, SEO blog posts, article outlines, or blog drafts that should sound like Maurice and still fit Spinup's cloud agent runtime positioning.
---

# Copywriting Maurice

Use this skill to write Spinup content that sounds like Maurice: casual, direct, builder-first, internet-native, and concrete. Blend that personal voice with Spinup's current positioning as a cloud agent runtime for isolated, persistent agent environments.

## Source Priority

Use current Spinup repo context over older personal operating-system project notes when the two disagree. Maurice's operating-system repo contains useful voice patterns, but its older Spinup project profile described a previous product direction.

Priority order:

1. The user's current brief and facts.
2. Current Spinup repo context under `docs/seo/`, `docs/SEO.md`, `docs/VISION.md`, and recent product docs.
3. Maurice voice references in this skill.
4. Historical examples from Maurice's operating-system repo.

Never invent traction, customer counts, pricing, benchmarks, security guarantees, launch maturity, or public support status.

## Workflow

1. Identify the channel: LinkedIn, X, blog post, article outline, product announcement, or repurposed variants.
2. Load the relevant reference:
   - `references/maurice-voice.md` for Maurice's personal voice.
   - `references/spinup-brand-context.md` for Spinup terminology, proof rules, and positioning.
   - `references/platform-formats.md` for LinkedIn, X, and blog structure.
   - `references/examples-and-patterns.md` when matching existing Maurice or Spinup examples matters.
3. Extract the factual payload before writing: what shipped, what changed, what was learned, what proof exists, what the reader should do next.
4. Choose the angle:
   - Build-in-public: what happened inside the work.
   - Product insight: what the runtime problem taught us.
   - Category education: why agents need real environments.
   - Launch/update: what changed and who it helps.
   - Contrarian lesson: what common AI-agent assumption is wrong.
5. Draft in Maurice's voice first, then tighten against Spinup's brand rules.
6. Run the final checks below before returning content.

## Voice Blend

Maurice's voice should lead social content. Spinup's brand should govern terminology and claim discipline.

For LinkedIn and X:

- Write from inside the build process.
- Use first person when it is a founder post.
- Keep short paragraphs and visible whitespace.
- Prefer concrete facts, numbers, and examples.
- Use light humor only when it feels natural.
- End with an insight, genuine question, or soft next step.

For Spinup blog posts:

- Keep Maurice's directness and specificity, but reduce slang.
- Lead with the workload problem before the category term.
- Teach the reader through examples and tradeoffs.
- Use second person unless the piece is explicitly a founder essay.
- Include SEO structure only when the user asks for a blog or search-targeted article.

## Spinup Rules

Use these terms accurately:

- cloud agent runtime
- isolated agent environment
- persistent sandbox for AI agents
- harness
- harness portability
- control plane
- execution plane
- persistent state
- snapshots
- skills
- secrets
- network policy
- Firecracker

Bridge internal terms for cold audiences. Do not open a social post or cold blog lead with "harness portability" unless you first explain the plain-language outcome: switching the AI tool without rebuilding the environment.

Use safe current claims:

- Spinup is an API-first cloud agent runtime platform.
- Spinup is built around isolated, persistent agent environments.
- Spinup's product direction centers on harness portability, skills, secrets, network policy, and snapshots.
- The repo contains a control-plane foundation and a Firecracker-based provisioning path.
- Creating an agent currently auto-queues environment provisioning.

Avoid unsupported claims:

- Customer counts, revenue, or retention unless the user provides them.
- Reliability, restore-time, or cost benchmarks unless sourced.
- Security guarantees beyond architectural direction.
- Public pricing, plan names, or launch maturity not present in current repo context.

## Output Defaults

Unless the user specifies otherwise:

- LinkedIn: return one polished post, 700-1,200 characters, with optional alternate hooks.
- X: return a short post or 3-5 post thread, lowercase acceptable, no hashtags.
- Blog: return an outline first when the topic is broad; return a full draft when the user asks for one.
- Repurposing: preserve the same factual payload, but rewrite rhythm and density per channel.

When facts are missing, make a conservative assumption and label it as a placeholder instead of fabricating proof.

## Final Checks

Before returning copy, verify:

- It sounds like a builder talking to builders.
- The first two lines are concrete and not corporate.
- There are no em dashes.
- There is no "X isn't just Y. It's Z" structure.
- Claims match current Spinup maturity.
- Technical terms are introduced before being relied on.
- The content has at least one specific runtime detail when discussing Spinup.
- The ending does not sound like engagement bait unless the user asked for it.
