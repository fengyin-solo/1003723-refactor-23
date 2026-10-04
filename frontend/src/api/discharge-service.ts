import { buildChecklist, evaluateDischarge } from '@/domain/discharge/evaluate'
import { checklistToCsv } from '@/domain/discharge/checklist-csv'
import { DISCHARGE_RULES, ConflictError, guardTransition, runOnce } from '@/domain/discharge/workflow'
import type { Checklist, ConclusionLevel, DischargeEvaluation, MeasureField } from '@/domain/discharge/types'
import { downloadTextFile } from '@/api/download'
import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const MODULE_KEY = 'discharge'
const LEVEL_TEXT: Record<ConclusionLevel, string> = { pass: '通过', warning: '预警', fail: '不通过' }

export interface SnapshotMeta {
  scope: string
  generatedAt: string
  conclusion: ConclusionLevel
  summary: string
}

export interface DischargeRowView {
  row: EntryRow
  evaluation: DischargeEvaluation
  availableActions: string[]
}

export function listDischarge(filters: Record<string, string> = {}): DischargeRowView[] {
  return filterRows(listRows(MODULE_KEY), filters).map((row) => ({
    row,
    evaluation: evaluateDischarge(row),
    availableActions: availableActionNames(String(row.status)),
  }))
}

export function getDischarge(id: number): DischargeRowView | null {
  const row = listRows(MODULE_KEY).find((candidate) => Number(candidate.id) === id)
  if (!row) {
    return null
  }
  return { row, evaluation: evaluateDischarge(row), availableActions: availableActionNames(String(row.status)) }
}

function availableActionNames(status: string): string[] {
  return DISCHARGE_RULES.filter((rule) => rule.from.includes(status)).map((rule) => rule.action)
}

export function fieldText(row: EntryRow, field: MeasureField): string {
  const evaluation = evaluateDischarge(row)
  const parsed = evaluation.backfill.parsed[field]
  const standardValue = evaluation.backfill.values[field]
  if (standardValue === null) {
    return parsed.raw || '—'
  }
  const unit = field === '断面流量' ? 'm³/s' : field === '最大流速' ? 'm/s' : 'm²'
  const suffix = parsed.converted ? '（旧单位已换算）' : evaluation.backfill.computed.includes(field) ? '（补算）' : ''
  return `${standardValue} ${unit}${suffix}`
}

export function methodText(row: EntryRow): string {
  const evaluation = evaluateDischarge(row)
  if (!evaluation.method) {
    return evaluation.methodRaw || '—'
  }
  return evaluation.legacy ? `${evaluation.methodRaw} → ${evaluation.method}` : evaluation.method
}

export function levelText(level: ConclusionLevel): string {
  return LEVEL_TEXT[level]
}

export function readSnapshot(row: EntryRow): Checklist | null {
  const raw = row.核对清单快照
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(String(raw)) as Checklist
  } catch {
    return null
  }
}

export function snapshotMeta(row: EntryRow): SnapshotMeta | null {
  const snapshot = readSnapshot(row)
  if (!snapshot) {
    return null
  }
  const item = snapshot.items.find((candidate) => candidate.id === Number(row.id))
  return {
    scope: snapshot.scope,
    generatedAt: snapshot.generatedAt,
    conclusion: item?.conclusion ?? 'fail',
    summary: item?.summary ?? '',
  }
}

function patchDischargeRow(row: EntryRow, status: string, checklist?: Checklist): EntryRow {
  const next: EntryRow = {
    ...row,
    status,
    pending: status !== '已通过',
    abnormal: status === '异常值',
    记录状态: status,
  }
  if (checklist) {
    const item = checklist.items.find((candidate) => candidate.id === Number(row.id))
    next.核对结论 = item ? LEVEL_TEXT[item.conclusion] : ''
    next.核对清单快照 = JSON.stringify(checklist)
  }
  return next
}

/**
 * 流量记录动作：状态机把关越级/重复，审核类动作走单飞；
 * 提交审核时先跑统一核对（fail 拒绝），通过后才生成清单快照并整包保存。
 */
export async function transitionDischarge(id: number, action: string): Promise<ActionResult> {
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((candidate) => Number(candidate.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的流量记录` }
  }
  const row = rows[index]
  const guard = guardTransition(DISCHARGE_RULES, String(row.status), action)
  if (!guard.ok) {
    return { ok: false, message: guard.message }
  }
  const rule = guard.rule
  try {
    const updated = await runOnce(`${MODULE_KEY}:${id}`, async () => {
      const evaluation = evaluateDischarge(row)
      if (rule.kind === 'submit' && evaluation.conclusion === 'fail') {
        throw new Error(`提交审核被拒：核对结论为「不通过」，请先处理（${evaluation.checks
          .filter((item) => item.level === 'fail')
          .map((item) => item.label)
          .join('、')}），或直接标记异常`)
      }
      if (rule.kind === 'approve') {
        if (evaluation.conclusion !== 'pass') {
          throw new Error(`确认通过被拒：当前核对结论为「${LEVEL_TEXT[evaluation.conclusion]}」，仅「通过」可刊印`)
        }
        const snapshot = readSnapshot(row)
        if (snapshot) {
          const item = snapshot.items.find((candidate) => candidate.id === id)
          if (item && item.conclusion !== 'pass') {
            throw new Error('确认通过被拒：提交审核时留存的核对清单结论不是「通过」，请按最新数据重新提交')
          }
        }
      }
      const checklist =
        rule.kind === 'submit' ? buildChecklist([row], `流量记录 ${evaluation.recordNo} 提交审核`) : undefined
      return patchDischargeRow(row, rule.to, checklist)
    })
    const next = [...rows]
    next[index] = updated
    saveRows(MODULE_KEY, next)
    return { ok: true, message: `流量记录已${action}，当前状态「${rule.to}」` }
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: error instanceof Error ? error.message : `${action}失败，状态未改动` }
  }
}

/** 该入口一并产出核对清单：列表页直接导出当前全部流量记录的统一清单。 */
export function buildDischargeChecklist(scope = '流量监测全部记录'): Checklist {
  return buildChecklist(listRows(MODULE_KEY), scope)
}

export function downloadDischargeChecklist(): void {
  const checklist = buildDischargeChecklist()
  downloadTextFile(`流量监测-核对清单-${checklist.generatedAt.slice(0, 10)}.csv`, checklistToCsv(checklist))
}
