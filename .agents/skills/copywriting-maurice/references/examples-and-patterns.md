# Examples And Patterns

Use these as style references, not as text to copy. They distill patterns from Maurice's operating-system repo and Spinup's current writing examples.

## Maurice Patterns

### Concrete timeline

Maurice often starts with a specific moment:

- "Yesterday evening I installed..."
- "By midnight..."
- "I spent months..."
- "Last week..."

Why it works: the post feels observed, not manufactured.

### Specific tool stack

Mention the actual tools when relevant:

- Claude Code
- OpenClaw
- Hermes
- OpenRouter
- Kimi
- MiniMax
- Bun
- Firecracker
- Hetzner only when discussing older examples or user-provided facts

Why it works: named tools make the post credible.

### Three-example pain list

Use three concrete examples instead of one generic complaint.

Pattern:

```
The problem was not "agent setup is hard."

It was:

- where do I paste the API key?
- why does this need a browser session?
- what happens to the files after the run?
```

### Understated pivot

Pattern:

```
The first version worked.

That was not the problem.

The problem was that every useful agent workflow kept asking for the same thing:
a real environment.
```

## Spinup Patterns

### Workload before category

Good:

```
Your agent needs somewhere to live.

Not metaphorically. Literally: files, packages, a browser session, secrets, and state it can come back to.

That is the runtime layer.
```

Weak:

```
Spinup is a cloud agent runtime platform that revolutionizes agent infrastructure.
```

### Distinction without defensiveness

Good:

```
Sandbox APIs solve part of this.

But once the agent has a long-lived identity, the environment needs controls around state, secrets, snapshots, and harness choice.
```

### Harness portability in plain English

Good:

```
You should be able to try Claude Code today and Hermes tomorrow without rebuilding the whole setup around either one.

Spinup calls that harness portability.
```

## Example LinkedIn Draft Shape

```
The model API is the easy part.

That sounds wrong until you watch an agent do real work.

Suddenly it needs:

- files that survive the run
- packages it can install
- browser sessions
- secrets
- a place to put artifacts

At that point you are not just choosing a model.
You are choosing where the agent lives.

That is the part we're building Spinup around:
one isolated environment per agent, with the harness as something you can swap, not something that owns the whole setup.

The runtime boundary is becoming part of the product.
```

## Example X Thread Shape

```
1/ the model api is the easy part

2/ real agents need somewhere to live:
files
packages
browser state
secrets
logs
artifacts

3/ once those things matter, "just run it in a sandbox" gets too vague

you need lifecycle, state, controls, and a way to switch the tool inside

4/ that's the layer we're building with Spinup

one agent
one environment
swappable harnesses
```

## Example Blog Lead Shape

```
Most agent projects start with a model call.

Then the workload grows. The agent needs to read files, install packages, open a browser, hold onto state, and use secrets without turning the whole setup into a pile of worker glue.

That is where the runtime question starts.
```

## Red Flags

Rewrite if the draft:

- Reads like a company page instead of Maurice.
- Sounds like generic AI thought leadership.
- Starts with "In today's fast-paced..."
- Claims Spinup already has proof it has not earned.
- Uses "seamless," "robust," "revolutionary," or "enterprise-grade."
- Uses an em dash.
- Relies on "X isn't just Y. It's Z."
