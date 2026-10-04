// 领域逻辑冒烟验证：纯 Node 下跑（localStorage 打桩），
// 覆盖旧单位换算、三量补算、历史兼容、越级拒绝、并发单飞、原子提交。
// 用 esbuild 把 TS 打成单文件再执行：node test/smoke.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const entry = path.join(root, 'test/smoke-entry.ts')

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: path.join(root, 'test/.smoke-built.mjs'),
  alias: { '@': path.join(root, 'src') },
  logLevel: 'silent',
})

const mod = await import(pathToFileURL(path.join(root, 'test/.smoke-built.mjs')).href)

// 1. 旧单位换算 + 方法归一
{
  const row = {
    id: 1,
    status: '已采集',
    记录编号: 'T1',
    站点编号: 'S1',
    测量方法: '0.6一点法',
    断面流量: '756 m³/min',
    最大流速: '180 cm/s',
    过水面积: '7 m²',
  }
  const evaluation = mod.evaluateDischarge(row)
  assert.equal(evaluation.method, '一点法', '旧方法归一到一点法')
  assert.equal(evaluation.legacy, true)
  assert.ok(Math.abs(evaluation.backfill.values.断面流量 - 12.6) < 1e-6, 'm³/min → m³/s')
  assert.ok(Math.abs(evaluation.backfill.values.最大流速 - 1.8) < 1e-6, 'cm/s → m/s')
  assert.equal(evaluation.conclusion, 'pass', '旧单位成功换算只留痕，不拦截')
}

// 2. 缺一项补算
{
  const row = {
    id: 2,
    status: '已采集',
    记录编号: 'T2',
    站点编号: 'S1',
    测量方法: '声学多普勒法',
    断面流量: '',
    最大流速: '2 m/s',
    过水面积: '6 m²',
  }
  const evaluation = mod.evaluateDischarge(row)
  assert.ok(Math.abs(evaluation.backfill.values.断面流量 - 12) < 1e-6, 'Q 由 v·A 补算')
  assert.deepEqual(evaluation.backfill.computed, ['断面流量'])
  assert.equal(evaluation.conclusion, 'pass')
}

// 3. Q 与 v·A 偏差超 10% → 预警
{
  const row = {
    id: 3,
    status: '已采集',
    记录编号: 'T3',
    站点编号: 'S1',
    测量方法: '浮标法',
    断面流量: '15 m³/s',
    最大流速: '2 m/s',
    过水面积: '6 m²',
  }
  const evaluation = mod.evaluateDischarge(row)
  assert.equal(evaluation.conclusion, 'warning')
}

// 4. 方法未识别 + 录入不足 → fail
{
  const row = {
    id: 4,
    status: '已采集',
    记录编号: 'T4',
    站点编号: 'S1',
    测量方法: '手工估算',
    断面流量: '',
    最大流速: '',
    过水面积: '',
  }
  const evaluation = mod.evaluateDischarge(row)
  assert.equal(evaluation.conclusion, 'fail')
}

// 5. 历史已通过：结论沿用，不重判
{
  const row = {
    id: 5,
    status: '已通过',
    记录编号: 'T5',
    站点编号: 'S1',
    测量方法: '水面浮标法',
    断面流量: '42000 L/s',
    最大流速: '350 cm/s',
    过水面积: '12 m²',
  }
  const evaluation = mod.evaluateDischarge(row)
  assert.equal(evaluation.historical, true)
  assert.equal(evaluation.conclusion, 'pass', '历史审核结论沿用')
  assert.ok(evaluation.checks.every((check) => check.level === 'pass'))
  assert.ok(evaluation.summary.includes('历史审核结论沿用'))
}

// 6. 越级动作被状态机拒绝
{
  const reject = mod.guardTransition(mod.DISCHARGE_RULES, '已通过', '提交审核')
  assert.equal(reject.ok, false)
  assert.match(reject.message, /越级/)
  const approve = mod.guardTransition(mod.DISCHARGE_RULES, '已采集', '确认通过')
  assert.equal(approve.ok, false)
  assert.match(approve.message, /越级/)
  const valid = mod.guardTransition(mod.DISCHARGE_RULES, '待审核', '确认通过')
  assert.equal(valid.ok, true)
}

// 7. 并发审核单飞：同一锁键只推进一次
{
  let runs = 0
  const task = async () => {
    runs += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'ok'
  }
  const results = await Promise.allSettled([
    mod.runOnce('lock-x', task),
    mod.runOnce('lock-x', task),
  ])
  assert.equal(runs, 1, '任务体只执行一次')
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.name, 'ConflictError')
}

// 8. 服务层：fail 记录提交审核被拒且状态不变
{
  mod.resetStorage([
    {
      id: 10,
      status: '已采集',
      pending: true,
      abnormal: false,
      记录编号: 'F1',
      站点编号: 'S1',
      测量方法: '手工估算',
      断面流量: '',
      最大流速: '',
      过水面积: '',
      测量时间: '2025-01-01',
      记录状态: '已采集',
    },
  ])
  const result = await mod.transitionDischarge(10, '提交审核')
  assert.equal(result.ok, false)
  assert.match(result.message, /不通过/)
  const view = mod.getDischarge(10)
  assert.equal(String(view.row.status), '已采集', '被拒后状态不变，无半份状态')
  assert.equal(view.row.核对清单快照, undefined)
}

// 9. 服务层：正常记录提交审核 → 生成快照 → 确认通过
{
  mod.resetStorage([
    {
      id: 11, status: '已采集', pending: true, abnormal: false,
      记录编号: 'P1', 站点编号: 'S1', 测量方法: '声学多普勒法',
      断面流量: '12 m³/s', 最大流速: '2 m/s', 过水面积: '6 m²',
      测量时间: '2025-02-01', 记录状态: '已采集',
    },
  ])
  const submitted = await mod.transitionDischarge(11, '提交审核')
  assert.equal(submitted.ok, true, submitted.message)
  const view = mod.getDischarge(11)
  assert.equal(String(view.row.status), '待审核')
  assert.ok(view.row.核对清单快照, '提交审核留存清单快照')
  const approved = await mod.transitionDischarge(11, '确认通过')
  assert.equal(approved.ok, true)
  assert.equal(String(mod.getDischarge(11).row.status), '已通过')
}

// 10. 整编提交：范围含 fail 记录 → 拒绝，跨模块状态均不变
{
  mod.resetStorage([
    {
      id: 20, status: '已采集', pending: true, abnormal: false,
      记录编号: 'C1', 站点编号: 'S9', 测量方法: '手工估算',
      断面流量: '', 最大流速: '', 过水面积: '',
      测量时间: '2025-03-01', 记录状态: '已采集',
    },
  ])
  mod.seedCompilation([
    {
      id: 30, status: '整编中', pending: true, abnormal: false,
      成果编号: 'B1', 整编年份: '2025', 站点编号: 'S9', 整编类型: '流量',
      原始记录数: 1, 整编人: 'x', 审核人: '', 整编状态: '整编中',
    },
  ])

  const result = await mod.transitionCompilation(30, '提交审核')
  assert.equal(result.ok, false)
  assert.match(result.message, /核对不通过/)
  const cview = mod.getCompilation(30)
  assert.equal(String(cview.row.status), '整编中', '整编成果状态不变')
  const dview = mod.getDischarge(20)
  assert.equal(dview.row.补算结果, undefined, '流量记录没有被补算回写')
}

// 11. 整编提交成功：原子落状态 + 补算回写 + 清单快照
{
  mod.resetStorage([
    {
      id: 11, status: '已采集', pending: true, abnormal: false,
      记录编号: 'P1', 站点编号: 'S1', 测量方法: '声学多普勒法',
      断面流量: '', 最大流速: '2 m/s', 过水面积: '6 m²',
      测量时间: '2025-02-01', 记录状态: '已采集',
    },
  ])
  mod.seedCompilation([
    {
      id: 31, status: '整编中', pending: true, abnormal: false,
      成果编号: 'B2', 整编年份: '2025', 站点编号: 'S1', 整编类型: '流量',
      原始记录数: 1, 整编人: 'x', 审核人: '', 整编状态: '整编中',
    },
  ])
  const result = await mod.transitionCompilation(31, '提交审核')
  assert.equal(result.ok, true, result.message)
  const cview = mod.getCompilation(31)
  assert.equal(String(cview.row.status), '待审核')
  assert.ok(cview.checklist, '整编清单快照已留存')
  assert.equal(cview.checklist.items[0].computedFields.includes('断面流量'), true, '清单体现补算项')
  const dview = mod.getDischarge(11)
  assert.ok(String(dview.row.断面流量).includes('12'), '补算结果已回写流量记录')
  assert.ok(String(dview.row.补算结果).includes('断面流量'), '补算结果留痕')
}

fs.rmSync(path.join(root, 'test/.smoke-built.mjs'), { force: true })
console.log('smoke ok')
