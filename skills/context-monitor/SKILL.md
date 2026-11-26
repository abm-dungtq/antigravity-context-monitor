---
name: context-monitor
description: Inspect live Antigravity context window usage, token breakdown, cache hit rate, and heavy skills/rules/MCP tools.
---

When the user asks about context usage, token breakdown, heavy skills/rules/MCP tools, or runs `/context-monitor`, call `open_context_monitor` once:
- Pass `conversationId` if known.
- Pass `workspacePath` from the active workspace directory when available.
- Keep your reply brief; the interactive Context Monitor UI shows the full breakdown.
