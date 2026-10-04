import type { ConclusionLevel } from './types'

// 审核链路统一状态机：动作只允许从指定源状态发起，任何越级、回退、重复推进都在这里被拒绝。

export type AdvanceKind = 'submit' | 'approve' | 'reject'

export interface TransitionRule {
  action: string
  from: string[]
  to: string
  kind: AdvanceKind
  /** 审批动作需要的核对结论门槛；warning 也算不过，必须先「标记异常」处理。 */
  gate?: ConclusionLevel[]
}

// 流量记录：已采集 ->(提交审核) 待审核 ->(确认通过) 已通过；任意在途态可标记异常。
export const DISCHARGE_RULES: TransitionRule[] = [
  { action: '提交审核', from: ['已采集'], to: '待审核', kind: 'submit' },
  { action: '确认通过', from: ['待审核'], to: '已通过', kind: 'approve', gate: ['pass'] },
  { action: '标记异常', from: ['已采集', '待审核'], to: '异常值', kind: 'reject' },
]

// 整编成果：待整编 -> 整编中 -> 待审核 -> 已刊印；整编中可驳回。
export const COMPILATION_RULES: TransitionRule[] = [
  { action: '开始整编', from: ['待整编'], to: '整编中', kind: 'submit' },
  { action: '提交审核', from: ['整编中'], to: '待审核', kind: 'submit', gate: ['pass', 'warning'] },
  { action: '驳回整编', from: ['整编中'], to: '已驳回', kind: 'reject' },
]

export type GuardResult =
  | { ok: true; rule: TransitionRule }
  | { ok: false; message: string }

export function guardTransition(rules: TransitionRule[], status: string, action: string): GuardResult {
  const rule = rules.find((item) => item.action === action)
  if (!rule) {
    return { ok: false, message: `未登记「${action}」动作` }
  }
  if (status === rule.to) {
    return { ok: false, message: `当前已经是「${status}」，无需重复操作` }
  }
  if (!rule.from.includes(status)) {
    return {
      ok: false,
      message: `「${action}」只能在 ${rule.from.map((item) => `「${item}」`).join('或')} 发起，当前为「${status}」，越级操作已拒绝`,
    }
  }
  return { ok: true, rule }
}

/**
 * 并发审核单飞：同一锁键（模块+记录）同时只推进一次。
 * 纯前端同步存储挡不住两个宏任务挤进来，这里先占锁、await 一个微任务让出，
 * 让并发的第二个调用看到占用后直接失败，绝不产生第二次状态推进。
 */
const inflight = new Set<string>()

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

function nextTick(): Promise<void> {
  return Promise.resolve()
}

export async function runOnce<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  if (inflight.has(lockKey)) {
    throw new ConflictError('该记录正在审核推进中，请勿重复提交（并发审核只推进一次）')
  }
  inflight.add(lockKey)
  await nextTick()
  try {
    return await task()
  } finally {
    inflight.delete(lockKey)
  }
}
