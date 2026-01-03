import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const INITIAL_MARKDOWN = `# Research Ops Memo

## Overview
This memo is intentionally small but includes structure for round-trip testing.

## Steps
1. Gather signals
2. Synthesize findings
3. Draft recommendations

### Risks
- Drift in conversion
- Patch failure
- Revision churn

## Table Example

| Stage | Owner | Notes |
| --- | --- | --- |
| Intake | Human | Capture intent |
| Draft | AI | Suggest changes |

## Code Block

\`\`\`ts
console.log('demo')
\`\`\`
`

const turndownService = new TurndownService({
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**'
})

turndownService.use(gfm)

turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement(content) {
    return '~~' + content + '~~'
  }
})

const normalize = (md) => md.replace(/\r\n/g, '\n').trim() + '\n'

const mdToHtml = (md) => marked.parse(md, { gfm: true })
const htmlToMd = (html) => turndownService.turndown(html)

function roundTripTest(iterations = 10) {
  let md = normalize(INITIAL_MARKDOWN)
  const driftExamples = []

  for (let i = 0; i < iterations; i += 1) {
    const html = mdToHtml(md)
    const nextMd = normalize(htmlToMd(html))
    if (nextMd !== md) {
      driftExamples.push({ step: i + 1, before: md, after: nextMd })
    }
    md = nextMd
  }

  const stabilized = driftExamples.length === 0
  return { stabilized, driftExamples, finalMarkdown: md }
}

function diffSize(a, b) {
  const max = Math.max(a.length, b.length)
  let diff = 0
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) diff += 1
  }
  return diff
}

async function aiEditTest(runs = 20) {
  const base = normalize(INITIAL_MARKDOWN)
  const url = process.env.AGENT_SERVER_URL || 'http://localhost:8787/edit'
  let success = 0
  let failures = 0
  const diffs = []

  for (let i = 0; i < runs; i += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'B', markdown: base, recentRevision: '' })
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const data = await response.json()
      const edited = normalize(data.markdown || '')
      diffs.push(diffSize(base, edited))
      success += 1
    } catch (error) {
      failures += 1
    }
  }

  return {
    runs,
    success,
    failures,
    diffSizes: diffs
  }
}

async function main() {
  const roundTrip = roundTripTest(10)
  console.log('Round-trip stabilized:', roundTrip.stabilized)
  console.log('Drift examples:', roundTrip.driftExamples.slice(0, 2))

  if (process.env.RUN_AI === 'true') {
    const ai = await aiEditTest(20)
    console.log('AI edit success rate:', `${ai.success}/${ai.runs}`)
    console.log('Diff sizes (sample):', ai.diffSizes.slice(0, 5))
  } else {
    console.log('AI edit test skipped. Set RUN_AI=true to run against agent server.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
