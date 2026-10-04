<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">整编链路复用流量监测统一判定：方法换算、三值补算与结论同列表、详情完全一致，并随整编动作产出核对清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openReport(row)">整编核对清单</button>
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="pendingRow === Number(row.id)"
              @click="runAction(action, row)"
            >
              {{ pendingKey === `${Number(row.id)}:${action}` ? '处理中…' : action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">终态不可越级</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="reportOpen" class="drawer-mask" @click.self="closeReport">
      <section class="drawer">
        <header class="drawer-head">
          <h3>整编核对清单（流量监测）</h3>
          <button class="btn ghost" type="button" @click="closeReport">关闭</button>
        </header>
        <p class="report-summary">
          共 {{ report?.total ?? 0 }} 条；合格 {{ report?.passCount ?? 0 }} 条（历史沿用
          {{ report?.inheritedCount ?? 0 }}），需复核 {{ report?.reviewCount ?? 0 }} 条，不合格
          {{ report?.failCount ?? 0 }} 条，异常隔离 {{ report?.excludedCount ?? 0 }} 条
        </p>
        <p class="verdict-line">
          整编结论：<span :class="reportClass">{{ report?.conclusion }}</span>
        </p>
        <table class="check-table">
          <thead>
            <tr><th>整编核对项</th><th>级别</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="check in report?.checks ?? []" :key="check.name">
              <td>{{ check.name }}</td>
              <td><span class="tag" :class="`tag-${check.level}`">{{ levelLabel(check.level) }}</span></td>
              <td>{{ check.message }}</td>
            </tr>
          </tbody>
        </table>

        <h4 class="sub-title">逐条记录结论（与流量入口同一判定）</h4>
        <table class="check-table">
          <thead>
            <tr><th>记录编号</th><th>方法</th><th>流量</th><th>流速</th><th>面积</th><th>记录状态</th><th>结论</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in report?.items ?? []" :key="item.id" :class="{ 'row-excluded': item.status === '异常值' }">
              <td>{{ item.code }}</td>
              <td>{{ item.method.label }}</td>
              <td>{{ item.resolved.flow ?? '—' }}</td>
              <td>{{ item.resolved.velocity ?? '—' }}</td>
              <td>{{ item.resolved.area ?? '—' }}</td>
              <td>{{ item.status || '—' }}</td>
              <td :class="item.status === '异常值' ? 'verdict-excluded' : `verdict-${item.verdict}`">
                {{ item.status === '异常值' ? `异常隔离（复算：${item.conclusion}）` : item.conclusion }}
              </td>
            </tr>
          </tbody>
        </table>

        <footer class="drawer-foot">
          <button class="btn primary" type="button" @click="downloadReport">下载整编核对清单</button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  downloadText,
  listEntries,
  moduleMeta,
  runActionSerialized,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { buildDischargeReport, compilationReportCsv, levelLabel } from '@/domain/discharge'
import type { DischargeReport } from '@/domain/discharge'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compilation')
const columns = meta.fields

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const pendingRow = ref<number | null>(null)
const pendingKey = ref('')
const reportOpen = ref(false)
const report = ref<DischargeReport | null>(null)

const statuses = meta.statuses
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const reportClass = computed(() => {
  if (!report.value) {
    return ''
  }
  return report.value.failCount > 0
    ? 'verdict-fail'
    : report.value.reviewCount > 0
      ? 'verdict-review'
      : 'verdict-pass'
})

const stats = computed(() => [
  { label: '待整编年度', value: rows.value.filter((row) => String(row.status) === '待整编').length },
  { label: '整编中年度', value: rows.value.filter((row) => String(row.status) === '整编中' || String(row.status) === '待审核').length },
  { label: '已刊印成果', value: rows.value.filter((row) => String(row.status) === '已刊印').length },
])

function actionsFor(row: EntryRow): string[] {
  return availableActions(meta, String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function openReport(_row: EntryRow) {
  // 所有整编成果看到的都是同一份实时判定结果，与流量入口、导出文件一致。
  report.value = buildDischargeReport(listRows('discharge'))
  reportOpen.value = true
}

function closeReport() {
  reportOpen.value = false
}

function downloadReport() {
  if (!report.value) {
    return
  }
  downloadText(`${meta.name}-流量核对清单.csv`, compilationReportCsv(report.value))
}

async function runAction(action: string, row: EntryRow) {
  if (pendingRow.value !== null) {
    errorMessage.value = '该整编成果已有动作在处理，并发审核只推进一次'
    return
  }
  errorMessage.value = ''
  const id = Number(row.id)
  pendingRow.value = id
  pendingKey.value = `${id}:${action}`
  try {
    const result = await runActionSerialized(meta.key, id, action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
  } finally {
    pendingRow.value = null
    pendingKey.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.tag { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; }
.tag-pass { background: #e7f6ec; color: #1a7f37; }
.tag-warn { background: #fdf0d5; color: #b45309; }
.tag-fail { background: #fbe7e5; color: #b42318; }
.tag-info { background: #e8eefc; color: #1f6feb; }
.verdict-pass { color: #1a7f37; font-weight: 600; }
.verdict-review { color: #b45309; font-weight: 600; }
.verdict-fail { color: #b42318; font-weight: 600; }
.verdict-excluded { color: var(--muted); }
.row-excluded { background: #f3f5f8; }
.muted-text { color: var(--muted); font-size: 12px; }
.drawer-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; justify-content: center; align-items: flex-start; z-index: 20; padding: 40px 16px; overflow-y: auto; }
.drawer { width: 860px; max-width: 100%; background: #fff; border-radius: 10px; padding: 18px 20px; }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.drawer-head h3 { margin: 0; font-size: 16px; }
.report-summary { font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
.verdict-line { font-size: 13px; margin: 4px 0 12px; }
.sub-title { font-size: 13px; margin: 18px 0 8px; }
.check-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.check-table th, .check-table td { border: 1px solid var(--border); padding: 6px 8px; font-size: 12px; text-align: left; vertical-align: top; }
.drawer-foot { margin-top: 14px; display: flex; justify-content: flex-end; }
button.link:disabled { color: #9aa6b2; cursor: not-allowed; }
</style>
