// dsh-step-confirm —「逐步确认」权限挡位。
//
// 契约：只有“读工作区（会话 cwd）”是免费的。写文件、读工作区外、
// 执行任何命令、联网、切换工作目录，都在 tools/pre-execute 里被改判
// 为 ask，交给宿主走既有审批链路——dsh-approval-comment 的卡片、附言、
// 拒绝即停轮因此自动生效。
//
// 只对 permissionPresets.current(session) === 'step-confirm' 的会话生效；
// 其余档位一律 next()，不改变任何现有行为。

import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-step-confirm'
export const inject = ['sessions', 'workingDirectory', 'permissionPresets', 'systemPrompt', 'agents']

const PRESET = 'step-confirm'
const MAX_LINE = 120

/** 不接触文件系统的元操作：永远免费。 */
const FREE_TOOLS = new Set([
  'todo_write',
  'ask_user_question',
  'present',
  'skill',
  'load_workspace_dependencies',
  'get_goal',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'job_list',
  'job_output',
  'job_kill',
  'schedule_list',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'list_agents',
  'send_message',
  'interrupt_agent',
])

/** 读类工具：参数名 -> 取值函数。缺省路径按 cwd 处理。 */
const READ_TOOLS = {
  read: (args) => args?.file_path,
  read_image: (args) => args?.file_path,
  grep: (args) => args?.path,
  glob: (args) => args?.path,
}

const PROMPT = `当前为「逐步确认」模式。只有"读工作区"是免费的，其余都要用户逐次批准。

免费（全部）：
- 用 read / glob / grep / read_image 读取工作区内的路径。
- 不接触文件的元操作：写待办、提问、展示文件、管理提醒。

需要批准：
- 写任何文件，包括工作区内的。
- 读工作区外的路径。
- 执行任何命令，无论它只读工作区还是什么都不读。
- 联网获取或搜索。
- 切换工作目录。

约束：
- 一次只申请一个动作。
- 每次申请都是用户的一次中断；能用免费动作解决的，不要申请。
- 不要为了解状态而跑命令；需要判断时直接问。
- 不建议委派子代理（本模式下可能无人应答，会失败）。`

function sessionOf(ctx, agent) {
  if (!agent || typeof agent.id !== 'string') return undefined
  try {
    return ctx.sessions.get(agent.id)
  } catch {
    return undefined
  }
}

function inMode(ctx, session) {
  try {
    return ctx.permissionPresets.current(session) === PRESET
  } catch {
    return false
  }
}

/** 按真实路径规范化，消掉符号链接、junction 和 `..`。 */
function canonical(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    // 目标不存在（新建文件）：解析父目录再拼回名字。
  }
  try {
    return path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target))
  } catch {
    return path.resolve(target)
  }
}

function absolute(cwd, p) {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

/** Windows 路径不区分大小写，比较前统一小写。 */
function inside(root, target) {
  const r = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase()
  const t = path.resolve(target).toLowerCase()
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

function globEscapes(args) {
  const pattern = String(args?.pattern ?? '')
  const base = String(args?.path ?? '')
  if (path.isAbsolute(pattern)) return true
  const parts = (value) => value.split(/[\\/]+/).filter(Boolean)
  return parts(pattern).includes('..') || parts(base).includes('..')
}

/** 返回审批卡首行；返回 undefined 表示该动作免费。 */
function reasonFor(ctx, session, exec) {
  const tool = exec.name
  const args = exec.arguments ?? {}
  const cwd = ctx.workingDirectory.get(session)

  if (tool === 'working_directory') {
    const cd = args?.cd
    if (typeof cd !== 'string' || cd.trim() === '') return undefined
    return `切换工作目录 · ${canonical(absolute(cwd, cd.trim()))}`
  }

  if (Object.hasOwn(READ_TOOLS, tool)) {
    if (tool === 'glob' && globEscapes(args)) {
      return `读取工作区外 · ${String(args?.pattern ?? '')}`
    }
    const raw = READ_TOOLS[tool](args)
    const target = canonical(absolute(cwd, typeof raw === 'string' && raw !== '' ? raw : '.'))
    return inside(cwd, target) ? undefined : `读取工作区外 · ${target}`
  }

  if (tool === 'write' || tool === 'edit') {
    const p = args?.file_path
    if (typeof p !== 'string' || p === '') return '写入 · （未提供路径）'
    const target = canonical(absolute(cwd, p))
    let state = '新建'
    try {
      if (fs.existsSync(target)) state = '覆盖'
    } catch {
      /* 判断不了就当新建，不影响审批 */
    }
    return `写入 · ${target}（${state}）`
  }

  if (tool === 'pwsh') {
    const lines = String(args?.command ?? '').split(/\r?\n/)
    const head = lines[0].length <= MAX_LINE ? lines[0] : `${lines[0].slice(0, MAX_LINE)}…`
    const extra = lines.length - 1
    return `执行命令 · ${head}${extra > 0 ? `…（另有 ${extra} 行）` : ''}`
  }

  if (tool === 'web_fetch') return `联网获取 · ${String(args?.url ?? '')}`

  if (tool === 'web_search') {
    const queries = Array.isArray(args?.queries) ? args.queries : []
    return `联网搜索 · ${String(queries[0] ?? '')}`
  }

  return `调用工具 · ${tool}`
}

export function apply(ctx) {
  try {
    ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        const session = sessionOf(ctx, exec.agent)
        if (!session || !inMode(ctx, session)) return next()
        if (FREE_TOOLS.has(exec.name)) return next()

        let reason
        try {
          reason = reasonFor(ctx, session, exec)
        } catch {
          // 判定失败时宁可多问一次，也不放行。
          reason = `逐步确认 · 无法判定「${exec.name}」，请人工确认`
        }
        return reason ? { kind: 'ask', reason } : next()
      },
      { prepend: true },
    )

    // 用 runtime context 而不是 section：section 属于“已接受的组装”，重启后
    // 首次组装发生在会话状态恢复之前，会整场缺失；context 每次请求都会刷新。
    ctx.systemPrompt.context({
      name: 'step-confirm',
      order: 850,
      required: true,
      text: (context) => {
        let agent = context?.scope
        if (!agent || typeof agent.id !== 'string') {
          // 新会话/恢复会话的首轮可能没有 scope，退回当前的发起 Agent。
          try {
            agent = ctx.agents.currentInitiator()
          } catch {
            agent = undefined
          }
        }
        const session = sessionOf(ctx, agent)
        return session && inMode(ctx, session) ? PROMPT : ''
      },
    })
  } catch (error) {
    // 启动阶段绝不炸掉整个 profile：最坏情况是门禁没装上。
    ctx.logger?.warn?.('dsh-step-confirm 安装失败', error)
  }
}
