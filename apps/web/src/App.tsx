import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { Collaboration } from '@tiptap/extension-collaboration'
import { Markdown } from '@tiptap/markdown'
import * as Y from 'yjs'
import { normalizeMarkdown } from './lib/markdown'
import type { AnyExtension } from '@tiptap/core'
import INITIAL_MARKDOWN from './initial-memo.md?raw'

const AGENT_SERVER_URL = import.meta.env.VITE_AGENT_SERVER_URL || 'http://localhost:8787'

type Approach = 'A' | 'B'

type RevisionEntry = {
  id: string
  approach: Approach
  actor: 'human' | 'ai'
  summary: string
  timestamp: string
  snapshot: unknown
}

type ChatMessage = {
  id: string
  approach: Approach
  role: 'user' | 'assistant'
  text: string
  timestamp: string
}

function buildExtensions(approach: Approach, ydoc: Y.Doc | null): AnyExtension[] {
  const starterKit =
    approach === 'A' ? StarterKit.configure({ undoRedo: false }) : StarterKit
  const extensions = [
    Markdown,
    starterKit,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell
  ] as AnyExtension[]

  if (approach === 'A' && ydoc) {
    extensions.push(
      Collaboration.configure({
        document: ydoc
      }) as AnyExtension
    )
  }

  return extensions
}

function nowIso() {
  return new Date().toISOString()
}

function isTiptapDoc(value: unknown): value is { type: string } {
  return !!value && typeof value === 'object' && (value as { type?: string }).type === 'doc'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export default function App() {
  const [approach, setApproach] = useState<Approach>('A')
  const [aiRunning, setAiRunning] = useState(false)
  const [revisionLog, setRevisionLog] = useState<RevisionEntry[]>([])
  const [canonicalMarkdown, setCanonicalMarkdown] = useState(INITIAL_MARKDOWN)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatRunning, setChatRunning] = useState(false)
  const [chatSessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const debounceRef = useRef<number | null>(null)
  const lastAppliedMarkdown = useRef<string | null>(null)
  const lastSavedJson = useRef<string | null>(null)
  const canonicalMarkdownRef = useRef(canonicalMarkdown)
  const aiRunningRef = useRef(aiRunning)

  const ydoc = useMemo(() => (approach === 'A' ? new Y.Doc() : null), [approach])

  const editor = useEditor(
    {
      extensions: buildExtensions(approach, ydoc),
      content: approach === 'B' ? canonicalMarkdown : '',
      contentType: approach === 'B' ? 'markdown' : undefined,
      onUpdate: ({ editor }) => {
        if (approach !== 'B' || aiRunningRef.current) return
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current)
        }
        debounceRef.current = window.setTimeout(() => {
          const markdown = normalizeMarkdown(editor.getMarkdown())
          if (markdown === canonicalMarkdownRef.current) return
          canonicalMarkdownRef.current = markdown
          lastAppliedMarkdown.current = markdown
          setCanonicalMarkdown(markdown)
          setLastSyncAt(nowIso())
          addRevision({
            approach,
            actor: 'human',
            summary: 'Auto-save (idle)',
            timestamp: nowIso(),
            snapshot: markdown
          })
        }, 700)
      }
      ,
      onBlur: ({ editor }) => {
        if (approach !== 'A' || aiRunning) return
        const snapshot = editor.getJSON()
        const serialized = JSON.stringify(snapshot)
        if (serialized === lastSavedJson.current) return
        lastSavedJson.current = serialized
        addRevision({
          approach,
          actor: 'human',
          summary: 'Auto-save (blur)',
          timestamp: nowIso(),
          snapshot
        })
      }
    },
    [approach]
  )

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!aiRunning)
  }, [aiRunning, editor])

  useEffect(() => {
    if (!editor) return
    if (approach === 'A' && editor.isEmpty) {
      editor.commands.setContent(INITIAL_MARKDOWN, { emitUpdate: false, contentType: 'markdown' })
    }
    if (approach === 'B' && editor.isEmpty) {
      if (lastAppliedMarkdown.current !== canonicalMarkdown) {
        const applied = editor.commands.setContent(canonicalMarkdown, {
          emitUpdate: false,
          contentType: 'markdown'
        })
        if (!applied || editor.isEmpty) {
          editor.commands.setContent(canonicalMarkdown, { emitUpdate: false })
        }
        lastAppliedMarkdown.current = canonicalMarkdown
      }
    }
  }, [approach, editor, canonicalMarkdown])

  useEffect(() => {
    canonicalMarkdownRef.current = canonicalMarkdown
  }, [canonicalMarkdown])

  useEffect(() => {
    aiRunningRef.current = aiRunning
  }, [aiRunning])

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current)
      }
    }
  }, [])

  const resetForApproach = (nextApproach: Approach) => {
    setApproach(nextApproach)
    setRevisionLog([])
    setCanonicalMarkdown(INITIAL_MARKDOWN)
    setLastSyncAt(null)
    setChatMessages([])
    setChatInput('')
    lastAppliedMarkdown.current = null
    lastSavedJson.current = null
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }

  const addRevision = (entry: Omit<RevisionEntry, 'id'>) => {
    setRevisionLog((prev) => [
      { ...entry, id: `${entry.actor}-${Date.now()}-${Math.random().toString(16).slice(2)}` },
      ...prev
    ])
  }

  const handleCheckpoint = () => {
    if (!editor) return
    if (approach === 'A') {
      addRevision({
        approach,
        actor: 'human',
        summary: 'Human checkpoint',
        timestamp: nowIso(),
        snapshot: editor.getJSON()
      })
      return
    }

    addRevision({
      approach,
      actor: 'human',
      summary: 'Human checkpoint (markdown)',
      timestamp: nowIso(),
      snapshot: canonicalMarkdown
    })
  }

  const handleRollback = (entry: RevisionEntry) => {
    if (!editor) return
    if (entry.approach !== approach) return

    if (approach === 'A') {
      editor.commands.setContent(entry.snapshot as object, { emitUpdate: false })
      return
    }

    const markdown = entry.snapshot as string
    setCanonicalMarkdown(markdown)
    const applied = editor.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' })
    if (!applied || editor.isEmpty) {
      editor.commands.setContent(markdown, { emitUpdate: false })
    }
    lastAppliedMarkdown.current = markdown
  }

  const pushChatMessage = (message: Omit<ChatMessage, 'id'>) => {
    setChatMessages((prev) => [
      { ...message, id: `${message.role}-${Date.now()}-${Math.random().toString(16).slice(2)}` },
      ...prev
    ])
  }

  const pushStatusMessage = (text: string) => {
    pushChatMessage({
      approach,
      role: 'assistant',
      text,
      timestamp: nowIso()
    })
  }

  const handleAiEdit = async () => {
    if (!editor || aiRunning) return

    const instruction = chatInput.trim() || 'Add a Tips for Success section with three helpful onboarding tips.'
    pushChatMessage({
      approach,
      role: 'user',
      text: instruction,
      timestamp: nowIso()
    })
    setChatInput('')

    setAiRunning(true)

    try {
      const payload =
        approach === 'A'
          ? {
              mode: 'A',
              docJson: editor.getJSON(),
              recentRevision: revisionLog[0]?.summary || '',
              instruction
            }
          : {
              mode: 'B',
              markdown: canonicalMarkdown,
              recentRevision: revisionLog[0]?.summary || '',
              instruction
            }

      const response = await fetch(`${AGENT_SERVER_URL}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error(`Agent error: ${response.status}`)
      }

      const data = await response.json()

      if (approach === 'A') {
        const nextDoc = isTiptapDoc(data.docJson) ? data.docJson : null
        const nextHtml = isNonEmptyString(data.html) ? data.html : null
        const nextContent = nextDoc ?? nextHtml
        if (!nextContent) {
          throw new Error('AI edit returned no content')
        }
        pushStatusMessage('AI is updating the document...')
        editor.commands.setContent(nextContent, { emitUpdate: false })
        addRevision({
          approach,
          actor: 'ai',
          summary: data.summary || 'AI edit',
          timestamp: nowIso(),
          snapshot: editor.getJSON()
        })
      } else {
        const nextMarkdown = isNonEmptyString(data.markdown) ? data.markdown : null
        const nextHtml = isNonEmptyString(data.html) ? data.html : null
        if (nextMarkdown) {
          pushStatusMessage('AI is updating the document...')
          const markdown = normalizeMarkdown(nextMarkdown)
          setCanonicalMarkdown(markdown)
          const applied = editor.commands.setContent(markdown, {
            emitUpdate: false,
            contentType: 'markdown'
          })
          if (!applied || editor.isEmpty) {
            editor.commands.setContent(markdown, { emitUpdate: false })
          }
          lastAppliedMarkdown.current = markdown
          addRevision({
            approach,
            actor: 'ai',
            summary: data.summary || 'AI edit',
            timestamp: nowIso(),
            snapshot: markdown
          })
        } else if (nextHtml) {
          pushStatusMessage('AI is updating the document...')
          editor.commands.setContent(nextHtml, { emitUpdate: false, contentType: 'html' })
          const markdown = normalizeMarkdown(editor.getMarkdown())
          setCanonicalMarkdown(markdown)
          lastAppliedMarkdown.current = markdown
          addRevision({
            approach,
            actor: 'ai',
            summary: data.summary || 'AI edit',
            timestamp: nowIso(),
            snapshot: markdown
          })
        } else {
          throw new Error('AI edit returned no markdown')
        }
      }

      if (data.reply) {
        pushChatMessage({
          approach,
          role: 'assistant',
          text: data.reply,
          timestamp: nowIso()
        })
      }
    } catch (error) {
      pushChatMessage({
        approach,
        role: 'assistant',
        text: error instanceof Error ? error.message : 'AI edit failed',
        timestamp: nowIso()
      })
    } finally {
      setAiRunning(false)
    }
  }

  const handleChatSend = async () => {
    const message = chatInput.trim()
    if (!message || chatRunning || aiRunning) return

    pushChatMessage({
      approach,
      role: 'user',
      text: message,
      timestamp: nowIso()
    })
    setChatInput('')
    setChatRunning(true)
    setAiRunning(true)

    try {
      const payload =
        approach === 'A'
          ? { mode: 'A', message, docJson: editor?.getJSON() || {}, sessionId: chatSessionId }
          : { mode: 'B', message, markdown: canonicalMarkdown, sessionId: chatSessionId }

      const response = await fetch(`${AGENT_SERVER_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error(`Chat error: ${response.status}`)
      }

      const data = await response.json()

      if (approach === 'A' && (data.docJson || data.html || data.markdown)) {
        const nextDoc = isTiptapDoc(data.docJson) ? data.docJson : null
        const nextHtml = isNonEmptyString(data.html) ? data.html : null
        const nextMarkdown = isNonEmptyString(data.markdown) ? data.markdown : null
        const nextContent = nextDoc ?? nextHtml ?? nextMarkdown
        if (nextContent && editor) {
          pushStatusMessage('AI is updating the document...')
          editor.commands.setContent(nextContent, { emitUpdate: false })
          addRevision({
            approach,
            actor: 'ai',
            summary: data.summary || 'AI edit',
            timestamp: nowIso(),
            snapshot: editor.getJSON()
          })
        }
      }

      if (approach === 'B' && (isNonEmptyString(data.markdown) || isNonEmptyString(data.html))) {
        const nextMarkdown = isNonEmptyString(data.markdown) ? data.markdown : null
        const nextHtml = isNonEmptyString(data.html) ? data.html : null
        if (nextMarkdown) {
          if (editor) {
            pushStatusMessage('AI is updating the document...')
            const applied = editor.commands.setContent(nextMarkdown, {
              emitUpdate: false,
              contentType: 'markdown'
            })
            if (!applied || editor.isEmpty) {
              editor.commands.setContent(nextMarkdown, { emitUpdate: false })
            }
          }
        } else if (nextHtml && editor) {
          pushStatusMessage('AI is updating the document...')
          editor.commands.setContent(nextHtml, { emitUpdate: false, contentType: 'html' })
        }
        if (editor) {
          const markdown = normalizeMarkdown(editor.getMarkdown())
          setCanonicalMarkdown(markdown)
          lastAppliedMarkdown.current = markdown
          addRevision({
            approach,
            actor: 'ai',
            summary: data.summary || 'AI edit',
            timestamp: nowIso(),
            snapshot: markdown
          })
        }
      }

      pushChatMessage({
        approach,
        role: 'assistant',
        text: data.reply || 'No reply',
        timestamp: nowIso()
      })
    } catch (error) {
      pushChatMessage({
        approach,
        role: 'assistant',
        text: error instanceof Error ? error.message : 'Chat failed',
        timestamp: nowIso()
      })
    } finally {
      setChatRunning(false)
      setAiRunning(false)
    }
  }

  const approachLabel = approach === 'A' ? 'Approach A (Canonical Tiptap/Yjs)' : 'Approach B (Canonical Markdown)'

  return (
    <div className="app">
      <header>
        <div>
          <h1>Minimal Bake-off</h1>
          <p>{approachLabel}</p>
        </div>
        <div className="toolbar">
          <button
            className={approach === 'A' ? 'active' : ''}
            onClick={() => resetForApproach('A')}
          >
            Run A
          </button>
          <button
            className={approach === 'B' ? 'active' : ''}
            onClick={() => resetForApproach('B')}
          >
            Run B
          </button>
        </div>
      </header>

      <section className="controls">
        <div className="mode">
          <span className={aiRunning ? 'pill running' : 'pill'}>
            {aiRunning ? 'AI mode (locked)' : 'Edit mode'}
          </span>
          {approach === 'B' && lastSyncAt && (
            <span className="note">Canonical markdown synced: {new Date(lastSyncAt).toLocaleTimeString()}</span>
          )}
        </div>
        <div className="actions">
          <button onClick={handleCheckpoint} disabled={!editor || aiRunning}>
            Save checkpoint
          </button>
        </div>
      </section>

      <main>
        <div className="editor">
          <EditorContent editor={editor} />
        </div>
        <aside>
          <div className="panel">
            <h2>Revision Log</h2>
            {revisionLog.length === 0 && <p className="muted">No revisions yet.</p>}
            <ul>
              {revisionLog
                .filter((entry) => entry.approach === approach)
                .map((entry) => (
                  <li key={entry.id}>
                    <button onClick={() => handleRollback(entry)} disabled={aiRunning}>
                      <span className="meta">{entry.actor.toUpperCase()}</span>
                      <span>{entry.summary}</span>
                      <span className="time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
          <div className="panel chat-panel">
            <h2>Chat with AI</h2>
            <div className="chat-container">
              {chatMessages.filter((message) => message.approach === approach).length === 0 ? (
                <div className="chat-empty">
                  <p>No messages yet. Ask the AI to edit the onboarding document!</p>
                </div>
              ) : (
                <div className="chat-messages">
                  {chatMessages
                    .filter((message) => message.approach === approach)
                    .slice()
                    .reverse()
                    .map((message) => (
                      <div key={message.id} className={`chat-message ${message.role}`}>
                        <div className="chat-content">
                          <div className="chat-header">
                            <span className="chat-role">{message.role === 'user' ? 'You' : 'AI'}</span>
                            <span className="chat-time">{new Date(message.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className="chat-text">{message.text}</div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div className="chat-input-container">
              <div className="chat-input">
                <input
                  type="text"
                  placeholder="Ask AI to update the onboarding doc..."
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleChatSend()
                    }
                  }}
                  disabled={aiRunning || chatRunning}
                />
                <button
                  onClick={handleChatSend}
                  disabled={aiRunning || chatRunning || !chatInput.trim()}
                  className="send-button"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
          {approach === 'B' && (
            <div className="panel">
              <h2>Canonical Markdown</h2>
              <pre>{canonicalMarkdown}</pre>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
