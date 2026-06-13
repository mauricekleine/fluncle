---
target: /admin/posts
total_score: 25
p0_count: 0
p1_count: 2
slug: apps-web-src-routes-admin-posts-tsx
timestamp: 2026-06-13T05-13-18Z
---

## Critique — /admin/posts (admin social posting board)

### Design Health: 25/40 (Acceptable)

| #   | Heuristic                      | Score | Key issue                                      |
| --- | ------------------------------ | ----- | ---------------------------------------------- |
| 1   | Visibility of System Status    | 3     | spinners + chips + error banner                |
| 2   | Match System / Real World      | 3     | "Published…" label reads as status, not action |
| 3   | User Control & Freedom         | 3     | dialog escapable; no undo on push (low-stakes) |
| 4   | Consistency & Standards        | 2     | three button shapes in one cell                |
| 5   | Error Prevention               | 3     | push gated on video; publish requires URL      |
| 6   | Recognition Rather Than Recall | 2     | lone warning icon unlabeled-by-sight           |
| 7   | Flexibility & Efficiency       | 2     | no keyboard shortcuts, no batch push           |
| 8   | Aesthetic & Minimalist         | 2     | cell clutter + dead horizontal void            |
| 9   | Error Recovery                 | 3     | surfaces API messages                          |
| 10  | Help & Documentation           | 2     | cap note helps; affordances unexplained        |

### Anti-patterns verdict

Detector: 0 slop tells (clean markup). Failure is product strangeness, not AI-look: a cluttered invented affordance for a standard row action.

### Priority issues

- [P1] Action cell = wall of options (Re-push / "Published…" / lone warning icon stacked + wrapped; nothing primary; warning reads as error). Fix: status chip · one contextual primary button · single ⋯ overflow → status dialog.
- [P1] Dead horizontal whitespace (finding 1fr eats slack, platform cols shoved right). Fix: cap finding column, cluster platforms beside it.
- [P2] Gold "published" badge repeated down column over-spends One Sun gold. Fix: soft gold tint.
- [P2] Mixed button vocabulary in one cell. Fix: one shape per affordance.
- [P2] No row hover across a wide row. Fix: gold-veil row hover.

### Persona red flags

- Alex (power user): one-at-a-time push where 5/24h cap makes batch natural; no keyboard path.
- Sam (a11y): warning action is meaning-by-icon; chips carry text (good).

### Minor / follow-ups

- Batch select + push (respecting the cap) and keyboard nav are the next efficiency wins (deferred).
