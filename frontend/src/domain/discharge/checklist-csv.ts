import type { Checklist, ConclusionLevel } from './types'

// 核对清单导出：列表入口和整编链路共用同一份排版，结论口径不再两处不一样。

const LEVEL_TEXT: Record<ConclusionLevel, string> = {
  pass: '通过',
  warning: '预警',
  fail: '不通过',
}

function escapeCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function checklistToCsv(checklist: Checklist): string {
  const header = [
    '记录编号',
    '站点编号',
    '原始测量方法',
    '归一方法',
    '旧方法',
    '核对结论',
    '补算字段',
    '换算与核对说明',
  ]
  const lines = [header.join(',')]
  for (const item of checklist.items) {
    const notes = [
      ...item.conversionNotes,
      ...item.checks.filter((check) => check.level !== 'pass').map((check) => check.detail),
      item.historical ? '历史审核结论沿用' : '',
    ]
      .filter(Boolean)
      .join('；')
    lines.push(
      [
        item.recordNo,
        item.station,
        item.methodRaw,
        item.method ?? '未识别',
        item.legacy ? '是' : '否',
        LEVEL_TEXT[item.conclusion],
        item.computedFields.join('、') || '—',
        notes || '各核对项均通过',
      ]
        .map((cell) => escapeCell(String(cell)))
        .join(','),
    )
  }
  lines.push('')
  lines.push(
    `核对范围,${escapeCell(checklist.scope)},生成时间,${checklist.generatedAt},通过,${checklist.pass},预警,${checklist.warning},不通过,${checklist.fail},合计,${checklist.total}`,
  )
  return `﻿${lines.join('\n')}`
}
