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
const DEBUG_AI = import.meta.env.DEV

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

type AiOperation =
  | {
      op: 'append_markdown'
      markdown: string
    }
  | {
      op: 'rename_heading'
      heading: string
      newHeading: string
      level?: number
    }
  | {
      op: 'delete_section'
      heading: string
      level?: number
    }
  | {
      op: 'replace_section_by_heading'
      heading: string
      level?: number
      markdown: string
    }
  | {
      op: 'insert_after_heading'
      heading: string
      level?: number
      markdown: string
    }

function buildExtensions(approach: Approach, ydoc: Y.Doc | null): AnyExtension[] {
  // Disable undoRedo when collaborating to avoid conflicts with Yjs.
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// Stable hash to detect concurrent edits while the AI is working.
function hashDoc(doc: object): string {
  const raw = JSON.stringify(doc)
  let hash = 5381
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 33) ^ raw.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

// Keep the AI grounded on supported nodes/marks.
function schemaHints() {
  return [
    'Nodes: doc, paragraph, heading(level 1-6), bulletList, orderedList, listItem, codeBlock, table, tableRow, tableCell, tableHeader.',
    'Marks: bold, italic, code, strike, link, underline.'
  ].join(' ')
}

function toMarkdown(editor: { getMarkdown?: () => string; getText: () => string }) {
  try {
    if (typeof editor.getMarkdown === 'function') {
      return editor.getMarkdown()
    }
  } catch {
    // fall back to text
  }
  return editor.getText()
}

export default function App() {
  const debug = (...args: unknown[]) => {
    if (DEBUG_AI) {
      console.log('[AI]', ...args)
    }
  }

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

  const formatOpResultMessage = (result: { applied: number; errors: string[] }, total: number) => {
    if (result.errors.length === 0) return null
    const summary = `Applied ${result.applied}/${total} ops.`
    const details = result.errors.slice(0, 3).join(' | ')
    return `${summary} Failed: ${details}${result.errors.length > 3 ? ' | …' : ''}`
  }

  const applyMarkdownAtRange = (from: number, to: number, markdown: string) => {
    const applied = editor?.commands.insertContentAt(
      { from, to },
      markdown,
      { contentType: 'markdown' } as { contentType: 'markdown' }
    )
    if (!applied) {
      editor?.commands.insertContentAt({ from, to }, markdown)
    }
  }

  const parseLeadingHeading = (markdown: string) => {
    const trimmed = markdown.trimStart()
    const match = trimmed.match(/^(#{1,6})\s+([^\n]+)\n?/)
    if (!match) return null
    return { level: match[1].length, text: match[2].trim(), trimmed, matchLength: match[0].length }
  }

  const stripMatchingHeading = (markdown: string, heading: string, level: number) => {
    const parsed = parseLeadingHeading(markdown)
    if (!parsed) return markdown
    if (parsed.level === level && parsed.text === heading) {
      return parsed.trimmed.slice(parsed.matchLength).replace(/^\n+/, '')
    }
    return markdown
  }

  // Apply AI ops as small patches so we avoid full-document replacement.
  const applyAiOps = (ops: AiOperation[]) => {
    // Translate model-friendly ops into real ProseMirror transactions.
    // When Collaboration is enabled, these transactions are turned into Yjs updates automatically.
    if (!editor) return { applied: 0, errors: ['Editor not ready'] }

    let applied = 0
    const errors: string[] = []

    const readHeadings = () => {
      const headings: Array<{ pos: number; level: number; text: string; nodeSize: number }> = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          const level = typeof node.attrs.level === 'number' ? node.attrs.level : 1
          headings.push({ pos, level, text: node.textContent.trim(), nodeSize: node.nodeSize })
        }
      })
      return headings
    }

    ops.forEach((op) => {
      if (op.op === 'append_markdown') {
        if (!isNonEmptyString(op.markdown)) {
          errors.push('Missing markdown in op')
          return
        }
        const endPos = editor.state.doc.content.size
        applyMarkdownAtRange(endPos, endPos, op.markdown)
        applied += 1
        return
      }

      if (op.op === 'rename_heading') {
        const headingText = op.heading?.trim()
        const newHeading = op.newHeading?.trim()
        if (!headingText || !newHeading) {
          errors.push('Missing heading/newHeading in op')
          return
        }

        const headings = readHeadings()
        const target = headings.find((heading) => {
          if (heading.text !== headingText) return false
          if (typeof op.level === 'number') {
            return heading.level === op.level
          }
          return true
        })

        if (!target) {
          errors.push(`Heading not found: ${headingText}`)
          return
        }

        const from = target.pos + 1
        const to = target.pos + target.nodeSize - 1
        const ok = editor.commands.command(({ tr }) => {
          tr.insertText(newHeading, from, to)
          return true
        })
        if (!ok) {
          errors.push('Failed to rename heading')
          return
        }
        applied += 1
        return
      }

      if (op.op === 'delete_section') {
        const headingText = op.heading?.trim()
        if (!headingText) {
          errors.push('Missing heading in op')
          return
        }

        const headings = readHeadings()
        const target = headings.find((heading) => {
          if (heading.text !== headingText) return false
          if (typeof op.level === 'number') {
            return heading.level === op.level
          }
          return true
        })

        if (!target) {
          errors.push(`Heading not found: ${headingText}`)
          return
        }

        const targetIndex = headings.indexOf(target)
        const targetLevel = typeof op.level === 'number' ? op.level : target.level
        const nextHeading = headings
          .slice(targetIndex + 1)
          .find((heading) => heading.level <= targetLevel)
        const from = target.pos
        const to = nextHeading ? nextHeading.pos : editor.state.doc.content.size

        const ok = editor.commands.command(({ tr }) => {
          tr.delete(from, to)
          return true
        })
        if (!ok) {
          errors.push(`Failed to delete section: ${headingText}`)
          return
        }

        applied += 1
        return
      }

      const headingText = op.heading?.trim()
      if (!headingText) {
        errors.push('Missing heading in op')
        return
      }

      const headings = readHeadings()
      const target = headings.find((heading) => {
        if (heading.text !== headingText) return false
        if (typeof op.level === 'number') {
          return heading.level === op.level
        }
        return true
      })

      if (!target) {
        errors.push(`Heading not found: ${headingText}`)
        return
      }

      const targetIndex = headings.indexOf(target)
      const targetLevel = typeof op.level === 'number' ? op.level : target.level
      const nextHeading = headings
        .slice(targetIndex + 1)
        .find((heading) => heading.level <= targetLevel)

      const from = target.pos + target.nodeSize
      const to = nextHeading ? nextHeading.pos : editor.state.doc.content.size

      if (op.op === 'replace_section_by_heading') {
        if (!isNonEmptyString(op.markdown)) {
          errors.push('Missing markdown in op')
          return
        }
        const bodyOnly = stripMatchingHeading(op.markdown, headingText, targetLevel)
        applyMarkdownAtRange(from, to, bodyOnly)
        applied += 1
        return
      }

      if (op.op === 'insert_after_heading') {
        if (!isNonEmptyString(op.markdown)) {
          errors.push('Missing markdown in op')
          return
        }
        const bodyOnly = stripMatchingHeading(op.markdown, headingText, targetLevel)
        applyMarkdownAtRange(from, from, bodyOnly)
        applied += 1
        return
      }

      errors.push(`Unknown op: ${(op as { op: string }).op}`)
    })

    return { applied, errors }
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
      const baseDoc = editor.getJSON()
      const baseHash = hashDoc(baseDoc)
      const markdownSnapshot = toMarkdown(editor)
      debug('edit request', { approach, baseHash, instruction })
      const payload =
        approach === 'A'
          ? {
              mode: 'A',
              docJson: baseDoc,
              markdown: markdownSnapshot,
              baseHash,
              schemaHints: schemaHints(),
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
      debug('chat response', data)
      debug('edit response', data)

      if (approach === 'A') {
        const ops = Array.isArray(data.ops) ? (data.ops as AiOperation[]) : null
        const currentHash = hashDoc(editor.getJSON())
        if (ops) {
          if (currentHash !== baseHash) {
            debug('edit skipped: base hash mismatch', { baseHash, currentHash })
            pushChatMessage({
              approach,
              role: 'assistant',
              text: 'Document changed while the AI was editing. Please retry.',
              timestamp: nowIso()
            })
            return
          }
          pushStatusMessage('AI is updating the document...')
          const result = applyAiOps(ops)
          debug('edit ops applied', result)
          if (result.applied === 0) {
            throw new Error(result.errors[0] || 'AI edit returned no valid ops')
          }
          const warning = formatOpResultMessage(result, ops.length)
          if (warning) {
            pushChatMessage({
              approach,
              role: 'assistant',
              text: warning,
              timestamp: nowIso()
            })
          }
          addRevision({
            approach,
            actor: 'ai',
            summary: data.summary || 'AI edit',
            timestamp: nowIso(),
            snapshot: editor.getJSON()
          })
        } else {
          throw new Error('AI edit returned no ops')
        }
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
          debug('edit markdown applied', { applied })
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
      const baseDoc = editor?.getJSON() ?? {}
      const baseHash = editor ? hashDoc(baseDoc) : null
      const markdownSnapshot = editor ? toMarkdown(editor) : ''
      debug('chat request', { approach, baseHash, message })
      const payload =
        approach === 'A'
          ? {
              mode: 'A',
              message,
              docJson: baseDoc,
              markdown: markdownSnapshot,
              baseHash,
              schemaHints: schemaHints(),
              sessionId: chatSessionId
            }
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

      if (approach === 'A' && editor) {
        const ops = Array.isArray(data.ops) ? (data.ops as AiOperation[]) : null
        const currentHash = hashDoc(editor.getJSON())
        const baseMatches = baseHash ? currentHash === baseHash : true

        if (ops) {
          if (!baseMatches) {
            debug('chat skipped: base hash mismatch', { baseHash, currentHash })
            pushChatMessage({
              approach,
              role: 'assistant',
              text: 'Document changed while the AI was editing. Please retry.',
              timestamp: nowIso()
            })
          } else {
            pushStatusMessage('AI is updating the document...')
            const result = applyAiOps(ops)
            debug('chat ops applied', result)
            const warning = formatOpResultMessage(result, ops.length)
            if (warning) {
              pushChatMessage({
                approach,
                role: 'assistant',
                text: warning,
                timestamp: nowIso()
              })
            }
            if (result.applied > 0) {
              addRevision({
                approach,
                actor: 'ai',
                summary: data.summary || 'AI edit',
                timestamp: nowIso(),
                snapshot: editor.getJSON()
              })
            }
          }
        } else if (data.markdown || data.docJson || data.html) {
          pushChatMessage({
            approach,
            role: 'assistant',
            text: 'AI did not return ops. Please retry.',
            timestamp: nowIso()
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
            debug('chat markdown applied', { applied })
          }
        } else if (nextHtml && editor) {
          pushStatusMessage('AI is updating the document...')
          editor.commands.setContent(nextHtml, { emitUpdate: false, contentType: 'html' })
          debug('chat html applied')
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
