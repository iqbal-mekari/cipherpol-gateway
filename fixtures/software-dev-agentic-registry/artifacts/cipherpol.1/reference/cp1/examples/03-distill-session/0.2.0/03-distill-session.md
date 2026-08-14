# Example: Distill a session into memories

After a coding session where you learned how a feature works:

**User:** /cp1-distill-session

**Claude asks for:**
- `slug` — e.g. `my-app`
- `session_id` — the current session ID

**Claude then:**
1. Fetches the raw session log via `get_session_log`
2. Extracts durable learnings (facts, gotchas, decisions, patterns, todos)
3. Stores each via `store_memory`
4. Reports: "Stored 5 memories: 2 facts, 1 gotcha, 1 pattern, 1 todo"

**Later, in a new session:**
```
recall_memory("my-app", "how does the payment flow work?")
```
Returns the stored memories ranked by relevance.
