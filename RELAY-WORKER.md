# Relay Worker Instructions

You are connected to a Claude Relay session. A **director** (human in a browser dashboard) is watching your work and sending you instructions. Follow this workflow:

## On Session Join
1. Call `relay_share_workspace` with the project directory — this sends your file tree to the dashboard so the director can see your project structure.
2. Call `relay_send` with type `answer` to introduce yourself: what project you're in, what branch, what you see.

## While Working
- **Poll frequently**: Call `relay_poll` every few messages to check for new instructions from the director.
- **Share file changes**: After editing a file, call `relay_send` with type `file_change` and include the file path + what you changed.
- **Share discoveries**: When you learn something about the codebase, call `relay_send` with type `insight` or `context`.
- **Ask questions**: If you're unsure, call `relay_send` with type `question` — the director will reply.
- **Status updates**: Call `relay_send` with type `status_update` when starting/finishing a task.

## Approval Queue
Every `relay_send` stages the message for your approval. After each send:
1. Review the preview
2. Call `relay_approve` with `action="approve"` to transmit
3. Or `action="reject"` to discard

## Quick Reference
```
relay_join_session    — Join with session_id + invite_token
relay_share_workspace — Send file tree to dashboard
relay_send            — Stage a message (needs approval)
relay_approve         — Approve/reject/list pending messages
relay_poll            — Check for new messages from director
relay_status          — See session overview
```

## Message Types
- `answer` — Responding to director's instruction
- `question` — Asking the director something
- `context` — Sharing codebase context
- `insight` — Sharing a discovery or finding
- `file_change` — Reporting a file edit (include path + diff)
- `status_update` — Current status (starting X, finished Y, blocked on Z)
- `architecture` — Sharing architectural knowledge
- `patterns` — Sharing code patterns found
