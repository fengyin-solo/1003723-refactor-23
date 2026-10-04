/**
 * 流量监测统一判定域（纯函数、无框架依赖）。
 *
 * 测量方法换算、断面流量/最大流速/过水面积补算、统一结论、核对清单只在这里实现一次，
 * 列表展示、记录详情、动作闸门、数据整编链路全部复用 evaluateDischarge 的同一结果，
 * 不再在各入口各写一套，保证「列表、详情、整编清单」结论一致。
 */
import type { EntryRow } from '@/data/types'

export const DISCHARGE_KEY = 'discharge'

export const FIELD_CODE = '记录编号'
export const FIELD_STATION = '站点编号'
export const FIELD_METHOD = '测量方法'
export const FIELD_FLOW = '断面流量'
export const FIELD_VELOCITY = '最大流速'
export const FIELD_AREA = '过水面积'
export const FIELD_TIME = '测量时间'

export const STATUS_COLLECTED = '已采集'
export const STATUS_REVIEWING = '待审核'
export const STATUS_APPROVED = '已通过'
export const STATUS_ABNORMAL = '异常值'

// 结论分级：pass 合格 / review 需复核 / fail 不合格
export type Verdict = 'pass' | 'review' | 'fail'
export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info'

export type MethodResolution = {
  code: string
  label: string
  coefficient: number
  recognized: boolean
  /** 命中旧记法时，给出旧名以便清单留痕 */
  convertedFrom?: string
}

export type MetricTriple = {
  flow: number | null
  velocity: number | null
  area: number | null
}

export type CheckItem = {
  name: string
  level: CheckLevel
  message: string
}

export type DischargeEvaluation = {
  id: number
  code: string
  station: string
  method: MethodResolution
  /** 原始读数（不可解析记为 null） */
  raw: MetricTriple
  /** 补算后的完整三值；缺两项无法补算时仍含 null */
  resolved: MetricTriple
  /** 实际发生的补算项 */
  backfilled: Array<{ metric: '断面流量' | '最大流速' | '过水面积'; value: number }>
  /** 与 Q = k·A·V 的相对偏差，无关系可校核时为 null */
  deviation: number | null
  verdict: Verdict
  /** 记录当前业务状态（异常值记录在整编时隔离） */
  status: string
  /** 历史已通过记录沿用旧审核结论，不翻案 */
  inherited: boolean
  conclusion: string
  checks: CheckItem[]
}

export type DischargeReport = {
  generatedAt: string
  total: number
  passCount: number
  reviewCount: number
  failCount: number
  /** 已标记异常值、隔离出整编范围的记录数（仍列在清单中留痕） */
  excludedCount: number
  inheritedCount: number
  backfilledCount: number
  items: DischargeEvaluation[]
  /** 整编层核对清单 */
  checks: CheckItem[]
  conclusion: string
}

type MethodSpec = {
  code: string
  label: string
  coefficient: number
  aliases: string[]
}

// 测量方法目录：名称统一到规范名，系数只维护这一处。
// 浮标类按水面浮标经验系数 0.85 换算；流速仪/声学等直接测得断面成果，系数 1.0。
const DEFAULT_COEFFICIENT = 0.85
const METHOD_CATALOG: MethodSpec[] = [
  { code: 'CURRENT_METER', label: '流速仪法', coefficient: 1.0, aliases: ['流速仪', '转子式流速仪', '流速仪测流', '旋桨式流速仪'] },
  { code: 'FLOAT', label: '浮标法', coefficient: 0.85, aliases: ['水面浮标', '浮标', '浮标测流', '漂浮物法', '浮标系数法'] },
  { code: 'ACOUSTIC', label: '声学多普勒法', coefficient: 1.0, aliases: ['ADCP', 'adcp', '声学', '多普勒', '声学多普勒', '声学多普勒流速剖面仪'] },
  { code: 'WEIR', label: '量水堰槽法', coefficient: 1.0, aliases: ['量水堰', '堰槽', '薄壁堰', '堰板法'] },
  { code: 'DILUTION', label: '稀释法', coefficient: 1.0, aliases: ['溶液法', '化学法', '稀释', '示踪法'] },
  { code: 'SLOPE_AREA', label: '比降面积法', coefficient: 1.0, aliases: ['比降法', '水力学法', '比降面积'] },
]

const UNKNOWN_METHOD: MethodSpec = { code: 'UNKNOWN', label: '未识别方法', coefficient: DEFAULT_COEFFICIENT, aliases: [] }

// 关系校核偏差带：8% 以内合格，(8%, 20%] 需复核，超过 20% 判不合格。
const TOLERANCE_PASS = 0.08
const TOLERANCE_REVIEW = 0.2

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/** 测量方法换算：旧记法/别名 → 规范方法 + 系数；未识别时按浮标经验系数兜底并告警。 */
export function resolveMethod(raw: unknown): MethodResolution {
  const name = normalizeName(raw)
  if (!name) {
    return { ...UNKNOWN_METHOD, recognized: false }
  }
  for (const spec of METHOD_CATALOG) {
    if (spec.label === name || spec.code === name) {
      return { code: spec.code, label: spec.label, coefficient: spec.coefficient, recognized: true }
    }
  }
  for (const spec of METHOD_CATALOG) {
    if (spec.aliases.some((alias) => alias === name || name.includes(alias))) {
      return { code: spec.code, label: spec.label, coefficient: spec.coefficient, recognized: true, convertedFrom: name }
    }
  }
  return { ...UNKNOWN_METHOD, coefficient: DEFAULT_COEFFICIENT, recognized: false }
}

/** 读一个测值：空串/缺字段 = 缺测(null+missing)；非数字 = 不可解析(null+invalid)。 */
function readMetric(raw: unknown): { value: number | null; missing: boolean; invalid: boolean } {
  if (raw === null || raw === undefined) {
    return { value: null, missing: true, invalid: false }
  }
  const text = String(raw).trim()
  if (text === '') {
    return { value: null, missing: true, invalid: false }
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return { value: null, missing: false, invalid: true }
  }
  return { value, missing: false, invalid: false }
}

export type DischargeInput = {
  id: number
  status?: string
  [field: string]: string | number | boolean | undefined
}

/**
 * 统一判定：方法换算 → 读数校验 → 三值补算 → Q=k·A·V 关系校核 → 结论。
 * 历史已通过记录只复算留痕，结论沿用（inherited）。
 */
export function evaluateDischarge(input: DischargeInput): DischargeEvaluation {
  const id = Number(input.id)
  const code = normalizeName(input[FIELD_CODE]) || `#${id}`
  const station = normalizeName(input[FIELD_STATION])
  const method = resolveMethod(input[FIELD_METHOD])

  const flowRead = readMetric(input[FIELD_FLOW])
  const velocityRead = readMetric(input[FIELD_VELOCITY])
  const areaRead = readMetric(input[FIELD_AREA])

  const raw: MetricTriple = { flow: flowRead.value, velocity: velocityRead.value, area: areaRead.value }
  const checks: CheckItem[] = []

  // 1) 测量方法
  if (method.recognized) {
    checks.push({
      name: '测量方法识别',
      level: 'pass',
      message: method.convertedFrom
        ? `旧记法「${method.convertedFrom}」换算为规范方法「${method.label}」，换算系数 ${method.coefficient}`
        : `测量方法「${method.label}」，换算系数 ${method.coefficient}`,
    })
  } else {
    checks.push({
      name: '测量方法识别',
      level: 'warn',
      message: `测量方法「${normalizeName(input[FIELD_METHOD]) || '空'}」未登记，暂按浮标经验系数 ${DEFAULT_COEFFICIENT} 处理，请人工确认`,
    })
  }

  // 2) 三项读数
  const metricReads: Array<{ name: '断面流量' | '最大流速' | '过水面积'; read: typeof flowRead }> = [
    { name: '断面流量', read: flowRead },
    { name: '最大流速', read: velocityRead },
    { name: '过水面积', read: areaRead },
  ]
  for (const item of metricReads) {
    if (item.read.invalid) {
      checks.push({ name: `${item.name}读数`, level: 'fail', message: `${item.name}不是有效数值，无法参与计算` })
    } else if (item.read.missing) {
      checks.push({ name: `${item.name}读数`, level: 'warn', message: `${item.name}缺测，尝试按其余两项补算` })
    } else if ((item.read.value as number) <= 0) {
      checks.push({ name: `${item.name}读数`, level: 'fail', message: `${item.name}必须为正数，实测 ${item.read.value}` })
    } else {
      checks.push({ name: `${item.name}读数`, level: 'pass', message: `${item.name}实测 ${item.read.value}` })
    }
  }

  // 3) 三值补算：恰好缺一项可由 Q = k·A·V 补出；缺两项及以上无法补算。
  const resolved: MetricTriple = { ...raw }
  const backfilled: DischargeEvaluation['backfilled'] = []
  const missingCount = [flowRead, velocityRead, areaRead].filter((r) => r.missing).length
  const invalidCount = [flowRead, velocityRead, areaRead].filter((r) => r.invalid).length
  const positiveCount = [flowRead, velocityRead, areaRead].filter((r) => r.value !== null && r.value > 0).length

  if (invalidCount === 0 && missingCount === 1 && positiveCount === 2) {
    const k = method.coefficient
    if (flowRead.missing && velocityRead.value !== null && areaRead.value !== null) {
      const value = round3(k * areaRead.value * velocityRead.value)
      resolved.flow = value
      backfilled.push({ metric: '断面流量', value })
    } else if (velocityRead.missing && flowRead.value !== null && areaRead.value !== null) {
      const value = round3(flowRead.value / (k * areaRead.value))
      resolved.velocity = value
      backfilled.push({ metric: '最大流速', value })
    } else if (areaRead.missing && flowRead.value !== null && velocityRead.value !== null) {
      const value = round3(flowRead.value / (k * velocityRead.value))
      resolved.area = value
      backfilled.push({ metric: '过水面积', value })
    }
    checks.push({
      name: '三值补算',
      level: 'pass',
      message: `按 Q = ${k}·A·V 补算${backfilled[0].metric} = ${backfilled[0].value}`,
    })
    // 补算成功后，原缺测告警收敛为通过留痕，不再把整条记录压成「需复核」。
    const backfilledNames = new Set(backfilled.map((b) => b.metric))
    for (const check of checks) {
      const metricName = metricReads.find((item) => check.name === `${item.name}读数`)?.name
      if (metricName && backfilledNames.has(metricName)) {
        const filled = backfilled.find((b) => b.metric === metricName)!
        check.level = 'pass'
        check.message = `${metricName}原缺测，已按 Q = ${k}·A·V 补算为 ${filled.value}`
      }
    }
  } else if (missingCount >= 2 || invalidCount > 0) {
    checks.push({
      name: '三值补算',
      level: 'fail',
      message:
        invalidCount > 0
          ? '存在不可解析读数，无法补算'
          : `缺测 ${missingCount} 项，至少需要两项有效正值才能补算第三项`,
    })
  } else if (missingCount === 1) {
    checks.push({ name: '三值补算', level: 'fail', message: '缺测 1 项，但其余两项不都是有效正值，无法补算' })
  } else {
    checks.push({ name: '三值补算', level: 'pass', message: '三项测值齐全，无需补算' })
  }

  // 4) 关系校核 Q = k·A·V
  let deviation: number | null = null
  if (resolved.flow !== null && resolved.velocity !== null && resolved.area !== null && resolved.flow > 0) {
    const expected = method.coefficient * resolved.area * resolved.velocity
    deviation = Math.abs(resolved.flow - expected) / resolved.flow
    const percent = `${(deviation * 100).toFixed(1)}%`
    if (backfilled.length > 0) {
      checks.push({ name: '水量关系校核', level: 'pass', message: '补算值与其余两项自洽' })
    } else if (deviation <= TOLERANCE_PASS) {
      checks.push({ name: '水量关系校核', level: 'pass', message: `断面流量与 k·A·V 偏差 ${percent}，在 ±8% 以内` })
    } else if (deviation <= TOLERANCE_REVIEW) {
      checks.push({ name: '水量关系校核', level: 'warn', message: `断面流量与 k·A·V 偏差 ${percent}，超出 ±8% 但未达 ±20%，需复核` })
    } else {
      checks.push({ name: '水量关系校核', level: 'fail', message: `断面流量与 k·A·V 偏差 ${percent}，超过 ±20%，判为异常数据` })
    }
  } else {
    checks.push({ name: '水量关系校核', level: 'fail', message: '三项数值不完整，无法进行 Q=k·A·V 关系校核' })
  }

  // 5) 汇总结论（统一口径，列表/详情/整编共用）
  const hasFail = checks.some((c) => c.level === 'fail')
  const hasWarn = checks.some((c) => c.level === 'warn')
  const computed: Verdict = hasFail ? 'fail' : hasWarn ? 'review' : 'pass'

  // 历史审核结论兼容：已通过记录沿用结论，复算结果仅留痕，不翻案。
  const inherited = input.status === STATUS_APPROVED
  if (inherited) {
    checks.push({
      name: '审核结论兼容',
      level: 'info',
      message:
        computed === 'pass'
          ? '历史已通过记录，新规则复算一致，沿用原审核结论'
          : `历史已通过记录，沿用原审核结论（新规则复算为「${verdictLabel(computed)}」，仅留痕不翻案）`,
    })
  }

  const verdict: Verdict = inherited ? 'pass' : computed
  const conclusion = inherited
    ? `合格（沿用历史审核结论；复算：${verdictLabel(computed)}）`
    : verdictLabel(verdict) + conclusionSuffix(computed, backfilled)

  return {
    id,
    code,
    station,
    method,
    raw,
    resolved,
    backfilled,
    deviation,
    verdict,
    status: String(input.status ?? ''),
    inherited,
    conclusion,
    checks,
  }
}

function verdictLabel(verdict: Verdict): string {
  return verdict === 'pass' ? '合格' : verdict === 'review' ? '需复核' : '不合格'
}

function conclusionSuffix(verdict: Verdict, backfilled: DischargeEvaluation['backfilled']): string {
  if (verdict === 'pass' && backfilled.length > 0) {
    return `（补算${backfilled.map((b) => b.metric).join('、')}）`
  }
  return ''
}

export function evaluateEntry(row: EntryRow): DischargeEvaluation {
  return evaluateDischarge(row as DischargeInput)
}

/**
 * 动作闸门：状态机（越级拒绝）之外的业务判定。
 * - 提交审核：只接受合格记录，需复核/不合格必须先处理或标记异常；
 * - 确认通过：只接受合格记录；
 * - 标记异常：业务上总是允许（来源状态由状态机约束）。
 */
export function checkDischargeGate(action: string, evaluation: DischargeEvaluation): { allow: boolean; message: string } {
  if (action === '标记异常') {
    return { allow: true, message: '' }
  }
  if (action === '提交审核' || action === '确认通过') {
    if (evaluation.verdict === 'pass') {
      return { allow: true, message: '' }
    }
    const reason =
      evaluation.verdict === 'review'
        ? '存在需复核的警示项，请核实后重新提交，或先标记异常'
        : '存在不合格的校核项，不能进入审核，请修正数据或标记异常'
    return { allow: false, message: `流量记录 ${evaluation.code} 校核结论为「${evaluation.conclusion}」：${reason}` }
  }
  return { allow: true, message: '' }
}

/** 整编提交闸门：未隔离的不合格记录会阻断送审；已标记异常值的记录隔离留痕，不阻断整编。 */
export function checkCompilationGate(report: DischargeReport): { allow: boolean; message: string } {
  const activeTotal = report.total - report.excludedCount
  if (activeTotal === 0) {
    return { allow: false, message: '没有可整编的有效流量记录（其余已隔离为异常值），无法生成整编清单' }
  }
  if (report.failCount > 0) {
    return {
      allow: false,
      message: `整编清单中有 ${report.failCount} 条不合格流量记录，请修正数据，或标记异常隔离后再提交审核`,
    }
  }
  return { allow: true, message: '' }
}

/** 汇总全部流量记录，产出整编核对清单（整编链路与流量入口共用）。 */
export function buildDischargeReport(rows: EntryRow[], generatedAt = new Date().toISOString()): DischargeReport {
  const items = rows.map(evaluateEntry)
  const active = items.filter((item) => item.status !== STATUS_ABNORMAL)
  const excluded = items.filter((item) => item.status === STATUS_ABNORMAL)
  const passCount = active.filter((i) => i.verdict === 'pass' && !i.inherited).length
  const inheritedCount = active.filter((i) => i.inherited).length
  const reviewCount = active.filter((i) => i.verdict === 'review').length
  const failCount = active.filter((i) => i.verdict === 'fail').length
  const backfilledCount = active.filter((i) => i.backfilled.length > 0).length

  const checks: CheckItem[] = [
    { name: '记录数量核对', level: 'pass', message: `整编范围内共 ${items.length} 条流量记录，逐条复算断面流量/最大流速/过水面积` },
    {
      name: '异常记录隔离核对',
      level: excluded.length > 0 ? 'warn' : 'pass',
      message:
        excluded.length > 0
          ? `${excluded.length} 条记录已标记异常值，隔离出整编范围并在逐条清单中留痕：${excluded.map((i) => i.code).join('、')}`
          : '无异常隔离记录',
    },
    {
      name: '补算情况核对',
      level: backfilledCount > 0 ? 'warn' : 'pass',
      message: backfilledCount > 0 ? `${backfilledCount} 条记录存在补算项，已在逐条清单中标注` : '无补算记录',
    },
    {
      name: '历史结论核对',
      level: inheritedCount > 0 ? 'info' : 'pass',
      message: inheritedCount > 0 ? `${inheritedCount} 条历史已通过记录沿用原审核结论` : '无历史已通过记录',
    },
    {
      name: '合格情况核对',
      level: failCount > 0 ? 'fail' : reviewCount > 0 ? 'warn' : 'pass',
      message: `有效记录 ${active.length} 条：合格 ${passCount + inheritedCount} 条（含历史沿用 ${inheritedCount} 条），需复核 ${reviewCount} 条，不合格 ${failCount} 条`,
    },
  ]

  const conclusion =
    active.length === 0
      ? '整编不成立：没有可整编的有效流量记录'
      : failCount > 0
        ? `整编不通过：${failCount} 条有效记录不合格，退回处理`
        : reviewCount > 0
          ? `整编基本合格：${reviewCount} 条需复核，其余 ${passCount + inheritedCount} 条合格${excluded.length ? `；隔离异常 ${excluded.length} 条` : ''}`
          : `整编合格：${passCount + inheritedCount} 条有效记录全部通过校核${excluded.length ? `；隔离异常 ${excluded.length} 条` : ''}`

  return {
    generatedAt,
    total: items.length,
    passCount: passCount + inheritedCount,
    reviewCount,
    failCount,
    excludedCount: excluded.length,
    inheritedCount,
    backfilledCount,
    items,
    checks,
    conclusion,
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 单条记录核对清单 CSV：列表/详情/整编看到的条目完全一致。 */
export function dischargeChecklistCsv(evaluation: DischargeEvaluation): string {
  const lines = [
    `流量记录核对清单,,,`,
    `记录编号,${csvCell(evaluation.code)},站点编号,${csvCell(evaluation.station)}`,
    `测量方法,${csvCell(evaluation.method.label)},换算系数,${evaluation.method.coefficient}`,
    `断面流量,${evaluation.resolved.flow ?? '—'},最大流速,${evaluation.resolved.velocity ?? '—'}`,
    `过水面积,${evaluation.resolved.area ?? '—'},校核结论,${csvCell(evaluation.conclusion)}`,
    `检查项,级别,说明,`,
  ]
  for (const check of evaluation.checks) {
    lines.push([csvCell(check.name), csvCell(levelLabel(check.level)), csvCell(check.message), ''].join(','))
  }
  return `﻿${lines.join('\n')}`
}

/** 整编核对清单 CSV：整编汇总 + 逐条结论（与列表、详情同一判定结果）。 */
export function compilationReportCsv(report: DischargeReport): string {
  const lines = [
    '数据整编核对清单（流量监测）,,,',
    `生成时间,${csvCell(report.generatedAt)},记录总数,${report.total}`,
    `合格,${report.passCount},需复核,${report.reviewCount}`,
    `不合格,${report.failCount},其中历史沿用,${report.inheritedCount}`,
    `整编结论,${csvCell(report.conclusion)},,`,
    '整编核对项,级别,说明,',
  ]
  for (const check of report.checks) {
    lines.push([csvCell(check.name), csvCell(levelLabel(check.level)), csvCell(check.message), ''].join(','))
  }
  lines.push('记录编号,站点编号,测量方法,断面流量,最大流速,过水面积,补算项,记录状态,校核结论')
  for (const item of report.items) {
    lines.push(
      [
        csvCell(item.code),
        csvCell(item.station),
        csvCell(item.method.label),
        item.resolved.flow ?? '—',
        item.resolved.velocity ?? '—',
        item.resolved.area ?? '—',
        csvCell(item.backfilled.map((b) => `${b.metric}=${b.value}`).join('；')),
        csvCell(item.status || '—'),
        csvCell(
          item.status === STATUS_ABNORMAL
            ? `异常隔离（复算：${item.conclusion}）`
            : item.conclusion,
        ),
      ].join(','),
    )
  }
  return `﻿${lines.join('\n')}`
}

export function levelLabel(level: CheckLevel): string {
  switch (level) {
    case 'pass':
      return '通过'
    case 'warn':
      return '警示'
    case 'fail':
      return '不通过'
    case 'info':
      return '留痕'
  }
}

export function verdictLabelOf(verdict: Verdict): string {
  return verdictLabel(verdict)
}
