# Platform Formats

Use this reference to adapt the same Spinup idea to LinkedIn, X, and blog posts.

## LinkedIn

Audience: founders, builders, engineers, tech professionals, potential early users.

Tone:

- Personal.
- Builder-first.
- Slightly more polished than X.
- Specific without becoming dense.
- Dry wit or self-deprecation is fine.

Default length: 700-1,200 characters unless the user asks otherwise.

Structure:

1. Standalone hook.
2. Short context.
3. Concrete example or pain list.
4. Lesson or Spinup angle.
5. Insight, question, or soft next step.

Good hooks:

- "We built the wrong product..."
- "The weird thing about agents is where they run."
- "Every agent demo eventually becomes an infrastructure demo."
- "The model API is the easy part."

Avoid:

- Hashtag stacks.
- "Agree?"
- Overly polished thought leadership.
- Pure memes without a lesson.
- Corporate launch phrasing.

## X

Audience: builders, indie hackers, developers, AI tinkerers.

Tone:

- More casual.
- Faster.
- More internet-native.
- Lowercase is acceptable.
- Memes are allowed when they do not hide the point.

Default formats:

- Single post: one strong thought, 1-5 short lines.
- Thread: 3-5 posts max, each with one job.

Single-post pattern:

```
the model api is the easy part

the hard part is giving the agent somewhere to live:
files, packages, secrets, browser state, memory
```

Thread pattern:

1. Hook: name the surprising truth.
2. Pain: list the concrete runtime requirements.
3. Distinction: sandbox primitive vs runtime control plane.
4. Spinup angle: what the product is building.
5. Soft closer: what you are testing or inviting feedback on.

Avoid:

- LinkedIn polish.
- Long paragraphs.
- Hashtags.
- Corporate announcement tone.

## Blog Posts

Audience: technical readers who need clarity, not hype.

Tone:

- Maurice's directness, with less slang.
- Spinup's technical precision.
- Outcome-first.
- Calm and explanatory.

Default structure:

```markdown
# Clear title

## Introduction

Name the real workload problem before naming the category.

## Why this problem exists

Use concrete examples: files, packages, browsers, secrets, state, long-running jobs.

## What the term means

Define the category or concept in plain English.

## Where Spinup fits

Explain isolated environments, harness portability, agent-level controls, and the control plane.

## Practical takeaway

End with a concrete next step or decision rule.
```

SEO blog requirements when requested:

- Target one primary keyword.
- Include 3-8 related terms naturally.
- Put the primary keyword in the H1, opening, at least one H2, conclusion, title, meta description, and slug.
- Include at least three internal link suggestions when natural.
- Avoid keyword stuffing.

## Repurposing Rules

When turning one idea into multiple channels:

- Keep the same factual payload.
- Change density, rhythm, and implied audience.
- Do not paste LinkedIn copy into X unchanged.
- Do not let X slang leak into a technical blog.
- Preserve claim discipline across every variant.

## Useful Endings

LinkedIn:

- "That's the part I'm paying attention to."
- "The model changed. The runtime problem stayed."
- "Curious where other teams are drawing this boundary."
- "Full write-up in the comments."

X:

- "runtime matters more than people think"
- "building toward this now"
- "agent infra is getting weird fast"

Blog:

- "The decision is not which model to call. It is what runtime boundary the agent gets."
- "If the agent needs files, tools, secrets, and state, treat the runtime as part of the product."
