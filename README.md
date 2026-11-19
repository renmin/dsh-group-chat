# dsh-group-chat

Standalone plugin for captain/member chat orchestration on top of DSH chat:

- `/add-agent` adds a member agent (default model/provider inherits current captain selection)
- Non-mention messages route to captain as normal
- `@member-name` routes to that member and injects the member reply back into captain turn
- Shared transcript with per-agent cursors for bounded member backscroll
- Debug state endpoint: `GET /api/plugins/dsh-group-chat/state`
