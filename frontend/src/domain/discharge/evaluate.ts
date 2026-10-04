import { resolveMethod } from './methods'
import { backfillMeasures } from './measures'
import type {
  CheckItem,
  Checklist,
  ChecklistItem,
  ConclusionLevel,
  DischargeEvaluation,
  MeasureField,
} from './types'
import type { EntryRow } from '@/data/types'

const CONSISTENCY_TOLERANCE = 0.1 // Q 与 v·A 偏差超过 10% 判预警
const MIN_INPUTS = 2 // 三量至少录入两项才具备补算条件

const HISTORICAL_APPROVED = '已通过'

const LEVEL_RANK: Record<ConclusionLevel, number> = { pass: 0, warning: 1, fail: 2 }

function worst(levels: ConclusionLevel[]): ConclusionLevel {
  return levels.reduce<ConclusionLevel>(
    (worstYet, level) => (LEVEL_RANK[level] > LEVEL_RANK[worstYet] ? level : worstYet),
    'pass',
  )
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function levelLabel(level: ConclusionLevel): string {
  return level === 'pass' ? '通过' : level === 'warning' ? '预警' : '不通过'
}

/**
 * 单条流量记录的统一核对。列表列、详情页、整编清单全部调它，结论只有这一处产生。
 * status 为「已通过」的记录视为历史审核结论，沿用不重判：核对项照常计算，但结论降级保留为通过。
 */
export function evaluateDischarge(row: EntryRow): DischargeEvaluation {
  const recordNo = text(row, '记录编号')
  const station = text(row, '站点编号')
  const methodRaw = text(row, '测量方法')
  const resolved = resolveMethod(methodRaw)
  const historical = String(row.status) === HISTORICAL_APPROVED

  const input: Record<MeasureField, unknown> = {
    断面流量: row.断面流量,
    最大流速: row.最大流速,
    过水面积: row.过水面积,
  }
  const backfill = backfillMeasures(input)

  const checks: CheckItem[] = []
  // 1. 测量方法：目录里没有的方法判不通过；旧方法名给换算留痕。
  if (!resolved.spec) {
    checks.push({
      code: 'METHOD_KNOWN',
      label: '测量方法有效',
      level: 'fail',
      detail: `测量方法「${methodRaw || '空'}」不在标准方法目录内，无法按规范校核`,
    })
  } else if (resolved.legacy) {
    checks.push({
      code: 'METHOD_KNOWN',
      label: '测量方法有效',
      level: 'pass',
      detail: `旧方法「${methodRaw}」已归一为标准方法「${resolved.spec.standard}」`,
    })
  } else {
    checks.push({
      code: 'METHOD_KNOWN',
      label: '测量方法有效',
      level: 'pass',
      detail: `采用标准方法「${resolved.spec.standard}」`,
    })
  }

  // 2. 三量录入是否够补算。
  const rawInputs = (['断面流量', '最大流速', '过水面积'] as MeasureField[]).filter(
    (field) => backfill.parsed[field].value !== null,
  ).length
  checks.push({
    code: 'INPUTS_ENOUGH',
    label: '三量录入齐全度',
    level: rawInputs >= MIN_INPUTS ? 'pass' : 'fail',
    detail:
      rawInputs >= MIN_INPUTS
        ? `已录入 ${rawInputs} 项，满足 Q=v·A 补算条件`
        : `断面流量/最大流速/过水面积仅录入 ${rawInputs} 项，不足两项无法补算`,
  })

  // 3. 单位换算：旧单位能换成 SI 就只留痕不拦截，只有单位无法识别才判不通过。
  const conversionNotes = (['断面流量', '最大流速', '过水面积'] as MeasureField[])
    .map((field) => backfill.parsed[field].note)
    .filter((note): note is string => Boolean(note))
  const unrecognized = conversionNotes.filter((note) => note.startsWith('未识别单位'))
  checks.push({
    code: 'UNITS_SI',
    label: '量值单位换算',
    level: unrecognized.length ? 'fail' : 'pass',
    detail: unrecognized.length
      ? unrecognized.join('；')
      : conversionNotes.length
        ? conversionNotes.join('；')
        : '三量均为 SI 标准单位，无需换算',
  })

  // 4. 量值为正。
  const nonPositive = (['断面流量', '最大流速', '过水面积'] as MeasureField[]).filter(
    (field) => backfill.parsed[field].value !== null && (backfill.parsed[field].value as number) <= 0,
  )
  checks.push({
    code: 'VALUES_POSITIVE',
    label: '量值为正',
    level: nonPositive.length ? 'fail' : 'pass',
    detail: nonPositive.length
      ? `${nonPositive.join('、')}存在非正数，测量值不成立`
      : '已录入量值均为正数',
  })

  // 5. 三量一致性：用 SI 归一值核对 Q ≈ v·A。
  const q = backfill.values.断面流量
  const v = backfill.values.最大流速
  const a = backfill.values.过水面积
  let consistency: CheckItem = {
    code: 'CONSISTENCY_QVA',
    label: 'Q=v·A 一致性',
    level: 'fail',
    detail: '三量未补齐，无法核对 Q=v·A',
  }
  if (q !== null && v !== null && a !== null && v > 0 && a > 0) {
    const expected = v * a
    if (expected <= 0) {
      consistency = { ...consistency, level: 'fail', detail: 'v·A 非正，测量关系不成立' }
    } else {
      const ratio = Math.abs(q - expected) / Math.max(q, expected)
      consistency = {
        code: 'CONSISTENCY_QVA',
        label: 'Q=v·A 一致性',
        level: ratio <= CONSISTENCY_TOLERANCE ? 'pass' : 'warning',
        detail:
          ratio <= CONSISTENCY_TOLERANCE
            ? `Q=${q}、v·A=${Number(expected.toFixed(4))}，偏差 ${(ratio * 100).toFixed(1)}% 在 ±10% 内`
            : `Q=${q} 与 v·A=${Number(expected.toFixed(4))} 偏差 ${(ratio * 100).toFixed(1)}%，超过 ±10%，请复测`,
      }
    }
  }
  checks.push(consistency)

  // 6. 最大流速方法可信度上限。
  if (resolved.spec && v !== null && v > resolved.spec.vmax) {
    checks.push({
      code: 'VELOCITY_RANGE',
      label: '最大流速可信范围',
      level: 'warning',
      detail: `最大流速 ${v} m/s 超出「${resolved.spec.standard}」可信上限 ${resolved.spec.vmax} m/s`,
    })
  } else {
    checks.push({
      code: 'VELOCITY_RANGE',
      label: '最大流速可信范围',
      level: 'pass',
      detail: resolved.spec
        ? v === null
          ? `最大流速待补，按「${resolved.spec.standard}」上限 ${resolved.spec.vmax} m/s 备查`
          : `最大流速 ${v} m/s 在「${resolved.spec.standard}」可信上限 ${resolved.spec.vmax} m/s 内`
        : '方法未识别，流速上限不做校核',
    })
  }

  // 补算本身也在清单里交代清楚。
  if (backfill.computed.length) {
    checks.push({
      code: 'BACKFILLED',
      label: '缺项补算',
      level: 'pass',
      detail: `按 Q=v·A 补算：${backfill.computed.join('、')}`,
    })
  }

  let conclusion = worst(checks.map((item) => item.level))
  if (historical) {
    // 历史审核结论兼容：已通过的老记录不推翻，只在摘要里说明差异。
    checks.forEach((item) => {
      if (item.level !== 'pass') {
        item.level = 'pass'
        item.detail = `【历史审核沿用】${item.detail}`
      }
    })
    conclusion = 'pass'
  }

  const summary = historical
    ? `历史审核结论沿用：记录 ${recordNo}（${station}）保持「${HISTORICAL_APPROVED}」，核对项不重判`
    : `记录 ${recordNo}（${station}）核对${levelLabel(conclusion)}：${checks
        .filter((item) => item.level !== 'pass')
        .map((item) => item.label)
        .join('、') || '各核对项均通过'}`

  return {
    id: Number(row.id),
    recordNo,
    methodRaw,
    method: resolved.spec?.standard ?? null,
    legacy: resolved.legacy,
    historical,
    conclusion,
    backfill,
    checks,
    summary,
  }
}

function toChecklistItem(evaluation: DischargeEvaluation, station: string): ChecklistItem {
  const conversionNotes = (['断面流量', '最大流速', '过水面积'] as MeasureField[])
    .map((field) => evaluation.backfill.parsed[field].note)
    .filter((note): note is string => Boolean(note))
  return {
    id: evaluation.id,
    recordNo: evaluation.recordNo,
    station,
    method: evaluation.method,
    methodRaw: evaluation.methodRaw,
    legacy: evaluation.legacy,
    historical: evaluation.historical,
    conclusion: evaluation.conclusion,
    summary: evaluation.summary,
    conversionNotes,
    computedFields: evaluation.backfill.computed,
    checks: evaluation.checks,
  }
}

/** 组装核对清单：整编链路和「导出核对清单」共用，统计口径只在这一处。 */
export function buildChecklist(rows: EntryRow[], scope: string, generatedAt = new Date()): Checklist {
  const evaluations = rows.map(evaluateDischarge)
  const items = evaluations.map((evaluation) => {
    const row = rows.find((candidate) => Number(candidate.id) === evaluation.id)
    return toChecklistItem(evaluation, row ? String(row.站点编号 ?? '') : '')
  })
  return {
    scope,
    generatedAt: generatedAt.toISOString(),
    total: items.length,
    pass: items.filter((item) => item.conclusion === 'pass').length,
    warning: items.filter((item) => item.conclusion === 'warning').length,
    fail: items.filter((item) => item.conclusion === 'fail').length,
    items,
  }
}
