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


class EditResponse(BaseModel):
    summary: str
    ack: str
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    reply: Optional[str] = None


class ChatRequest(BaseModel):
    mode: Optional[str] = 'A'
    message: str
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    sessionId: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    summary: Optional[str] = None
    html: Optional[str] = None
    docJson: Optional[Dict[str, Any]] = None
    markdown: Optional[str] = None
    sessionId: Optional[str] = None


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


async def run_agent_edit(mode: str, content: str, recent_revision: str, instruction: str) -> Optional[EditResponse]:
    if Agent is None or Runner is None:
        return None
    if not os.getenv('OPENAI_API_KEY'):
        return None

    instruction_text = instruction.strip() or 'Add a Tips for Success section with three helpful onboarding tips.'
    prompt = (
        "You are editing an employee onboarding document. "
        "Return JSON with keys: summary, ack, reply, docJson, html, markdown. "
        "If mode is A, only fill docJson (preferred) or html. If mode is B, only fill markdown. "
        "Acknowledge the recent revision string in ack. "
        "Make a deterministic edit based on the instruction.\n\n"
        f"Mode: {mode}\n"
        f"Recent revision: {recent_revision}\n\n"
        f"Instruction: {instruction_text}\n\n"
        f"Content:\n{content}"
    )

    result = await Runner.run(AGENT, input=prompt)
    try:
        payload: Dict[str, Any] = json.loads(result.final_output)
        json_payload = payload.get('docJson')
        if not is_tiptap_doc(json_payload):
            json_payload = None
        return EditResponse(
            summary=payload.get('summary', 'AI edit'),
            ack=payload.get('ack', ''),
            reply=payload.get('reply', ''),
            html=cleaned_text(payload.get('html')),
            docJson=json_payload,
            markdown=cleaned_text(payload.get('markdown')),
        )
    except json.JSONDecodeError:
        return None


async def run_agent_chat(mode: str, message: str, content: str, session_id: str) -> Optional[ChatResponse]:
    if Agent is None or Runner is None:
        return None
    if not os.getenv('OPENAI_API_KEY'):
        return None

    history = CHAT_SESSIONS.get(session_id, [])
    formatted_history = "\n".join([f"{item['role']}: {item['text']}" for item in history][-12:])
    prompt = (
        "You are assisting with an employee onboarding document. "
        "Return JSON with keys: summary, reply, docJson, html, markdown. "
        "If the user is just chatting (e.g., greetings, questions), do NOT edit and leave docJson/html/markdown empty. "
        "Only edit when the user clearly requests a change to the document. "
        "If mode is A, only fill docJson (preferred) or html. If mode is B, only fill markdown. "
        "Reply conversationally and briefly in reply.\n\n"
        f"Conversation so far:\n{formatted_history}\n\n"
        f"Mode: {mode}\n"
        f"Message: {message}\n\n"
        f"Content:\n{content}"
    )

    result = await Runner.run(AGENT, input=prompt)
    try:
        payload: Dict[str, Any] = json.loads(result.final_output)
        json_payload = payload.get('docJson')
        if not is_tiptap_doc(json_payload):
            json_payload = None
        response = ChatResponse(
            reply=payload.get('reply', '').strip() or 'Done.',
            summary=payload.get('summary', 'AI edit'),
            html=cleaned_text(payload.get('html')),
            docJson=json_payload,
            markdown=cleaned_text(payload.get('markdown')),
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
        content = request.docJson or request.html or ''
    else:
        content = request.markdown
    if not content:
        content = ''

    agent_response = await run_agent_edit(
        mode,
        content,
        request.recentRevision or '',
        request.instruction or ''
    )
    if agent_response:
        return agent_response
    raise HTTPException(status_code=502, detail="Agent edit failed")


@app.post('/chat', response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    mode = (request.mode or 'A').upper()
    if mode == 'A':
        content = request.docJson or request.html or ''
    else:
        content = request.markdown
    if not content:
        content = ''

    session_id = request.sessionId or "default"
    CHAT_SESSIONS.setdefault(session_id, []).append({"role": "user", "text": request.message})

    agent_response = await run_agent_chat(mode, request.message, content, session_id)
    if agent_response:
        CHAT_SESSIONS.setdefault(session_id, []).append({"role": "assistant", "text": agent_response.reply})
        return agent_response

    raise HTTPException(status_code=502, detail="Agent chat failed")


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8787)
