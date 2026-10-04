import {
  evaluateDischarge,
  buildDischargeReport,
  resolveMethod,
  checkDischargeGate,
  compilationReportCsv,
  STATUS_APPROVED,
} from '@/domain/discharge'
import { availableActions, runAction, runActionSerialized } from '@/api/local-service'
import { MODULE_BY_KEY } from '@/data/modules'
import { resetRows, listRows } from '@/data/local-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${name} ${extra}`)
  }
}

function approx(a: number | null, b: number) {
  return a !== null && Math.abs(a - b) < 0.01
}

// --- 方法换算（旧记法） ---
check('旧记法「水面浮标」换算为浮标法系数0.85', (() => {
  const m = resolveMethod('水面浮标')
  return m.code === 'FLOAT' && m.coefficient === 0.85 && m.convertedFrom === '水面浮标'
})())
check('ADCP 别名换算为声学多普勒法系数1.0', (() => {
  const m = resolveMethod('ADCP')
  return m.code === 'ACOUSTIC' && m.coefficient === 1
})())
check('未识别方法告警并兜底0.85', (() => {
  const m = resolveMethod('目测法')
  return !m.recognized && m.coefficient === 0.85
})())

// --- 三值补算 ---
const floatBackfill = evaluateDischarge({
  id: 101,
  status: '已采集',
  记录编号: 'T101',
  站点编号: 'S1',
  测量方法: '水面浮标',
  断面流量: '',
  最大流速: 1.5,
  过水面积: 80,
})
check('浮标法缺流量 → 补算 Q=0.85*80*1.5=102', approx(floatBackfill.resolved.flow, 102))
check('补算记录结论合格且带补算标注', floatBackfill.verdict === 'pass' && floatBackfill.backfilled[0]?.metric === '断面流量')

const velocityBackfill = evaluateDischarge({
  id: 102,
  status: '已采集',
  记录编号: 'T102',
  站点编号: 'S1',
  测量方法: '量水堰槽法',
  断面流量: 36,
  最大流速: '',
  过水面积: 24,
})
check('堰槽法缺流速 → 补算 V=36/24=1.5', approx(velocityBackfill.resolved.velocity, 1.5))

const areaBackfill = evaluateDischarge({
  id: 103,
  status: '已采集',
  记录编号: 'T103',
  站点编号: 'S1',
  测量方法: '流速仪法',
  断面流量: 245,
  最大流速: 2,
  过水面积: '',
})
check('缺面积 → 补算 A=245/2=122.5', approx(areaBackfill.resolved.area, 122.5))

const twoMissing = evaluateDischarge({
  id: 104,
  status: '已采集',
  记录编号: 'T104',
  站点编号: 'S1',
  测量方法: '流速仪法',
  断面流量: '',
  最大流速: '',
  过水面积: 80,
})
check('缺两项无法补算 → 不合格', twoMissing.verdict === 'fail')

const missingWithNegative = evaluateDischarge({
  id: 105, status: '已采集', 记录编号: 'T105', 站点编号: 'S', 测量方法: '流速仪法',
  断面流量: '', 最大流速: 0, 过水面积: 80,
})
check('缺1项且另一项非正值 → 不合格（不误报齐全）', missingWithNegative.verdict === 'fail')

// --- 偏差带 ---
const within8 = evaluateDischarge({
  id: 201, status: '已采集', 记录编号: 'T201', 站点编号: 'S', 测量方法: '流速仪法',
  断面流量: 245, 最大流速: 2, 过水面积: 120, // 偏差 2.04%
})
check('偏差2% → 合格', within8.verdict === 'pass')

const warnCase = evaluateDischarge({
  id: 202, status: '已采集', 记录编号: 'T202', 站点编号: 'S', 测量方法: '声学多普勒法',
  断面流量: 300, 最大流速: 2.5, 过水面积: 100, // 偏差 16.7%
})
check('偏差16.7% → 需复核', warnCase.verdict === 'review')

const failCase = evaluateDischarge({
  id: 203, status: '已采集', 记录编号: 'T203', 站点编号: 'S', 测量方法: '流速仪法',
  断面流量: 500, 最大流速: 1, 过水面积: 100, // 偏差 80%
})
check('偏差80% → 不合格', failCase.verdict === 'fail')

const invalidCase = evaluateDischarge({
  id: 204, status: '已采集', 记录编号: 'T204', 站点编号: 'S', 测量方法: '流速仪法',
  断面流量: '待定', 最大流速: 1, 过水面积: 100,
})
check('非数值读数 → 不合格', invalidCase.verdict === 'fail')

// --- 历史审核结论兼容 ---
const history = evaluateDischarge({
  id: 205, status: STATUS_APPROVED, 记录编号: 'T205', 站点编号: 'S', 测量方法: '流速仪法',
  断面流量: 500, 最大流速: 1, 过水面积: 100, // 新规则下不合格
})
check('历史已通过：结论沿用合格、不翻案', history.verdict === 'pass' && history.inherited === true)
check('历史兼容：复算留痕可见', history.checks.some((c) => c.name === '审核结论兼容'))

// --- 动作闸门 ---
const gateFail = checkDischargeGate('提交审核', failCase)
check('不合格记录禁止提交审核', !gateFail.allow)
const gateWarn = checkDischargeGate('确认通过', warnCase)
check('需复核记录禁止确认通过', !gateWarn.allow)
const gatePass = checkDischargeGate('提交审核', floatBackfill)
check('合格（含补算）允许提交审核', gatePass.allow)

// --- 整编报告 ---
const report = buildDischargeReport([
  { id: 1, status: '已采集', pending: true, abnormal: false, ...{ 记录编号: 'A', 测量方法: '流速仪法', 断面流量: 245, 最大流速: 2, 过水面积: 120 } },
  { id: 2, status: '已通过', pending: false, abnormal: false, ...{ 记录编号: 'B', 测量方法: '流速仪法', 断面流量: 500, 最大流速: 1, 过水面积: 100 } },
  { id: 3, status: '待审核', pending: true, abnormal: false, ...{ 记录编号: 'C', 测量方法: 'ADCP', 断面流量: '', 最大流速: 1.5, 过水面积: 80 } },
] as never[])
check('整编报告：1合格+1历史沿用+1合格(补算ADCP无系数差)=3合格', report.passCount === 3 && report.failCount === 0)
check('整编CSV含统一结论列', compilationReportCsv(report).includes('校核结论'))

// --- 状态机 / 越级拒绝 / 并发 / 原子性（使用种子数据） ---
const dmeta = MODULE_BY_KEY.get('discharge')!
resetRows('discharge')
const collected = listRows('discharge').find((r) => String(r.status) === '已采集')!
// 种子 id=1（齐全245/2/120 合格）
check('已采集可提交审核', availableActions(dmeta, '已采集').includes('提交审核'))
check('已采集不允许确认通过（越级）', !availableActions(dmeta, '已采集').includes('确认通过'))
const skip = runAction('discharge', 1, '确认通过')
check('越级动作被拒绝且状态不变', !skip.ok && String(listRows('discharge')[0].status) === '已采集')
check('越级提示信息明确', skip.message.includes('越级'))

// id=5 偏差80%且处于待审核：闸门禁止通过，但允许标记异常
const rejected = runAction('discharge', 5, '确认通过')
check('待审核但校核不合格：确认通过被闸门拒绝', !rejected.ok)
const marked = runAction('discharge', 5, '标记异常')
check('不合格记录允许标记异常', marked.ok && String(listRows('discharge').find((r) => r.id === 5)!.status) === '异常值')

// 终态再动作
const again = runAction('discharge', 5, '提交审核')
check('终态不可再提交（状态机/重复态拦截）', !again.ok)

// 并发审核只推进一次
resetRows('discharge')
const [r1, r2] = await Promise.all([
  runActionSerialized('discharge', 1, '提交审核'),
  runActionSerialized('discharge', 1, '提交审核'),
])
check('并发提交：恰好一个成功', (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0) === 1)
check('并发失败者得到并发提示', !r1.ok ? r1.message.includes('并发') : r2.message.includes('并发'))
check('并发落地后状态只推进一格：已采集→待审核', String(listRows('discharge')[0].status) === '待审核')

// 失败不留半份状态：校验失败后记录内容不变
resetRows('discharge')
const before = JSON.stringify(listRows('discharge').find((r) => r.id === 5))
const failedAction = runAction('discharge', 5, '审核通过' as never)
const after = JSON.stringify(listRows('discharge').find((r) => r.id === 5))
check('未登记动作失败不留痕', !failedAction.ok && before === after)

// --- 整编链路状态机 ---
const cmeta = MODULE_BY_KEY.get('compilation')!
resetRows('compilation')
const skipComp = runAction('compilation', 1, '审核通过')
check('整编越级（待整编直接审核通过）拒绝', !skipComp.ok && skipComp.message.includes('越级'))
check('整编待整编可开始整编', availableActions(cmeta, '待整编').includes('开始整编'))
const start = runAction('compilation', 1, '开始整编')
check('开始整编成功', start.ok && String(listRows('compilation')[0].status) === '整编中')
// 种子流量含 id=5 不合格（已 reset discharge 为种子）：整编提交审核应被业务闸门拒绝
const submitBad = runAction('compilation', 1, '提交审核')
check('整编清单含未隔离不合格记录：提交审核拒绝且状态仍是整编中（无半份状态）',
  !submitBad.ok && String(listRows('compilation')[0].status) === '整编中')
// 将不合格记录标记异常隔离（隔离留痕，不阻断整编）
const markForIsolation = runAction('discharge', 5, '标记异常')
check('标记异常成功且看板异常量置位', markForIsolation.ok && listRows('discharge').find((r) => r.id === 5)!.abnormal === true)
const submitOk = runAction('compilation', 1, '提交审核')
check('不合格记录隔离后：整编提交审核放行，进入待审核',
  submitOk.ok && String(listRows('compilation')[0].status) === '待审核')

// 隔离记录在整编报告中计数且不计 fail
const reportAfter = buildDischargeReport(listRows('discharge'))
check('整编报告：异常隔离1条、有效记录fail=0',
  reportAfter.excludedCount === 1 && reportAfter.failCount === 0 && reportAfter.total === 6)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
