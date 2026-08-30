# Vendored skills

Third-party Claude Code skills, committed so every session on this repo gets
them without a per-machine install. They are reference material for agents —
markdown only, no scripts, no hooks.

| Source | [emilkowalski/skills](https://github.com/emilkowalski/skills) |
| --- | --- |
| Commit | `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7` |
| License | MIT — see `LICENSE`, © Emil Kowalski |

## What's here

Twelve skills for building interfaces. Nine trigger on their own when the work
matches; three are explicit-invoke only (`disable-model-invocation: true`) and
have to be typed as a slash command.

**Automatic**

- `animate` — build a web animation from scratch: curve, duration, properties, interrupts, exit
- `animate-expo` — the same, for React Native / Expo: gestures, sheets, haptics, off-thread motion
- `animation-vocabulary` — reverse lookup from "the bouncy thing when a popover opens" to the actual term
- `apple-design` — Apple's interface and motion principles, translated for the web
- `ask-sonner` — Sonner (toasts): setup, recipes, and the usual failure modes
- `emil-design-eng` — the umbrella philosophy skill: UI polish, component design, invisible details
- `find-animation-opportunities` — read-only sweep for what should animate, and what shouldn't
- `improve-animations` — read-only audit producing prioritized, self-contained plans
- `write-swift` — modern Swift: value types, Swift 6 concurrency, generics, Swift Testing

**Explicit only**

- `/pick-ui-library` — pick the right library instead of hand-rolling one
- `/prototype` — build several real variants of a UI piece behind a live picker
- `/review-animations` — strict review of existing motion; approval is earned

## Updating

    git clone --depth 1 https://github.com/emilkowalski/skills.git /tmp/emil-skills
    rm -rf .claude/skills/*/ && cp -r /tmp/emil-skills/skills/*/ .claude/skills/
    cp /tmp/emil-skills/LICENSE .claude/skills/LICENSE

Then update the commit hash in the table above.

## Note on .gitignore

`.claude/` is otherwise ignored (`.claude/*`), so local settings and session
state stay out of the repo. Only `.claude/skills/` is un-ignored.
