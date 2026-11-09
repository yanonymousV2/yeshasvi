---
title: "Building a crab buddy for Claude Code"
description: "How a Claude Code mod turns hooks into an animated Clawd above your prompt: pixel art in three rows of text, events mapped to poses, tests for a mascot, and the one state that turned out to be impossible to show."
pubDate: 2026-11-09
tags: [claude-code, typescript, plugins, terminal, pixel-art]
draft: false
---

Claude Code tells you what it's doing in text. `Read(src/date.ts)`, `Bash(npm test)`, `Update(src/date.ts)` scroll past while it works, and if you look away for a minute you have to read the transcript back to know where it got to. I wanted something I could take in at a glance from across the room: a little character who is visibly *reading*, or pacing while the tests run, or waving because Claude needs me.

Claude Code already has the character. Its mascot is Clawd, the orange pixel crab on the welcome screen. So I built **crab-buddy**, a Claude Code mod that puts Clawd right above the prompt and has him act out whatever Claude is doing.

![Clawd above the prompt: reading, sending three helpers, waving at a question, editing, yawning through a long build, finishing, compacting and dozing off](/yeshasvi/blog/crab-buddy.gif)

This post is how it's built, including one feature I shipped, tested, and then had to take out again.

## Where he lives

The first version opened Clawd in a pane beside the chat. It worked, and it felt wrong straight away. A pane is a separate app sitting next to your session. A mascot should be *in* the session.

Claude Code mods can draw into a band directly above the prompt input, the same strip where surveys appear. A mod draws there by answering the `ui.render` event for the `AbovePrompt` component:

```tsx
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  if (isHidden || e.props.hasSurvey) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  // ...draw the crab, his prop, and a caption...
})
```

Calling `next(e)` hands the band back to Claude Code, which is how `/crab` hides him and how he steps aside when a survey needs the space.

Then came the size. The first crab in the band was six rows tall and took over the bottom of the screen. Four rows looked oddly stretched. Three rows was the size where he reads as a character without pushing the conversation up.

## Pixel art in three rows of text

Clawd is a grid of 10 by 6 pixels. A terminal cell is roughly twice as tall as it is wide, so one cell can hold two square pixels stacked vertically, using the half-block characters:

| Top pixel | Bottom pixel | Character |
|---|---|---|
| on | on | `█` |
| on | off | `▀` |
| off | on | `▄` |
| off | off | space |

Six rows of pixels pack into three rows of text. Here's Clawd standing still, as pixels and then as the text the terminal shows:

```text
pixels (10 × 6)        text (10 × 3)
..........
..######..             "  ▄▄▄▄▄▄  "
..#.##.#..
##########             "▄▄█▄██▄█▄▄"
..######..
..#.##.#..             "  █▀██▀█  "
```

Every pose is a small set of choices about that grid: where the eyes are, where the arms are, which legs are down, and whether he's hopping one pixel up. The drawing function fills the body, cuts the eyes out, adds arms and legs, then packs pairs of rows into characters:

```ts
const drawCrab = (look: Look): string[] => {
  const px = Array.from({ length: H }, () => Array<boolean>(W).fill(false))
  const top = look.hop ? 0 : 1
  const fill = (row: number, from: number, to: number, isLit = true) => {
    const line = px[top + row]
    if (!line) return
    for (let col = from; col <= to; col++) line[col] = isLit
  }

  for (let row = 0; row < 4; row++) fill(row, 2, 7)
  // ...eyes, arms and legs from the look...

  const rows: string[] = []
  for (let y = 0; y < H; y += 2) {
    let line = ''
    for (let x = 0; x < W; x++) {
      const up = px[y]![x]!
      const down = px[y + 1]![x]!
      line += up && down ? '█' : up ? '▀' : down ? '▄' : ' '
    }
    rows.push(' '.repeat(look.shift) + line)
  }
  return rows
}
```

(The helper's last parameter was originally called `on`. That turned out to matter later.)

Beside the crab sits an eight-column "prop": a little page with `≡` lines while he reads, a `✎` pencil scribbling while he edits, `>_` while a command runs. To the right of that is the caption, like `Reading 3s`, with the file name under it.

## From events to poses

A Claude Code mod is a `register` function that adds hooks. Every hook gets the same three things: `$` (the engine's interface), `e` (the event), and `next` (which runs everything beneath the hook and returns the result). crab-buddy uses a handful of events.

**A turn starting** means Claude is thinking. **The model's stream** says whether it's still thinking or writing the reply, chunk by chunk:

```ts
on('turn.step', async function* ($, e, next) {
  const isFree = () => e.agentId === undefined && running.size === 0 && !waitingFor
  if (isFree()) setMode('thinking')
  for await (const chunk of next(e)) {
    if (isFree()) {
      if (chunk.kind === 'thinking') setMode('thinking')
      else if (chunk.kind === 'text') setMode('talking')
    }
    yield chunk
  }
})
```

The hook passes every chunk through untouched. It only looks.

**Tool calls** are where most of the poses come from. A small table maps each tool to a mode and a detail to show:

```ts
const forTool = (tool: string, e: object): Doing => {
  switch (tool) {
    case 'Read':
      return { mode: 'reading', detail: base(field(e, 'file_path')) }
    case 'Grep':
    case 'Glob':
      return { mode: 'searching', detail: field(e, 'pattern') || field(e, 'query') }
    case 'Edit':
    case 'Write':
      return { mode: 'editing', detail: base(field(e, 'file_path')) }
    case 'Bash':
      return { mode: 'running', detail: field(e, 'command') }
    case 'Agent':
      return { mode: 'delegating', detail: field(e, 'description') }
    case 'AskUserQuestion':
      return { mode: 'waiting', detail: 'a question for you' }
    // ...web tools, plans, MCP tools...
  }
}
```

The `tool.call` hook records the call as running, sets the pose, waits for the call to finish with `next(e)`, and then settles on whatever is still running. If the call errored, he shuts his eyes and says "Oops".

```ts
on('tool.call', async ($, e, next) => {
  const what = forTool(e.tool, e)
  running.set(e.tool_use_id, what)
  if (!waitingFor) setMode(what.mode, what.detail)
  if (what.mode === 'waiting') waitingFor = e.tool_use_id
  const ran = await next(e)
  running.delete(e.tool_use_id)
  // ...back to whatever is still running, or "Oops" on an error...
  return ran
}).catch(($, e, next) => next(e))
```

Two rules shape all of this. First, **he never changes anything**: every hook returns what `next` gave it. Second, **he never gets in the way**: the `.catch` means that if the mod's own code throws, the tool call carries on as if the mod weren't there.

Keeping a map of running calls rather than a single "current mode" pays off when Claude runs things in parallel. Three `Agent` calls at once show up as `3 helpers out` instead of the pose flickering between them.

**A clock** drives the animation. Every 300 ms a tick advances the frame counter and asks the band to redraw:

```ts
$.clock.every(FRAME_MS, () => {
  if (mode === 'idle' && Date.now() - changedAt > sleepAfterMs) setMode('sleeping')
  if ((mode === 'done' || mode === 'oops') && Date.now() - changedAt > 4000) setMode('idle')
  tick += 1
  if (!isHidden) $.ui.invalidate('ui.render')
})
```

Poses are functions of that tick. Searching eyes flick left and right every two ticks; the running crab paces with `shift`; done hops with sparkles. Time also gives him moods: idle for long enough and he dozes off with `z Z z`, and a command that's been running for over 20 seconds makes him stop pacing, slump, and yawn.

## The wave nobody could see

The state I was most pleased with was **waiting for you**. When Claude stops to ask permission, the most useful thing the crab can do is wave at you from across the room.

The first version detected permission prompts by hooking `tool.check`, the event where Claude Code decides whether a tool call needs your approval. The hook asked `next` for the decision, and if it was `ask`, set the waving pose:

```ts
on('tool.check', async ($, e, next) => {
  const verdict = await next(e)
  if (verdict.decision === 'ask') setMode('waiting', `may I use ${e.tool}?`)
  return verdict
})
```

It passed my tests. Then I submitted the mod to Anthropic's plugin directory, and its validation stopped me with two blocking findings and a policy hold. One said it couldn't confirm that the mod leaves the permission decision with the user. That's fair: from the outside, a hook on the permission check that returns a value it got from somewhere looks exactly like a hook that could change that value. A mascot has no business being anywhere near permission decisions, so I didn't argue. The other finding pointed at the drawing helper's parameter named `on`. The directory reads every use of `on` as a hook registration, and `line[col] = on` didn't look like one. Renaming it to `isLit` fixed that.

For the permission prompt, I switched to Claude Code's notification event, which fires with `notification_type: 'permission_prompt'` when the dialog appears. That's purely an observation. Validation passed, and I tried it for real.

He didn't wave.

A temporary debug toast showed the notification arriving, right on time. The mod was switching into the waving pose. The problem was simpler: **Claude Code hides the band above the prompt while the permission dialog is on screen**. The wave was happening, just behind the dialog where nobody could see it. My original `tool.check` version had the same blind spot. I'd tested that the state changed, not that a person could see it change.

So I took it out. Clawd still waves when Claude asks you a question or has a plan for you to approve, because the band stays visible around those dialogs. The README says exactly that, and nothing more. The lesson I'm keeping: for anything visual, "the code runs" and "the user sees it" are two separate checks, and only the second one counts.

## Testing a mascot

It's easy to assume a mascot can't be tested. Claude Code's plugin test kit makes it straightforward. A test can make tool calls the engine holds open, mount the band on a surface, and look for text in what the mod drew:

```tsx
test('a running Read shows Reading and the file, on every surface', async ($, on) => {
  const call = held()
  on('tool.call', () => call.done)

  const running = $.tool.call({ tool: 'Read', file_path: '/repo/src/notes.md' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Reading/ }))?.text).toMatch(/^Reading/)
    expect(await ui.find({ type: 'Text', text: 'notes.md' })).toBeTruthy()
    await ui.unmount()
  }

  call.finish()
  await running
})
```

`held()` is a tiny helper that returns a promise the test resolves when it's ready, so the call stays "running" while the test looks at the band. The suite covers reading, questions, counting parallel helpers, the setting that hides the status text, and `/crab` handing the band back to Claude Code. `claude plugin test .` runs it in under a second.

## Shipping it

A mod is a folder with a manifest, a hooks module, and optionally a `marketplace.json` that lets people install straight from the GitHub repository:

```text
/plugin install crab-buddy --marketplace yanonymousV2/crab-buddy
```

Settings live in the manifest as `userConfig`: the crab's color, how long until he dozes off, and whether to show the status text. Claude Code builds the settings screen from that, so the mod just reads the values.

I've also submitted it to Anthropic's plugin directory, where it's going through review. Besides the permission hook, the directory asked for a README section saying what each hook does, which is a good habit anyway. Anyone installing a mod that hooks every tool call deserves a plain answer to "what does it do with them?"

## The demo and the video

To show him off without asking anyone to install anything, I ported the pose and pixel code to a browser canvas for a [playable demo](/yeshasvi/crab-buddy/). The same `lookFor` switch and the same 10×6 grid draw him there, one canvas rectangle per pixel instead of half-block characters. You can press a state, type a prompt and watch a scripted session, or type `/compact` to squash him.

The GIF and the launch video are a Python port of the same code, printing frames to a real terminal that [vhs](https://github.com/charmbracelet/vhs) records. The first recordings had occasional torn frames, where the top half of the screen showed one frame and the bottom half the next. The fix was a terminal feature called synchronized output: wrap each frame in `\x1b[?2026h` and `\x1b[?2026l`, and the terminal holds off painting until the whole frame has arrived.

## Try him

Install crab-buddy with the line above, or [play with the demo](/yeshasvi/crab-buddy/) first. The code is on [GitHub](https://github.com/yanonymousV2/crab-buddy) under MIT, and the hooks are short enough to read in one sitting if you want to build a mod of your own.

*crab-buddy is an unofficial fan project, not affiliated with or endorsed by Anthropic. Clawd is Claude Code's mascot.*
