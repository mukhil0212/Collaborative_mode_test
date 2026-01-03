import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

env_candidates = [
    Path(__file__).resolve().parents[1] / '.env',  # apps/.env
    Path(__file__).resolve().parent / '.env',  # apps/agent-server/.env
    Path(__file__).resolve().parents[2] / '.env',  # repo root .env
]

loaded_env = None
for candidate in env_candidates:
    if candidate.exists():
        load_dotenv(candidate, override=False)
        loaded_env = candidate
        break

if loaded_env:
    print(f"Loaded env from: {loaded_env}")
else:
    print("No .env file found in expected locations.")

if os.getenv("OPENAI_API_KEY"):
    print("OPENAI_API_KEY loaded.")
else:
    print("OPENAI_API_KEY missing after .env load.")

try:
    from agents import Agent, Runner  # OpenAI Agents SDK
except ImportError:
    Agent = None
    Runner = None

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EditRequest(BaseModel):
    mode: str
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    recentRevision: Optional[str] = ''
    instruction: Optional[str] = ''
    baseHash: Optional[str] = None
    schemaHints: Optional[str] = None


class EditResponse(BaseModel):
    summary: str
    ack: str
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    reply: Optional[str] = None
    ops: Optional[list[Dict[str, Any]]] = None
    baseHash: Optional[str] = None


class ChatRequest(BaseModel):
    mode: Optional[str] = 'A'
    message: str
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    sessionId: Optional[str] = None
    baseHash: Optional[str] = None
    schemaHints: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    summary: Optional[str] = None
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    sessionId: Optional[str] = None
    ops: Optional[list[Dict[str, Any]]] = None
    baseHash: Optional[str] = None


AGENT = Agent(
    name="OnboardingAgent",
    instructions="You are an AI assistant helping to edit and improve employee onboarding documents. You return JSON for edits and a short reply.",
    model="gpt-5.2",
)

CHAT_SESSIONS: Dict[str, list[Dict[str, str]]] = {}

def is_tiptap_doc(value: Any) -> bool:
    return isinstance(value, dict) and value.get("type") == "doc"


def cleaned_text(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value
    return None


def stringify_content(content: Any) -> str:
    if isinstance(content, (dict, list)):
        try:
            return json.dumps(content, ensure_ascii=True)
        except TypeError:
            return str(content)
    if content is None:
        return ''
    return str(content)


async def run_agent_edit(
    mode: str,
    content: Any,
    recent_revision: str,
    instruction: str,
    base_hash: Optional[str] = None,
    schema_hints: Optional[str] = None,
) -> Optional[EditResponse]:
    if Agent is None or Runner is None:
        return None
    if not os.getenv('OPENAI_API_KEY'):
        return None

    instruction_text = instruction.strip() or 'Add a Tips for Success section with three helpful onboarding tips.'
    content_text = stringify_content(content)
    if mode == 'A':
        print(f"Mode A edit content JSON length: {len(content_text)}")
    schema_text = schema_hints or ''
    prompt = (
        "You are editing an employee onboarding document. "
        "Return JSON with keys: summary, ack, reply, baseHash, ops. "
        "If mode is A, return ops only (no docJson/html/markdown). "
        "If mode is B, return markdown edits (no ops). "
        "If mode is A, the content below is Markdown and ops must target that document.\n\n"
        "Allowed ops (array of objects, use JSON with double quotes):\n"
        "- append_markdown: { \"op\": \"append_markdown\", \"markdown\": \"...\" }\n"
        "- replace_section_by_heading: { \"op\": \"replace_section_by_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n"
        "- insert_after_heading: { \"op\": \"insert_after_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n\n"
        "Acknowledge the recent revision string in ack. "
        "Make a deterministic edit based on the instruction.\n\n"
        f"Base hash (echo back): {base_hash or ''}\n"
        f"Schema hints: {schema_text}\n\n"
        f"Mode: {mode}\n"
        f"Recent revision: {recent_revision}\n\n"
        f"Instruction: {instruction_text}\n\n"
        f"Content:\n{content_text}"
    )

    result = await Runner.run(AGENT, input=prompt)
    try:
        payload: Dict[str, Any] = json.loads(result.final_output)
        json_payload = payload.get('docJson')
        if not is_tiptap_doc(json_payload):
            json_payload = None
        ops_payload = payload.get('ops')
        if not isinstance(ops_payload, list):
            ops_payload = None
        return EditResponse(
            summary=payload.get('summary', 'AI edit'),
            ack=payload.get('ack', ''),
            reply=payload.get('reply', ''),
            html=cleaned_text(payload.get('html')),
            docJson=json_payload,
            markdown=cleaned_text(payload.get('markdown')),
            ops=ops_payload,
            baseHash=payload.get('baseHash'),
        )
    except json.JSONDecodeError:
        return None


async def run_agent_chat(
    mode: str,
    message: str,
    content: Any,
    session_id: str,
    base_hash: Optional[str] = None,
    schema_hints: Optional[str] = None,
) -> Optional[ChatResponse]:
    if Agent is None or Runner is None:
        return None
    if not os.getenv('OPENAI_API_KEY'):
        return None

    history = CHAT_SESSIONS.get(session_id, [])
    formatted_history = "\n".join([f"{item['role']}: {item['text']}" for item in history][-12:])
    content_text = stringify_content(content)
    if mode == 'A':
        print(f"Mode A chat content JSON length: {len(content_text)}")
    schema_text = schema_hints or ''
    prompt = (
        "You are assisting with an employee onboarding document. "
        "Return JSON with keys: summary, reply, baseHash, ops, markdown. "
        "If the user is just chatting (e.g., greetings, questions), do NOT edit and leave ops/markdown empty. "
        "Only edit when the user clearly requests a change to the document. "
        "If mode is A, return ops only (no docJson/html/markdown). "
        "If mode is B, return markdown edits (no ops). "
        "If mode is A, the content below is Markdown and ops must target that document.\n\n"
        "Allowed ops (array of objects, use JSON with double quotes):\n"
        "- append_markdown: { \"op\": \"append_markdown\", \"markdown\": \"...\" }\n"
        "- replace_section_by_heading: { \"op\": \"replace_section_by_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n"
        "- insert_after_heading: { \"op\": \"insert_after_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n\n"
        "Reply conversationally and briefly in reply.\n\n"
        f"Base hash (echo back): {base_hash or ''}\n"
        f"Schema hints: {schema_text}\n\n"
        f"Conversation so far:\n{formatted_history}\n\n"
        f"Mode: {mode}\n"
        f"Message: {message}\n\n"
        f"Content:\n{content_text}"
    )

    result = await Runner.run(AGENT, input=prompt)
    try:
        payload: Dict[str, Any] = json.loads(result.final_output)
        json_payload = payload.get('docJson')
        if not is_tiptap_doc(json_payload):
            json_payload = None
        ops_payload = payload.get('ops')
        if not isinstance(ops_payload, list):
            ops_payload = None
        response = ChatResponse(
            reply=payload.get('reply', '').strip() or 'Done.',
            summary=payload.get('summary', 'AI edit'),
            html=cleaned_text(payload.get('html')),
            docJson=json_payload,
            markdown=cleaned_text(payload.get('markdown')),
            ops=ops_payload,
            baseHash=payload.get('baseHash'),
            sessionId=session_id,
        )
        return response
    except json.JSONDecodeError:
        return None


@app.post('/edit', response_model=EditResponse)
async def edit(request: EditRequest) -> EditResponse:
    mode = request.mode.upper()
    if mode not in {'A', 'B'}:
        mode = 'A'

    if mode == 'A':
        content = (
            request.markdown
            if request.markdown is not None
            else request.docJson if request.docJson is not None else request.html or ''
        )
    else:
        content = request.markdown
    if content is None:
        content = ''

    agent_response = await run_agent_edit(
        mode,
        content,
        request.recentRevision or '',
        request.instruction or '',
        request.baseHash,
        request.schemaHints,
    )
    if agent_response:
        return agent_response
    raise HTTPException(status_code=502, detail="Agent edit failed")


@app.post('/chat', response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    mode = (request.mode or 'A').upper()
    if mode == 'A':
        content = (
            request.markdown
            if request.markdown is not None
            else request.docJson if request.docJson is not None else request.html or ''
        )
    else:
        content = request.markdown
    if content is None:
        content = ''

    session_id = request.sessionId or "default"
    CHAT_SESSIONS.setdefault(session_id, []).append({"role": "user", "text": request.message})

    agent_response = await run_agent_chat(
        mode,
        request.message,
        content,
        session_id,
        request.baseHash,
        request.schemaHints,
    )
    if agent_response:
        CHAT_SESSIONS.setdefault(session_id, []).append({"role": "assistant", "text": agent_response.reply})
        return agent_response

    raise HTTPException(status_code=502, detail="Agent chat failed")


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8787)
