# Minimal bake-off: Tiptap collaboration + Agents SDK editing

This repo compares two document collaboration approaches for AI‑assisted editing and demonstrates ops‑based updates with an AI lock to avoid stale, full‑document replacement.

## The problem this solves
- AI edits should not overwrite recent human edits (base hash + AI lock).
- Edits should be mergeable and schema‑safe (structured ops).
- The UI should stay responsive while the agent makes changes.

## The two approaches

### Approach A: Canonical Tiptap/Yjs state
- Source of truth is the collaborative ProseMirror/Yjs doc.
- AI returns structured ops that are applied to the live doc.
- Best for multi‑human collaboration and conflict detection.

### Approach B: Canonical Markdown
- Source of truth is a Markdown string.
- Tiptap renders from Markdown; AI edits Markdown.
- Simpler data model, but no real‑time multi‑human sync without extra work.


## UI mode note
You don’t need separate edit/preview modes. A simple “AI lock” (disable human edits while the agent is applying changes) is enough to prevent conflicts without adding mode complexity.

## Recommendation
I think Approach A is the better default if you want live multi‑human collaboration plus AI edits. It keeps the ProseMirror/Yjs state canonical, applies structured ops safely, and detects conflicts. Approach B is simpler for single‑user or AI‑only workflows, but it doesn’t handle concurrent human edits well without extra machinery.
## Minimal setup instructions
1) Install deps: `cd apps/web && npm install` and `cd ../agent-server && pip install -r requirements.txt`
2) Set `OPENAI_API_KEY` in your environment
3) Start servers: `python main.py` (agent) and `npm run dev` (web)
4) Open: `http://localhost:5173`
Note: Web runs on Vite, server is Python (FastAPI), and the agent uses the OpenAI Agents SDK.
