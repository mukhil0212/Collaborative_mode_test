import '@tiptap/core'

declare module '@tiptap/core' {
  interface Editor {
    getMarkdown: () => string
  }
}
