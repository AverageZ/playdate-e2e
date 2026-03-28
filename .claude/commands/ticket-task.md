---
allowed-tools: Bash(gh issue view:*)
description: Process an open github ticket
---

Using Github CLI, fetch issue from $ARGUMENTS (format: `#1174` or `1174 @file/path.ts`).

If a file path is provided with `@`, read that file first to establish context before exploring.

Then proceed with:

1. Explore agent (`subagent_type=Explore`) for codebase exploration and research
2. **(If needed)** Solutions agent (`subagent_type=euler-solutions-agent`) for concrete solutions — use when the problem is ambiguous, has multiple viable approaches, or requires trade-off analysis. Skip when the Explore agent already reveals a clear implementation path.
3. Propose the most pragmatic solution
4. Identify any tasks that should be deferred to separate issues and output GitHub-ready markdown

## Deferral Criteria

Tasks should be suggested for deferral when they:

- Expand beyond the original issue scope
- Represent separate concerns or features
- Are tech debt discovered during implementation
- Would significantly delay the main task

## Deferred Task Output Format

Fetch available labels via: `gh label list`

For each deferred task, output a ready-to-use block:

```
## Deferred Task: [Brief Title]

**Suggested Issue Title:** [Title for new issue]

**Body:**
Related to #PARENT_ISSUE_NUMBER

[Description of the task]

- [ ] Specific subtask 1
- [ ] Specific subtask 2

**Suggested Labels:** `ui`, `chore`, `enhancement`, `mechanism`, `bug`

**gh command:**
```bash
gh issue create --title "[Title]" --body "[Body]" --label "label1,label2"
```
```
