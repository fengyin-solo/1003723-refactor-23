import { buildChecklist, evaluateDischarge } from '@/domain/discharge/evaluate'
import { checklistToCsv } from '@/domain/discharge/checklist-csv'
import { COMPILATION_RULES, ConflictError, guardTransition, runOnce } from '@/domain/discharge/workflow'
import type { Checklist, DischargeEvaluation, MeasureField } from '@/domain/discharge/types'
import { downloadTextFile } from '@/api/download'
import { filterRows } from '@/api/local-service'
import { levelText } from '@/api/discharge-service'
import { commitRows, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

export { levelText }

const MODULE_KEY = 'compilation'
const DISCHARGE_KEY = 'discharge'
const SNAPSHOT_KEY = '核对清单快照'

export interface CompilationRowView {
  row: EntryRow
  evaluations: DischargeEvaluation[]
  checklist: Checklist | null
  availableActions: string[]
}

function stationOf(row: EntryRow): string {
  return String(row.站点编号 ?? '').trim()
}

function yearOf(row: EntryRow): string {
  return String(row.整编年份 ?? '').trim()
}

function recordYear(row: EntryRow): string {
  return String(row.测量时间 ?? '').slice(0, 4)
}

/** 整编范围：按整编年份 + 站点编号圈定该成果要收纳的流量记录。 */
export function dischargeForCompilation(compilationRow: EntryRow): EntryRow[] {
  const station = stationOf(compilationRow)
  const year = yearOf(compilationRow)
  return listRows(DISCHARGE_KEY).filter(
    (row) => stationOf(row) === station && (!year || recordYear(row) === year),
  )
}

export function listCompilation(filters: Record<string, string> = {}): CompilationRowView[] {
  return filterRows(listRows(MODULE_KEY), filters).map((row) => {
    const rows = dischargeForCompilation(row)
    const snapshotRaw = row[SNAPSHOT_KEY]
    let checklist: Checklist | null = null
    if (snapshotRaw) {
      try {
        checklist = JSON.parse(String(snapshotRaw)) as Checklist
      } catch {
        checklist = null
      }
    }
    return {
      row,
      evaluations: rows.map(evaluateDischarge),
      checklist,
      availableActions: COMPILATION_RULES.filter((rule) => rule.from.includes(String(row.status))).map(
        (rule) => rule.action,
      ),
    }
  })
}

export function getCompilation(id: number): CompilationRowView | null {
  const row = listRows(MODULE_KEY).find((candidate) => Number(candidate.id) === id)
  if (!row) {
    return null
  }
  const rows = dischargeForCompilation(row)
  const snapshotRaw = row[SNAPSHOT_KEY]
  let checklist: Checklist | null = null
  if (snapshotRaw) {
    try {
      checklist = JSON.parse(String(snapshotRaw)) as Checklist
    } catch {
      checklist = null
    }
  }
  return {
    row,
    evaluations: rows.map(evaluateDischarge),
    checklist,
    availableActions: COMPILATION_RULES.filter((rule) => rule.from.includes(String(row.status))).map(
      (rule) => rule.action,
    ),
  }
}

const SI_UNIT: Record<MeasureField, string> = {
  断面流量: 'm³/s',
  最大流速: 'm/s',
  过水面积: 'm²',
}

/** 整编提交时把统一补算结果写回流量记录：只在整编链路落一次，历史已通过记录原样保留。 */
function applyBackfillToDischarge(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const evaluation = evaluateDischarge(row)
    if (evaluation.historical) {
      return row
    }
    const next: EntryRow = { ...row }
    for (const field of ['断面流量', '最大流速', '过水面积'] as MeasureField[]) {
      const value = evaluation.backfill.values[field]
      if (value !== null) {
        next[field] = `${value} ${SI_UNIT[field]}`
      }
    }
    next.补算结果 = evaluation.backfill.computed.length
      ? `按Q=v·A补算：${evaluation.backfill.computed.join('、')} @ ${new Date().toISOString()}`
      : `三量齐全，未触发补算 @ ${new Date().toISOString()}`
    return next
  })
}

/**
 * 整编成果动作。提交审核是跨模块动作：成果状态 + 流量记录补算结果 + 核对清单快照
 * 通过 commitRows 一次性原子提交，任何一步失败整批不生效，绝不留下半份状态。
 */
export async function transitionCompilation(id: number, action: string): Promise<ActionResult> {
  const compilationRows = listRows(MODULE_KEY)
  const index = compilationRows.findIndex((candidate) => Number(candidate.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的整编成果` }
  }
  const compilationRow = compilationRows[index]
  const guard = guardTransition(COMPILATION_RULES, String(compilationRow.status), action)
  if (!guard.ok) {
    return { ok: false, message: guard.message }
  }
  const rule = guard.rule
  try {
    await runOnce(`${MODULE_KEY}:${id}`, async () => {
      const scope = `整编成果 ${String(compilationRow.成果编号 ?? id)}（${yearOf(compilationRow)}年 · ${stationOf(compilationRow)}）`
      const inScope = dischargeForCompilation(compilationRow)
      let checklist: Checklist | null = null
      if (rule.kind === 'submit') {
        if (!inScope.length) {
          throw new Error('提交审核被拒：该成果范围内没有可整编的流量记录')
        }
        checklist = buildChecklist(inScope, scope)
        if (checklist.fail > 0) {
          const failed = checklist.items
            .filter((item) => item.conclusion === 'fail')
            .map((item) => item.recordNo)
            .join('、')
          throw new Error(`提交审核被拒：范围内 ${failed} 核对不通过，请先在流量监测处理或标记异常后再整编`)
        }
      }
      if (rule.kind === 'approve') {
        // 整编元数据里没有配置审批入口；保留门槛，防止未来越级直接刊印。
        throw new Error('整编成果刊印请走整编审批入口')
      }

      const nextCompilationRows = [...compilationRows]
      nextCompilationRows[index] = {
        ...compilationRow,
        status: rule.to,
        pending: rule.to !== '已刊印',
        abnormal: rule.to === '已驳回',
        整编状态: rule.to,
        关联记录数: checklist ? checklist.total : compilationRow.关联记录数,
        核对结论: checklist
          ? `通过${checklist.pass} / 预警${checklist.warning} / 不通过${checklist.fail}`
          : compilationRow.核对结论,
        ...(checklist ? { [SNAPSHOT_KEY]: JSON.stringify(checklist) } : {}),
      }

      if (rule.kind === 'submit' && checklist) {
        // 原子提交：成果状态、补算回写、清单快照同时落地。
        const currentDischarge = listRows(DISCHARGE_KEY)
        const patchedById = new Map(applyBackfillToDischarge(inScope).map((row) => [Number(row.id), row]))
        commitRows({
          [MODULE_KEY]: nextCompilationRows,
          [DISCHARGE_KEY]: currentDischarge.map((row) => patchedById.get(Number(row.id)) ?? row),
        })
      } else {
        commitRows({ [MODULE_KEY]: nextCompilationRows })
      }
    })
    return { ok: true, message: `整编成果已${action}，当前状态「${rule.to}」` }
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: error instanceof Error ? error.message : `${action}失败，状态未改动` }
  }
}

export function downloadCompilationChecklist(id: number): ActionResult {
  const view = getCompilation(id)
  if (!view) {
    return { ok: false, message: '没有找到该整编成果' }
  }
  const scope = `整编成果 ${String(view.row.成果编号 ?? id)}`
  const checklist = view.checklist ?? buildChecklist(dischargeForCompilation(view.row), `${scope}（实时）`)
  downloadTextFile(
    `整编成果-${String(view.row.成果编号 ?? id)}-核对清单.csv`,
    checklistToCsv(checklist),
  )
  return { ok: true, message: '核对清单已导出' }
}
