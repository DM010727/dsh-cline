/**
 * Cline-style pre-write edit preview for DSH.
 *
 * This ports Cline's `VscodeEditPreview` / `EditPreview` mechanism: the diff is
 * opened BEFORE the write lands (DSH intercepts the edit tool call in
 * `tools/pre-execute`), with BOTH sides virtual documents. The real file is never
 * touched by the preview. The RIGHT side is mutable: it opens showing the original
 * content, then a simulated-streaming sweep "types" the new content in line by line
 * (zipping through unchanged spans, slowing through each change) — the same
 * legacy diff-view feel Cline reproduces. The actual write happens afterward, so the
 * caller sees the change appear as DSH is about to apply it, not after.
 *
 * No external `diff` dependency: the line-diff is self-contained (common
 * prefix/suffix + bounded LCS), so the esbuild bundle stays dependency-free.
 *
 * @module @dsh-cline/extension/edit-preview
 */

import * as vscode from 'vscode'

/** URI scheme for the virtual documents backing an edit-preview diff tab. */
export const EDIT_URI_SCHEME = 'dsh-cline-edit'

/** Mutable content provider for the preview's virtual documents. */
class EditPreviewContentStore implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>()
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.emitter.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? ''
  }

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content)
    this.emitter.fire(uri)
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString())
  }
}

/** Singleton registered for EDIT_URI_SCHEME in extension.ts. */
export const editPreviewContentProvider = new EditPreviewContentStore()

let nextPreviewId = 1

/** Input to open one edit-preview diff. */
export interface EditPreviewRequest {
  /** Resolved absolute file path (used for tab labels and reveal). */
  path: string
  /** Pre-write file content ("" for a new file). */
  leftContent: string
  /** Proposed post-edit content. */
  rightContent: string
}

/** A directed line diff: whether each NEW-content line is inside a changed run. */
function changedNewLineFlags(left: string, right: string): boolean[] {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const flags = new Array<boolean>(rightLines.length).fill(false)

  // Trim the identical prefix and suffix; only the middle can differ.
  let p = 0
  while (p < leftLines.length && p < rightLines.length && leftLines[p] === rightLines[p]) p++
  let s = 0
  while (
    s < leftLines.length - p && s < rightLines.length - p &&
    leftLines[leftLines.length - 1 - s] === rightLines[rightLines.length - 1 - s]
  ) s++
  const newMidStart = p
  const newMidEnd = rightLines.length - s
  const oldMidStart = p
  const oldMidEnd = leftLines.length - s

  // No differing new lines (identical, or a pure multi-line deletion) -> nothing to flag.
  if (newMidStart >= newMidEnd) return flags

  // Bounded LCS: the middle must stay small enough for an O(n*m) DP table. Larger
  // middles fall back to flagging the whole middle as a single changed run, which
  // still animates (zip to the first change, then type) just coarser.
  const a = leftLines.slice(oldMidStart, oldMidEnd)
  const b = rightLines.slice(newMidStart, newMidEnd)
  const n = a.length
  const m = b.length
  const MAX_LCS = 1500
  if (n > MAX_LCS || m > MAX_LCS) {
    for (let i = newMidStart; i < newMidEnd; i++) flags[i] = true
    return flags
  }

  // dp[i][j] = LCS length of a[0..i) b[0..j), row-major Uint32.
  const stride = m + 1
  const dp = new Uint32Array((n + 1) * stride)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * stride + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * stride + j - 1] + 1
          : Math.max(dp[(i - 1) * stride + j], dp[i * stride + j - 1])
    }
  }
  // Backtrack: new lines that align (part of the LCS) are unchanged; the rest of the
  // middle is a change. This flags inserted and replacement lines, and skips lines
  // that line up across the edit.
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      j--
      i--
    } else if (dp[(i - 1) * stride + j] >= dp[i * stride + j - 1]) {
      i--
    } else {
      j--
    }
  }
  return flags
}

/** Prefix sums of line lengths (excluding the newlines that join() re-adds). */
function cumulativeLineLengths(lines: string[]): number[] {
  const prefixes = new Array<number>(lines.length + 1).fill(0)
  for (let i = 0; i < lines.length; i++) prefixes[i + 1] = prefixes[i] + lines[i].length
  return prefixes
}

/** One frame of the sweep. */
export interface EditPreviewFrame {
  content: string
  activeLine: number
  delayMs: number
  zip: boolean
}

export interface EditPreviewAnimation {
  frames: EditPreviewFrame[]
  /** 0-based first line in the new content where the change starts. */
  firstChangedLine: number
}

/** Cap the sweep to a bounded frame count; oversized results render immediately. */
const MAX_ANIMATION_FRAMES = 600

/**
 * Build the simulated-streaming sweep (ported from Cline's buildEditPreviewAnimation).
 * Each frame mixes a prefix of the NEW content with a suffix of the ORIGINAL, sweeping
 * top-to-bottom; unchanged spans zip, changed runs type. The last frame is exactly the
 * final content. A single-frame result means"nothing to animate".
 */
export function buildEditPreviewAnimation(left: string, right: string): EditPreviewAnimation {
  const newLines = right.split('\n')
  const originalLines = left.split('\n')
  const changed = changedNewLineFlags(left, right)
  const firstChangedLine = Math.max(0, changed.indexOf(true))
  const renderImmediately = (): EditPreviewAnimation => ({
    frames: [{ content: right, activeLine: firstChangedLine, delayMs: 0, zip: true }],
    firstChangedLine,
  })

  if (!changed.includes(true)) return renderImmediately()

  const frames: EditPreviewFrame[] = []
  const newLineLengthPrefixes = cumulativeLineLengths(newLines)
  const originalLineLengthPrefixes = cumulativeLineLengths(originalLines)
  const frameByteLength = (activeLine: number): number => {
    const newLineCount = activeLine + 1
    const originalStart = Math.min(newLineCount, originalLines.length)
    const originalLineCount = originalLines.length - originalStart
    const lineCount = newLineCount + originalLineCount
    return (
      newLineLengthPrefixes[newLineCount] +
      (originalLineLengthPrefixes[originalLines.length] - originalLineLengthPrefixes[originalStart]) +
      Math.max(0, lineCount - 1)
    ) * 2
  }

  const appendFrame = (activeLine: number, delayMs: number, zip: boolean): boolean => {
    if (frames.length + 1 > MAX_ANIMATION_FRAMES) return false
    frames.push({
      content: [...newLines.slice(0, activeLine + 1), ...originalLines.slice(activeLine + 1)].join('\n'),
      activeLine,
      delayMs,
      zip,
    })
    return true
  }

  let index = 0
  while (index < newLines.length) {
    const isChanged = changed[index]
    let runEnd = index
    while (runEnd < newLines.length && changed[runEnd] === isChanged) runEnd++
    const runLength = runEnd - index

    let stride: number
    let delayMs: number
    if (isChanged) {
      const runFrames = Math.min(runLength, 35)
      stride = Math.ceil(runLength / runFrames)
      delayMs = Math.max(45, Math.round(350 / runFrames))
    } else {
      const runFrames = Math.min(Math.ceil(runLength / 8), 18)
      stride = Math.ceil(runLength / runFrames)
      delayMs = 16
    }

    for (let line = Math.min(index + stride - 1, runEnd - 1); line < runEnd; line += stride) {
      if (!appendFrame(line, delayMs, !isChanged)) return renderImmediately()
    }
    if (frames[frames.length - 1].activeLine !== runEnd - 1) {
      if (!appendFrame(runEnd - 1, delayMs, !isChanged)) return renderImmediately()
    }
    index = runEnd
  }

  const last = frames[frames.length - 1]
  frames[frames.length - 1] = { ...last, content: right }
  return { frames, firstChangedLine }
}

/** 0-based first line where two contents differ (cheap prefix scan). */
function firstDifferingLine(left: string, right: string): number {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const max = Math.min(leftLines.length, rightLines.length)
  for (let i = 0; i < max; i++) if (leftLines[i] !== rightLines[i]) return i
  return leftLines.length === rightLines.length ? 0 : max
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Files larger than this render the final diff immediately (no sweep). */
const MAX_ANIMATED_LINES = 3000

/** The right-side diff editor for a virtual URI, once it appears after vscode.diff. */
async function findRightEditor(rightUri: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === rightUri.toString())
    if (editor) return editor
    await delay(50)
  }
  return undefined
}

/** Play the sweep on the right virtual document, then settle on the first change. */
async function animate(rightUri: vscode.Uri, left: string, right: string): Promise<void> {
  const totalLines = right.split('\n').length
  const editor = await findRightEditor(rightUri)
  if (!editor || totalLines > MAX_ANIMATED_LINES) {
    editPreviewContentProvider.set(rightUri, right)
    const firstDiff = firstDifferingLine(left, right)
    editor?.revealRange(new vscode.Range(firstDiff, 0, firstDiff, 0), vscode.TextEditorRevealType.InCenter)
    return
  }
  const { frames, firstChangedLine } = buildEditPreviewAnimation(left, right)
  if (frames.length <= 1) {
    editPreviewContentProvider.set(rightUri, right)
    editor.revealRange(new vscode.Range(firstChangedLine, 0, firstChangedLine, 0), vscode.TextEditorRevealType.InCenter)
    return
  }
  // Park at the top before the sweep, so the animation reads as starting from the top.
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop)
  await delay(300)
  for (const frame of frames) {
    editPreviewContentProvider.set(rightUri, frame.content)
    editor.revealRange(
      new vscode.Range(frame.activeLine, 0, frame.activeLine, 0),
      frame.zip ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    )
    await delay(frame.delayMs)
  }
  await delay(200)
  editor.revealRange(new vscode.Range(firstChangedLine, 0, firstChangedLine, 0), vscode.TextEditorRevealType.InCenter)
}

/**
 * Open a Cline-style pre-write edit preview and start the sweep. Never throws on a
 * cosmetic failure: the edit proceeds without a preview. Returns the opened path.
 */
export async function openEditPreview(req: EditPreviewRequest): Promise<string> {
  const path = req.path
  const previewId = nextPreviewId++
  const leftUri = vscode.Uri.parse(`${EDIT_URI_SCHEME}:${path}`).with({ query: `preview-${previewId}-left` })
  const rightUri = vscode.Uri.parse(`${EDIT_URI_SCHEME}:${path}`).with({ query: `preview-${previewId}-right` })
  // Left is immutable original; the right starts as the original and the sweep types
  // the new content in.
  editPreviewContentProvider.set(leftUri, req.leftContent)
  editPreviewContentProvider.set(rightUri, req.leftContent)

  const title = `DSH 变更 · ${baseName(path)}`
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
    preview: false,
    preserveFocus: true,
  })

  // Fire-and-forget: the sweep plays while DSH applies the write, so the change is
  // visible as it lands rather than popping in after the tool finishes.
  void animate(rightUri, req.leftContent, req.rightContent).catch((err: unknown) => {
    editPreviewContentProvider.set(rightUri, req.rightContent)
    vscode.window.showInformationMessage('DSH 变更预览动画失败: ' + String(err))
  })
  return path
}
