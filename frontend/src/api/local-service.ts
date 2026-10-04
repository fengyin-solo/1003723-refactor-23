import {
  buildDischargeReport,
  checkCompilationGate,
  checkDischargeGate,
  evaluateEntry,
} from '@/domain/discharge'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 在途锁：同一记录同一时刻只允许一个动作落地，并发审核只推进一次。
const inflightKeys = new Set<string>()

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 当前状态下可执行的动作：未声明 actionFrom 的模块沿用旧规则（全部可执行）。 */
export function availableActions(meta: ModuleMeta, status: string): string[] {
  return meta.actions.filter((action) => {
    const allowed = meta.actionFrom?.[action]
    return !allowed || allowed.includes(status)
  })
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 状态机校验：声明了 actionFrom 的动作只能从指定来源状态推进，越级直接拒绝。
 * 校验失败时不动数据，由调用方保证不留半份状态。
 */
function assertTransition(meta: ModuleMeta, action: string, current: string): ActionResult | null {
  const allowed = meta.actionFrom?.[action]
  if (!allowed) {
    return null
  }
  if (allowed.includes(current)) {
    return null
  }
  const target = meta.actionTargets[action]
  return {
    ok: false,
    message: `越级操作已拒绝：${meta.entity}当前为「${current}」，「${action}」只能从「${allowed.join('、')}」推进到「${target}」`,
  }
}

/**
 * 业务闸门：各模块的专属判定收敛到这里，统一复用 domain 里的判定结果。
 * 流量动作与整编送审都以同一份校核结论为准。
 */
function businessGate(key: string, action: string, row: EntryRow): ActionResult | null {
  if (key === 'discharge') {
    const gate = checkDischargeGate(action, evaluateEntry(row))
    return gate.allow ? null : { ok: false, message: gate.message }
  }
  if (key === 'compilation' && action === '提交审核') {
    const gate = checkCompilationGate(buildDischargeReport(listRows('discharge')))
    return gate.allow ? null : { ok: false, message: gate.message }
  }
  return null
}

function applyAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 所有校验先跑完，全部通过才写入；任一失败直接返回，不留半份状态。
  const transitionError = assertTransition(meta, action, current)
  if (transitionError) {
    return transitionError
  }
  const gateError = businessGate(key, action, rows[index])
  if (gateError) {
    return gateError
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    // 目标态即异常值，或动作属于驳回/作废类往回走，都计入看板异常量。
    abnormal: target.includes('异常') || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  return applyAction(key, id, action)
}

/**
 * 带在途锁的动作入口：同一记录并发调用时，只有第一个能推进，其余当场拒绝；
 * 锁在 Promise 落定后释放。配合状态机校验，跨点击的重复提交也会被越级/重复态拦截。
 */
export async function runActionSerialized(key: string, id: number, action: string): Promise<ActionResult> {
  const lockKey = `${key}:${id}`
  if (inflightKeys.has(lockKey)) {
    return { ok: false, message: '该记录有正在处理的动作，并发审核只推进一次，请勿重复提交' }
  }
  inflightKeys.add(lockKey)
  try {
    // 让出一个微任务：同一批次并发的调用都会先撞到锁，而不是串行地都落地。
    await Promise.resolve()
    return applyAction(key, id, action)
  } finally {
    inflightKeys.delete(lockKey)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadText(filename, content)
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
