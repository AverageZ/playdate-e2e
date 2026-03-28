---
allowed-tools: Bash(gh issue view:*), Bash(gh issue close:*), Bash(gh issue edit:*), Bash(gh issue create:*), Bash(gh issue comment:*), Bash(gh label list:*)
description: Triage stale github issues — close, update, or replace with better tickets
argument-hint: <issue number> e.g. 423
---

Fetch the issue via `gh issue view $ARGUMENTS --json title,body,labels,comments,createdAt,updatedAt,state`.

Then use the Explore agent (`subagent_type=Explore`) to determine:

- Has this issue already been addressed in the codebase?
- Is the feature/bug still relevant given the current architecture?
- What has changed since the issue was filed?

## Triage Outcomes

Based on exploration, recommend **one** of three outcomes:

### 1. Close

The issue is resolved, no longer relevant, or superseded by other work.

### 2. Update

The core idea is still valid but the details (description, acceptance criteria, labels) need refreshing to reflect the current codebase.

### 3. Replace

The scope has shifted enough that the original issue should be closed and one or more new focused tickets should replace it.

## Output Format

Fetch available labels via: `gh label list`

Present the recommendation with:

1. **Rationale** — why this outcome was chosen, referencing specific files or commits
2. **Ready-to-run `gh` commands** — exact commands for the recommended action

Do **not** execute any commands until the user explicitly approves.

### Close template

```bash
gh issue close $NUMBER --comment "Closing: [rationale]"
```

### Update template

```bash
gh issue edit $NUMBER --body "[updated body]"
gh issue edit $NUMBER --add-label "label1" --remove-label "label2"
```

### Replace template

```bash
gh issue close $NUMBER --comment "Replaced by #NEW1, #NEW2. [rationale]"
gh issue create --title "[Title]" --body "Replaces #$NUMBER\n\n[description]" --label "label1,label2"
```
