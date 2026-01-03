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
    # Agents SDK is optional; endpoints degrade gracefully if unavailable.
    from agents import Agent, Runner, function_tool, ModelSettings  # OpenAI Agents SDK
except ImportError:
    Agent = None
    Runner = None
    function_tool = None
    ModelSettings = None

app = FastAPI()
allowed_origins_env = os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173")
allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
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


if function_tool:
    @function_tool
    def document_edit_response(
        summary: str = '',
        ack: str = '',
        reply: str = '',
        baseHash: str = '',
        opsJson: str = '',
        markdown: Optional[str] = None,
    ) -> str:
        payload = {
            'summary': summary,
            'ack': ack,
            'reply': reply,
            'baseHash': baseHash,
            'opsJson': opsJson,
            'markdown': markdown,
        }
        return json.dumps(payload, ensure_ascii=True)
else:
    document_edit_response = None

AGENT = None
if Agent and document_edit_response:
    model_settings = (
        ModelSettings(tool_choice="document_edit_response")
        if ModelSettings
        else None
    )
    AGENT = Agent(
        name="OnboardingAgent",
        instructions=(
            "You are an AI assistant helping to edit and improve employee onboarding documents. "
            "Always call the document_edit_response tool. Do not return JSON in plain text."
        ),
        model="gpt-5.2",
        tools=[document_edit_response],
        model_settings=model_settings,
        tool_use_behavior="stop_on_first_tool",
    )

# Store compact chat history per session to avoid unbounded prompt growth.
SESSION_INPUTS: Dict[str, list[Dict[str, Any]]] = {}
MAX_SESSION_ITEMS = 12
ALLOWED_OPS = (
    "Allowed ops (array of objects, use JSON with double quotes):\n"
    "- append_markdown: { \"op\": \"append_markdown\", \"markdown\": \"...\" }\n"
    "- replace_section_by_heading: { \"op\": \"replace_section_by_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n"
    "- insert_after_heading: { \"op\": \"insert_after_heading\", \"heading\": \"Section Title\", \"level\": 2, \"markdown\": \"...\" }\n\n"
)

def cleaned_text(value: Any) -> Optional[str]:
    """Return trimmed text or None if empty."""
    if isinstance(value, str) and value.strip():
        return value
    return None


def coerce_ops(value: Any) -> Optional[list[Dict[str, Any]]]:
    """Ensure ops is a list of dicts."""
    if not isinstance(value, list):
        return None
    ops = [item for item in value if isinstance(item, dict)]
    return ops or None


def parse_ops(value: Any) -> Optional[list[Dict[str, Any]]]:
    """Parse ops from JSON string or list."""
    # Accept ops as either a JSON string or a list of dicts.
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return None
        return coerce_ops(decoded)
    return coerce_ops(value)


def normalize_agent_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize tool output into API response fields."""
    # Normalize tool output into consistent fields for API responses.
    ops = parse_ops(payload.get("opsJson")) or parse_ops(payload.get("ops"))
    return {
        "summary": cleaned_text(payload.get("summary")) or '',
        "ack": cleaned_text(payload.get("ack")) or '',
        "reply": cleaned_text(payload.get("reply")) or '',
        "base_hash": cleaned_text(payload.get("baseHash")),
        "ops": ops,
        "markdown": cleaned_text(payload.get("markdown")),
    }


def validate_ops(ops: list[Dict[str, Any]]) -> tuple[bool, Optional[str]]:
    """Light validation to reject malformed ops."""
    allowed = {"append_markdown", "replace_section_by_heading", "insert_after_heading"}
    for op in ops:
        op_type = op.get("op")
        if op_type not in allowed:
            return False, f"Invalid op type: {op_type}"
        if not cleaned_text(op.get("markdown")):
            return False, "Missing markdown in op"
        if op_type != "append_markdown" and not cleaned_text(op.get("heading")):
            return False, "Missing heading in op"
    return True, None


def trim_session_items(items: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    """Keep only the last N compact chat items."""
    compact = [
        {"role": item.get("role"), "content": item.get("content")}
        for item in items
        if isinstance(item.get("role"), str) and isinstance(item.get("content"), str)
    ]
    return compact[-MAX_SESSION_ITEMS:]

def stringify_content(content: Any) -> str:
    """Convert content to a prompt-safe string."""
    # Ensure the prompt always gets a string representation.
    if isinstance(content, (dict, list)):
        try:
            return json.dumps(content, ensure_ascii=True)
        except TypeError:
            return str(content)
    if content is None:
        return ''
    return str(content)


def extract_tool_payload(result: Any) -> Optional[Dict[str, Any]]:
    """Extract the tool output payload from an Agents SDK result."""
    # Prefer final output; fall back to tool call outputs and raw response items.
    final_output = getattr(result, "final_output", None)
    if isinstance(final_output, dict):
        return final_output
    if isinstance(final_output, str):
        try:
            return json.loads(final_output)
        except json.JSONDecodeError:
            return None

    new_items = getattr(result, "new_items", None)
    if new_items:
        for item in new_items:
            item_type = getattr(item, "type", None) or item.get("type")
            if item_type == "tool_call_output_item":
                output = getattr(item, "output", None) or item.get("output")
                if isinstance(output, dict):
                    return output
                if isinstance(output, str):
                    try:
                        return json.loads(output)
                    except json.JSONDecodeError:
                        return None

    output = getattr(result, "output", None)
    if output is None:
        try:
            output = result.model_dump().get("output", [])
        except Exception:
            output = []

    for item in output or []:
        item_type = getattr(item, "type", None) or item.get("type")
        if item_type in {"tool_call", "function_call"}:
            arguments = getattr(item, "arguments", None) or item.get("arguments")
            if isinstance(arguments, str):
                try:
                    return json.loads(arguments)
                except json.JSONDecodeError:
                    return None
            if isinstance(arguments, dict):
                return arguments
        if item_type in {"tool_result", "function_result"}:
            content = getattr(item, "output", None) or item.get("output") or getattr(item, "content", None) or item.get("content")
            if isinstance(content, str):
                try:
                    return json.loads(content)
                except json.JSONDecodeError:
                    return None

    return None


def build_prompt(
    kind: str,
    mode: str,
    content_text: str,
    base_hash: Optional[str],
    schema_text: str,
    recent_revision: str,
    instruction_text: str,
    message: str,
) -> str:
    """Build the system prompt for edit or chat mode."""
    if kind == 'edit':
        return (
            "You are editing an employee onboarding document. "
            "Call the document_edit_response tool. "
            "If mode is A, set opsJson (a JSON string of the ops array) and leave markdown empty. "
            "If mode is B, set markdown and leave opsJson empty. "
            "If mode is A, the content below is Markdown and ops must target that document.\n\n"
            f"{ALLOWED_OPS}"
            "Return opsJson as a JSON string (e.g. \"[{...}]\"), not a Python list.\n"
            "Acknowledge the recent revision string in ack. "
            "Make a deterministic edit based on the instruction.\n\n"
            f"Base hash (echo back): {base_hash or ''}\n"
            f"Schema hints: {schema_text}\n\n"
            f"Mode: {mode}\n"
            f"Recent revision: {recent_revision}\n\n"
            f"Instruction: {instruction_text}\n\n"
            f"Content:\n{content_text}"
        )

    return (
        "You are assisting with an employee onboarding document. "
        "Call the document_edit_response tool. "
        "If the user is just chatting (e.g., greetings, questions), do NOT edit and leave opsJson/markdown empty. "
        "Only edit when the user clearly requests a change to the document. "
        "If mode is A, set opsJson (a JSON string of the ops array) and leave markdown empty. "
        "If mode is B, set markdown and leave opsJson empty. "
        "If mode is A, the content below is Markdown and ops must target that document.\n\n"
        f"{ALLOWED_OPS}"
        "Return opsJson as a JSON string (e.g. \"[{...}]\"), not a Python list.\n"
        "Reply conversationally and briefly in reply.\n\n"
        f"Base hash (echo back): {base_hash or ''}\n"
        f"Schema hints: {schema_text}\n\n"
        f"Mode: {mode}\n"
        f"Message: {message}\n\n"
        f"Content:\n{content_text}"
    )


async def run_agent(
    kind: str,
    mode: str,
    content: Any,
    base_hash: Optional[str],
    schema_hints: Optional[str],
    recent_revision: str = '',
    instruction: str = '',
    message: str = '',
    input_items: Optional[list[Dict[str, Any]]] = None,
) -> tuple[Optional[Dict[str, Any]], Optional[Any]]:
    """Run the agent with optional session input items."""
    if AGENT is None or Runner is None:
        return None, None
    if not os.getenv('OPENAI_API_KEY'):
        return None, None

    content_text = stringify_content(content)
    if mode == 'A':
        print(f"Mode A {kind} content length: {len(content_text)}")
    schema_text = schema_hints or ''
    instruction_text = instruction.strip() or 'Add a Tips for Success section with three helpful onboarding tips.'
    prompt = build_prompt(
        kind=kind,
        mode=mode,
        content_text=content_text,
        base_hash=base_hash,
        schema_text=schema_text,
        recent_revision=recent_revision,
        instruction_text=instruction_text,
        message=message,
    )

    if input_items is not None:
        next_input = list(input_items) + [{"role": "user", "content": prompt}]
        result = await Runner.run(AGENT, input=next_input)
    else:
        result = await Runner.run(AGENT, input=prompt)
    try:
        payload = extract_tool_payload(result)
        if payload is None:
            raise ValueError("Tool not called")
        return payload, result
    except (json.JSONDecodeError, ValueError):
        return None, result


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

    payload, _result = await run_agent(
        kind='edit',
        mode=mode,
        content=content,
        base_hash=request.baseHash,
        schema_hints=request.schemaHints,
        recent_revision=request.recentRevision or '',
        instruction=request.instruction or '',
    )
    if payload:
        normalized = normalize_agent_payload(payload)
        ops = normalized["ops"] if mode == 'A' else None
        markdown = normalized["markdown"] if mode == 'B' else None
        if mode == 'A' and not ops:
            raise HTTPException(status_code=502, detail="Agent edit returned no ops")
        if ops:
            valid, error = validate_ops(ops)
            if not valid:
                raise HTTPException(status_code=502, detail=error or "Invalid ops payload")
        if mode == 'B' and not markdown:
            raise HTTPException(status_code=502, detail="Agent edit returned no markdown")
        return EditResponse(
            summary=normalized["summary"],
            ack=normalized["ack"],
            reply=normalized["reply"] or None,
            ops=ops,
            markdown=markdown,
            baseHash=normalized["base_hash"] or request.baseHash,
        )
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
    input_items = SESSION_INPUTS.get(session_id, [])
    payload, result = await run_agent(
        kind='chat',
        mode=mode,
        content=content,
        base_hash=request.baseHash,
        schema_hints=request.schemaHints,
        message=request.message,
        input_items=input_items,
    )
    if payload:
        normalized = normalize_agent_payload(payload)
        if result is not None:
            next_items = input_items + [{"role": "user", "content": request.message}]
            reply_text = normalized["reply"] or ("Applied the edit." if normalized["ops"] or normalized["markdown"] else "Okay.")
            next_items.append({"role": "assistant", "content": reply_text})
            SESSION_INPUTS[session_id] = trim_session_items(next_items)
        ops = normalized["ops"] if mode == 'A' else None
        markdown = normalized["markdown"] if mode == 'B' else None
        reply = normalized["reply"] or ("Applied the edit." if ops or markdown else "Okay.")
        if ops:
            valid, error = validate_ops(ops)
            if not valid:
                raise HTTPException(status_code=502, detail=error or "Invalid ops payload")
        return ChatResponse(
            reply=reply,
            summary=normalized["summary"] or None,
            ops=ops,
            markdown=markdown,
            baseHash=normalized["base_hash"] or request.baseHash,
            sessionId=session_id,
        )

    raise HTTPException(status_code=502, detail="Agent chat failed")


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8787)
