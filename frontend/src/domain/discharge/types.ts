// 流量监测统一判定的公共类型。
// 测量方法归一、断面流量/最大流速/过水面积三量补算、核对清单全部围绕这一份类型，
// 列表、详情、整编链路只准消费这里的结论，不允许各自再写一套判定。

export type ConclusionLevel = 'pass' | 'warning' | 'fail'

export type MeasureField = '断面流量' | '最大流速' | '过水面积'

/** 标准测流方法目录条目：旧方法名通过 aliases 归一，命中旧名按 legacy 标记留痕。 */
export interface MethodSpec {
  key: string
  standard: string
  aliases: string[]
  /** 该方法可信的最大流速上限（m/s），超过只给预警，不直接判废。 */
  vmax: number
  legacy?: boolean
}

/** 单个测量值的解析结果：原值、原单位、换算到 SI 后的值，换算过程逐项留痕。 */
export interface ParsedMeasure {
  raw: string
  value: number | null
  unit: string
  standardValue: number | null
  converted: boolean
  note?: string
}

export interface BackfillResult {
  /** 归一到 SI 后的三量；缺两项以上补不出来时对应字段为 null。 */
  values: Record<MeasureField, number | null>
  parsed: Record<MeasureField, ParsedMeasure>
  /** 本次按 Q = v·A 补算出来的字段。 */
  computed: MeasureField[]
  complete: boolean
}

export interface CheckItem {
  code: string
  label: string
  level: ConclusionLevel
  detail: string
}

/** 一条流量记录的统一核对结论，列表、详情、整编清单共用。 */
export interface DischargeEvaluation {
  id: number
  recordNo: string
  methodRaw: string
  method: string | null
  legacy: boolean
  /** 历史审核记录（已通过）：沿用旧结论，不重判、不改值。 */
  historical: boolean
  conclusion: ConclusionLevel
  backfill: BackfillResult
  checks: CheckItem[]
  summary: string
}

export interface ChecklistItem {
  id: number
  recordNo: string
  station: string
  method: string | null
  methodRaw: string
  legacy: boolean
  historical: boolean
  conclusion: ConclusionLevel
  summary: string
  conversionNotes: string[]
  computedFields: MeasureField[]
  checks: CheckItem[]
}

export interface Checklist {
  scope: string
  generatedAt: string
  total: number
  pass: number
  warning: number
  fail: number
  items: ChecklistItem[]
}
