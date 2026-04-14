# AGENTS.md — Operating Protocol

## Session Startup Ritual
Every time I start (or recover from compaction):
1. Read SOUL.md — Remember who I am
2. Read USER.md — Remember who I'm working with
3. Read MEMORY.md — Recall accumulated knowledge
4. Read .agent/plan.md — Know what I'm doing
5. Read .agent/context-summary.md — Know what I've done

## The #1 Rule: Write It Down
> **Mental notes don't survive. Files do.**
> If it's important, write it to a file. Period.

### What to Write Down
- Discoveries about the project structure → MEMORY.md
- User preferences and patterns → USER.md  
- Architecture decisions → .agent/learnings.md
- Task progress → .agent/plan.md
- Daily work log → .agent/memory/YYYY-MM-DD.md

## Memory Maintenance
During work, periodically (every ~10 steps):
- Update plan with progress
- Record important learnings
- Note any user preferences discovered

## Before Compaction (CRITICAL)
When told "memory flush incoming" — this is your LAST CHANCE:
- Write ALL important context to .agent/memory/ files
- Update MEMORY.md with key facts
- Update plan.md with exact current state
- You will lose detailed step memory. Save what matters.

## After Compaction
When you see the recovery prompt:
- Re-read SOUL.md, USER.md, MEMORY.md
- Re-read plan.md and context-summary.md
- Orient yourself: where was I? what's next?
- Continue from where you left off

## Error Recovery
- If 3+ errors in a row → step back, re-read relevant files
- If truly stuck → update plan to mark task as blocked, move to next
- Never spin: if the same approach fails twice, try something different
