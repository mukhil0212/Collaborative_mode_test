# Minimal bake-off: Tiptap collaboration + Agents SDK editing

Minimal repo to compare two document collaboration architectures for an AI-assisted research ops memo.

## Approaches

### Approach A: Canonical Tiptap/Yjs state
- Source of truth is the ProseMirror/Yjs doc (Tiptap editor state).
- AI edits apply directly to the canonical doc (full replace for demo).
- Revision snapshots store editor JSON.

### Approach B: Canonical Markdown
- Source of truth is a Markdown string stored in memory.
- Tiptap renders Markdown via `tiptap-markdown`.
- Human edits convert back to Markdown via `editor.storage.markdown.getMarkdown()` on debounce.
- AI edits Markdown and the UI rehydrates from it.

## Run locally

### 1) Install dependencies

```bash
cd apps/web
npm install

cd ../agent-server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Note: the agent server expects the OpenAI Agents SDK (`openai-agents`, module `agents`). If your environment uses a different package name/version, update `apps/agent-server/main.py`.

### 2) Start the servers

```bash
# Terminal 1
cd apps/agent-server
source .venv/bin/activate
python main.py

# Terminal 2
cd apps/web
npm run dev
```

Open `http://localhost:5173`.

## Usage
- Toggle **Run A** or **Run B**.
- Edit in the doc.
- Click **Save checkpoint** for a human revision.
- Click **Run AI edit** to apply an agent edit (UI locked during run).
- Click a revision in the log to rollback.

## Measurements

### 1) Round-trip stability test

Run:

```bash
cd apps/web
npm run measure
```

This prints whether Markdown stabilizes after 10 markdown → HTML → markdown cycles and shows drift samples.

### 2) AI edit reliability (20 runs)

Run the agent server, then:

```bash
cd apps/web
RUN_AI=true npm run measure
```

This reports success rate and diff sizes for repeated AI edits against the same base doc.

### 3) Human edit + AI handoff

In the UI:
- Make manual edits.
- Save checkpoint.
- Run AI edit.
- Confirm the AI acknowledgement panel references the last revision summary.

### 4) Rollback correctness

In the UI:
- Save a checkpoint.
- Run AI edit.
- Click the older revision in the log and confirm content restores.

## Results (fill in after running)

- Round-trip stability: _pending_
- AI edit success rate: _pending_
- Diff sizes: _pending_
- Formatting churn notes: _pending_
