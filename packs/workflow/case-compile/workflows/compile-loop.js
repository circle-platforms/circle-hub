export const meta = {
  name: 'compile-loop',
  description: '照 pipeline.ts 的输出派发重组、编写和保真盲审子代理，每个结束时过关口、补位，直到没有在跑和待派的',
  whenToUse: 'case-compile 第 0 节：pipeline.ts init、retry 或 rework 之后',
  phases: [{ title: '重组' }, { title: '编写' }, { title: '审计' }],
}
const path = args?.pipeline
const stateFile = args?.state ?? 'pipeline.json'
for (const [name, value] of [['pipeline', path], ['state', stateFile]])
  if (typeof value !== 'string' || !value.trim() || /['\\\n]/.test(value))
    throw new Error(`args.${name} 要写成不含单引号、反斜杠和换行的路径：pipeline 是技能目录下的 tools/pipeline.ts，state 是工作目录里的状态文件`)
const tool = `node '${path}'`
const state = `--state '${stateFile}'`

async function runCommand(command, label) {
  const ran = await execute(command, { timeout: 600, label })
  const output = String(ran.output ?? '')
  const line = output.split('\n').map((text) => text.trim()).findLast((text) => text.startsWith('{'))
  if (ran.code === 0 && line !== undefined) {
    try { return JSON.parse(line) } catch {}
  }
  throw new Error(`pipeline.ts ${label} 没有完成（退出码 ${ran.code}）：${output.slice(-800)}`)
}

// The state file says who judges this compile, and the commands below name Plumb's address only when Plumb does. Standard input
// keeps both lines either way: pipeline.cli.json declares two lines for each of these sub-commands and the guard checks the count.
const judgedBy = (await runCommand(`${tool} judge ${state}`, 'judge')).judge
if (judgedBy !== 'plumb' && judgedBy !== 'model')
  throw new Error(`pipeline.ts judge 答的判断方式是 ${JSON.stringify(judgedBy)}，应当是 plumb 或 model`)
const services = `--hub %HUB_URL% ${judgedBy === 'plumb' ? '--plumb %PLUMB_URL% ' : ''}<<'EOF'\n%HUB_TOKEN%\n%PLUMB_API_KEY%\nEOF`
const ask = (words, label) => runCommand(`${tool} ${words} ${services}`, label)

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
let step = start(await ask(`resume ${state}`, 'resume'))
let broken = 0
let interrupted
for (let pauses = 0; ; ) {
  if (running.size) {
    const { action, byItself } = await Promise.race([...running.values()])
    const label = action.label
    if (!byItself) {
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
    const after = await ask(`next ${state} --finished '${label}'`, `处理 ${label} 的结果`)
    running.delete(label)
    step = start(after)
    pauses = 0
    continue
  }
  const waiting = (step.waiting ?? []).length
  if (!waiting && !(step.running ?? []).length) break
  if (++pauses > 40) break
  step = start(await ask(`resume ${state}${waiting ? ' --pause 60' : ''}`, waiting ? '等服务恢复' : 'resume'))
}
const { actions, ...result } = step
if (interrupted) result.interrupted = interrupted
log(interrupted ?? result.message)
return result
