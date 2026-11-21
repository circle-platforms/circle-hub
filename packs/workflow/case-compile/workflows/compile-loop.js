export const meta = {
  name: 'compile-loop',
  description: '照 pipeline.ts 的输出派发重组、编写和保真盲审子代理，每个结束时过关口、补位，直到没有在跑和待派的',
  whenToUse: 'case-compile 第 0 节：pipeline.ts init、retry 或 rework 之后',
  phases: [{ title: '重组' }, { title: '编写' }, { title: '审计' }],
}
// The loop of the per-case pipeline, with no model between two steps. pipeline.ts keeps the state and decides everything:
// which case is recomposed, written or audited next, what passes a gate, what is tried again. This script starts the
// subagents it names and tells it when one has ended. It begins by asking what should be running (resume), so it is
// started the same way after init, after retry, after rework, and after a run of it that was cut short.
// args: { pipeline: '<技能目录>/tools/pipeline.ts', state: 'pipeline.json' }
// The args as an object, or the same object written as JSON text: a model may write a tool argument that has no type as text.
let given = args ?? {}
if (typeof given === 'string') {
  try { given = JSON.parse(given) } catch { given = {} }
}
const path = given.pipeline
const stateFile = given.state ?? 'pipeline.json'
for (const [name, value] of [['pipeline', path], ['state', stateFile]])
  if (typeof value !== 'string' || !value.trim() || /['\\\n]/.test(value))
    throw new Error(`args.${name} 要写成不含单引号、反斜杠和换行的路径：pipeline 是技能目录下的 tools/pipeline.ts，state 是工作目录里的状态文件`)
const tool = `node '${path}'`
const state = `--state '${stateFile}'`
// The values come in where the command runs, as they do for a command the conversation itself runs.
const services = "--hub %HUB_URL% --plumb %PLUMB_URL% <<'EOF'\n%HUB_TOKEN%\n%PLUMB_API_KEY%\nEOF"

// One call of the tool: the step is the last line of what it printed that is JSON.
async function call(words, label) {
  const ran = await execute(`${tool} ${words} ${services}`, { timeout: 600, label })
  const output = String(ran.output ?? '')
  const line = output.split('\n').map((text) => text.trim()).filter((text) => text.startsWith('{')).at(-1)
  let step
  try { step = line === undefined ? undefined : JSON.parse(line) } catch { step = undefined }
  return { step: ran.code === 0 ? step : undefined, output, code: ran.code }
}
async function ask(words, label) {
  const ran = await call(words, label)
  if (!ran.step) throw new Error(`pipeline.ts ${label} 没有完成（退出码 ${ran.code}）：${ran.output.slice(-800)}`)
  return ran.step
}

// label -> a promise of { action, byItself } for when its subagent is over. byItself is false when it did not end by itself: its
// model failed for good, or it was stopped. The tool is then not told that it ended, so a case is not charged an attempt for a
// model service that is down; the same task is started again.
const running = new Map()
function launch(action) {
  running.set(
    action.label,
    agent(action.description, { agentType: action.subagent_type, label: action.label, phase: action.label.split(' ')[0] }).then(
      (value) => ({ action, byItself: value !== null }),
      () => ({ action, byItself: false }),
    ),
  )
}
function start(step) {
  for (const action of step.actions ?? []) if (!running.has(action.label)) launch(action)
  return step
}
// A subagent has ended: the tool runs its gates and names what starts next. Of one that wrote nothing the tool is told that
// it ended, which it takes only half a minute after the dispatch.
async function ended(label) {
  const first = await ask(`next ${state} --finished '${label}'`, `next ${label}`)
  if (!(first.not_written ?? []).includes(label)) return first
  start(first)
  for (let tries = 1; ; tries++) {
    const ran = await call(`next ${state} --finished '${label}' --ended yes`, `next ${label}（没有写出）`)
    if (ran.step) return ran.step
    if (tries >= 3 || !/不会这么快结束/.test(ran.output))
      throw new Error(`pipeline.ts next ${label} --ended yes 没有完成（退出码 ${ran.code}）：${ran.output.slice(-800)}`)
    start(await ask(`resume ${state} --pause 31`, '等 31 秒'))
  }
}

let step = start(await ask(`resume ${state}`, 'resume'))
// Subagents in a row that did not end by themselves, and why the run ended early because of them.
let broken = 0
let interrupted
for (let pauses = 0; ; ) {
  if (running.size) {
    const { action, byItself } = await Promise.race([...running.values()])
    const label = action.label
    if (!byItself) {
      // The same task again after a pause that grows with each one in a row; the sixth ends the run with the state as it is.
      if (++broken >= 6) {
        interrupted = `子代理连续 ${broken} 次没有跑成（模型服务出错，或被停下）：流水线状态没有动，没有一条用例为此耗次数；服务恢复后照第 0 节再启动一次循环`
        break
      }
      step = start(await ask(`resume ${state} --pause ${Math.min(60 * broken, 300)}`, `${label} 没有跑成，稍后再派`))
      running.delete(label)
      launch(action)
      continue
    }
    broken = 0
    const after = await ended(label)
    // Only now: the step may name the same label again, a new attempt of the same stage
    running.delete(label)
    step = start(after)
    pauses = 0
    continue
  }
  // Nothing runs here. A case whose gate waits for a service is looked at again after a minute, forty times at most; a case
  // the state holds as running that this run never started is started by the same call.
  const waiting = (step.waiting ?? []).length
  if (!waiting && !(step.running ?? []).length) break
  if (++pauses > 40) break
  step = start(await ask(`resume ${state}${waiting ? ' --pause 60' : ''}`, waiting ? '等服务恢复' : 'resume'))
}
const { actions, ...result } = step
if (interrupted) result.interrupted = interrupted
log(interrupted ?? result.message)
return result
