---
allowed-tools: Bash(gh issue view:*)
description: Quick-process a simple github ticket — no agents, inline proposal
argument-hint: <issue number or #number> e.g. #1174 or 1174 @file/path.ts
---

Using Github CLI, fetch issue from $ARGUMENTS (format: `#1174` or `1174 @file/path.ts`).

If a file path is provided with `@`, read that file first to establish context.

Then proceed **inline** (no subagents):

1. Fetch: `gh issue view <number> --json title,body,labels,comments`
2. Read relevant files directly using Read/Grep/Glob based on the issue description
3. Propose the fix with this structure:

## Problem
What the issue describes (1-2 sentences).

## Relevant code
Files identified and key lines.

## Proposed fix
Concrete code changes — show diffs or describe edits precisely.

## Verification
How to test the fix (specific commands or manual steps).

---

**Important constraints:**
- Do NOT use the Task tool or spawn any agents
- Do NOT use Explore, euler-solutions-agent, or any subagent
- Keep it fast — read only what's needed, propose directly
- If the issue is too complex for a quick inline fix (multi-system changes, architectural decisions, unclear scope), recommend using `/ticket-task` instead and stop
