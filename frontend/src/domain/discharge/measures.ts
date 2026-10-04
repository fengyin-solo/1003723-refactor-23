import type { BackfillResult, MeasureField, ParsedMeasure } from './types'

// 旧单位一律换算成 SI：断面流量 m³/s、最大流速 m/s、过水面积 m²。
// 每命中一次旧单位都记一条留痕说明，列表、详情、整编清单看到的换算来源完全一致。
interface UnitRule {
  aliases: string[]
  factor: number
  standard: string
}

const UNIT_RULES: Record<MeasureField, UnitRule[]> = {
  断面流量: [
    { aliases: ['m³/s', '立方米/秒', '米3/秒', '立方每秒'], factor: 1, standard: 'm³/s' },
    { aliases: ['m³/min', '立方米/分'], factor: 1 / 60, standard: 'm³/s' },
    { aliases: ['m³/h', '立方米/时', '立方米/小时'], factor: 1 / 3600, standard: 'm³/s' },
    { aliases: ['L/s', '升/秒'], factor: 0.001, standard: 'm³/s' },
    { aliases: ['ft³/s', '立方英尺/秒'], factor: 0.0283168, standard: 'm³/s' },
  ],
  最大流速: [
    { aliases: ['m/s', '米/秒'], factor: 1, standard: 'm/s' },
    { aliases: ['cm/s', '厘米/秒'], factor: 0.01, standard: 'm/s' },
    { aliases: ['m/min', '米/分'], factor: 1 / 60, standard: 'm/s' },
    { aliases: ['km/h', '千米/时', '公里/时'], factor: 1 / 3.6, standard: 'm/s' },
    { aliases: ['ft/s', '英尺/秒'], factor: 0.3048, standard: 'm/s' },
  ],
  过水面积: [
    { aliases: ['m²', '平方米', '米2'], factor: 1, standard: 'm²' },
    { aliases: ['cm²', '平方厘米'], factor: 0.0001, standard: 'm²' },
    { aliases: ['ha', '公顷'], factor: 10000, standard: 'm²' },
    { aliases: ['亩'], factor: 666.6667, standard: 'm²' },
    { aliases: ['km²', '平方千米', '平方公里'], factor: 1_000_000, standard: 'm²' },
    { aliases: ['ft²', '平方英尺'], factor: 0.092903, standard: 'm²' },
  ],
}

const NUMBER_PREFIX = /^\s*(-?\d+(?:\.\d+)?)/

export function round4(value: number): number {
  return Number(value.toFixed(4))
}

export function parseMeasure(field: MeasureField, rawValue: unknown): ParsedMeasure {
  const raw = String(rawValue ?? '').trim()
  const empty: ParsedMeasure = { raw, value: null, unit: '', standardValue: null, converted: false }
  if (!raw) {
    return empty
  }
  const matched = raw.match(NUMBER_PREFIX)
  if (!matched) {
    return { ...empty, note: '不是可识别的数值' }
  }
  const value = Number(matched[1])
  const unitText = raw.slice(matched[0].length).trim()
  const rules = UNIT_RULES[field]
  if (!unitText) {
    // 裸数字按该字段标准单位处理，不制造无谓的换算留痕。
    return { raw, value, unit: rules[0].standard, standardValue: value, converted: false }
  }
  const rule = rules.find((item) =>
    item.aliases.some((alias) => unitText.replace(/\s/g, '') === alias.replace(/\s/g, '')),
  )
  if (!rule) {
    return { raw, value, unit: unitText, standardValue: null, converted: false, note: `未识别单位「${unitText}」` }
  }
  const standardValue = round4(value * rule.factor)
  if (rule.factor === 1) {
    return { raw, value, unit: unitText, standardValue, converted: false }
  }
  return {
    raw,
    value,
    unit: unitText,
    standardValue,
    converted: true,
    note: `旧单位换算：${value}${unitText} → ${standardValue}${rule.standard}`,
  }
}

/**
 * 三量补算：Q（断面流量）= v（最大流速）· A（过水面积）。
 * 至少给两项才能补第三项；只给一项或缺两项以上时不臆造，补算结果留 null。
 */
export function backfillMeasures(input: Record<MeasureField, unknown>): BackfillResult {
  const fields: MeasureField[] = ['断面流量', '最大流速', '过水面积']
  const parsed = fields.reduce(
    (acc, field) => {
      acc[field] = parseMeasure(field, input[field])
      return acc
    },
    {} as Record<MeasureField, ParsedMeasure>,
  )
  const values: Record<MeasureField, number | null> = {
    断面流量: parsed.断面流量.standardValue,
    最大流速: parsed.最大流速.standardValue,
    过水面积: parsed.过水面积.standardValue,
  }
  const computed: MeasureField[] = []

  const [q, v, a] = [values.断面流量, values.最大流速, values.过水面积]
  const known = [q, v, a].filter((item): item is number => item !== null && item > 0).length

  if (known >= 2 && q === null && v !== null && a !== null) {
    values.断面流量 = round4(v * a)
    computed.push('断面流量')
  } else if (known >= 2 && v === null && q !== null && a !== null && a > 0) {
    values.最大流速 = round4(q / a)
    computed.push('最大流速')
  } else if (known >= 2 && a === null && q !== null && v !== null && v > 0) {
    values.过水面积 = round4(q / v)
    computed.push('过水面积')
  }

  const complete = fields.every((field) => values[field] !== null && (values[field] as number) > 0)
  return { values, parsed, computed, complete }
}
