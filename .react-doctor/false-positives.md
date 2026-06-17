# React Doctor false positives

Occurrences confirmed not-a-bug after review. The triage loop drops diagnostics matching these.

## react-doctor/no-adjust-state-on-prop-change

- `packages/video/src/remotion/journey/shader-layer.tsx` — `setError(...)` inside the WebGL render effect.
  This is an imperative-failure REPORT from GL setup (bloom framebuffer/helper-shader build failed),
  not state synced to a prop. The composition renders the error string INTO the frame so a broken
  render is visible rather than silently wrong — surfacing it via state is intentional, and the
  rule's "derive validity from props" fixes don't apply to one-shot imperative GL failures.

## react-doctor/exhaustive-deps

- `apps/web/src/components/copy-button.tsx` — `useEffect(() => () => clearTimeout(copyResetTimeout.current), [])`.
  The idiomatic "clear the pending timeout on unmount" pattern. Reading `ref.current` at unmount is
  INTENDED (clear whichever timeout is latest), and the timeout is set in `copyText`, not the effect,
  so there is nothing to capture in the effect body. No staleness bug.
- `packages/video/src/remotion/journey/shader-layer.tsx` — the per-frame render effect omits
  `ensureBundle` (already carries a justified `// eslint-disable-next-line react-hooks/exhaustive-deps`).
  The effect re-runs every frame via the `frame` dep, so the closure is refreshed each frame and
  `ensureBundle` can never be stale; listing it would not change behavior.

## react-doctor/no-pass-live-state-to-parent

- `apps/web/src/routes/admin/index.tsx` — the IntersectionObserver infinite-scroll effect calls
  react-query's `fetchNextPage()`, not a parent-notify callback. `AdminBoardPage` is the route root
  (no parent), and `fetchNextPage` is a stable query action, not lifted local state.
