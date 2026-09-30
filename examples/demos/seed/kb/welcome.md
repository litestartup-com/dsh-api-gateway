---
title: Welcome to the knowledge base
updated: 2026-09-30
---

# Welcome

This knowledge base powers two demos that share one DSH API node:

- **KB Studio** (this tree): manage the knowledge base — browse and edit files
  directly, or ask the AI steward (chat drawer) to draft, reorganize, and
  summarize notes. The steward works under a `workspace-write` sandbox pinned
  to this directory.
- **Support widget** (`/cs/`): a read-only support assistant that answers
  visitor questions strictly from `content/` — it can read this tree but can
  never modify it (`read-only` sandbox).

`content/docs/` is synced from the project repository (use **Refresh from
repo**); `content/notes/` is yours. Try asking the steward:

> Create a note summarizing the deployment options from the docs.
