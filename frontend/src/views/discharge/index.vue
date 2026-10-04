<template>
  <section class="page" data-module="discharge">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">测量方法换算、断面流量/最大流速/过水面积补算与校核结论统一判定，列表、详情与整编清单共用同一结论。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记流量记录</button>
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
        <button class="btn" type="button" @click="exportChecklist">导出整站核对清单</button>
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
          <th>校核结论</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in evaluations" :key="String(item.id)">
          <td>{{ item.code }}</td>
          <td>{{ item.station }}</td>
          <td>{{ item.method.label }}<span v-if="item.method.convertedFrom" class="tag tag-info">旧记法换算</span></td>
          <td>
            {{ item.resolved.flow ?? '—' }}
            <span v-if="item.backfilled.some((b) => b.metric === '断面流量')" class="tag tag-warn">补算</span>
          </td>
          <td>
            {{ item.resolved.velocity ?? '—' }}
            <span v-if="item.backfilled.some((b) => b.metric === '最大流速')" class="tag tag-warn">补算</span>
          </td>
          <td>
            {{ item.resolved.area ?? '—' }}
            <span v-if="item.backfilled.some((b) => b.metric === '过水面积')" class="tag tag-warn">补算</span>
          </td>
          <td>{{ String(rows.find((r) => Number(r.id) === item.id)?.['测量时间'] ?? '') }}</td>
          <td>
            <span class="verdict" :class="`verdict-${item.verdict}`">{{ item.conclusion }}</span>
          </td>
          <td>{{ rowStatus(item.id) }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(item.id)">核对清单</button>
            <button
              v-for="action in actionsFor(item.id)"
              :key="action"
              class="link"
              type="button"
              :disabled="pendingKey === `${item.id}:${action}` || pendingRow === item.id"
              @click="runAction(action, item.id)"
            >
              {{ pendingKey === `${item.id}:${action}` ? '处理中…' : action }}
            </button>
            <span v-if="!actionsFor(item.id).length" class="muted-text">终态不可越级</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无流量监测数据，可先登记流量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <section class="drawer">
        <header class="drawer-head">
          <h3>{{ detail.code }} 核对清单</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <div><dt>站点编号</dt><dd>{{ detail.station }}</dd></div>
          <div><dt>测量方法</dt><dd>{{ detail.method.label }}（系数 {{ detail.method.coefficient }}）</dd></div>
          <div><dt>断面流量</dt><dd>{{ detail.resolved.flow ?? '—' }}</dd></div>
          <div><dt>最大流速</dt><dd>{{ detail.resolved.velocity ?? '—' }}</dd></div>
          <div><dt>过水面积</dt><dd>{{ detail.resolved.area ?? '—' }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ rowStatus(detail.id) }}</dd></div>
        </dl>
        <p class="verdict-line">
          统一校核结论：<span class="verdict" :class="`verdict-${detail.verdict}`">{{ detail.conclusion }}</span>
        </p>
        <table class="check-table">
          <thead>
            <tr><th>检查项</th><th>级别</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="check in detail.checks" :key="check.name">
              <td>{{ check.name }}</td>
              <td><span class="tag" :class="`tag-${check.level}`">{{ levelLabel(check.level) }}</span></td>
              <td>{{ check.message }}</td>
            </tr>
          </tbody>
        </table>
        <footer class="drawer-foot">
          <button class="btn primary" type="button" @click="downloadDetailChecklist">下载本条核对清单</button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  downloadText,
  listEntries,
  moduleMeta,
  runActionSerialized,
  availableActions,
} from '@/api/local-service'
import {
  buildDischargeReport,
  compilationReportCsv,
  dischargeChecklistCsv,
  evaluateEntry,
  levelLabel,
} from '@/domain/discharge'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('discharge')
const columns = ['记录编号', '站点编号', '测量方法', '断面流量', '最大流速', '过水面积', '测量时间']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 并发保护：同一记录同时只允许一个动作在途。
const pendingRow = ref<number | null>(null)
const pendingKey = ref('')
const detailId = ref<number | null>(null)

const statuses = meta.statuses
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 列表结论与详情、整编同源于 evaluateEntry，不再各写一套。
const evaluations = computed(() => rows.value.map(evaluateEntry))
const detail = computed(() => evaluations.value.find((item) => item.id === detailId.value) ?? null)

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '今日测量次数', value: rows.value.filter((row) => String(row['测量时间']) === today).length },
    { label: '待审核记录', value: rows.value.filter((row) => String(row.status) === '待审核').length },
    {
      label: '异常/不合格记录',
      value: evaluations.value.filter((item) => String(rowStatus(item.id)) === '异常值' || item.verdict === 'fail').length,
    },
  ]
})

function rowStatus(id: number): string {
  return String(rows.value.find((row) => Number(row.id) === id)?.status ?? '')
}

function actionsFor(id: number): string[] {
  return availableActions(meta, rowStatus(id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// 该入口一并产出核对清单：与整编链路同一份 buildDischargeReport 结果。
function exportChecklist() {
  const report = buildDischargeReport(rows.value)
  downloadText(`${meta.name}-核对清单.csv`, compilationReportCsv(report))
}

function downloadDetailChecklist() {
  if (!detail.value) {
    return
  }
  downloadText(`${detail.value.code}-核对清单.csv`, dischargeChecklistCsv(detail.value))
}

function openCreate() {
  errorMessage.value = '流量记录登记入口尚未接入审批流'
}

function openDetail(id: number) {
  detailId.value = id
}

function closeDetail() {
  detailId.value = null
}

async function runAction(action: string, id: number) {
  if (pendingRow.value !== null) {
    errorMessage.value = '该记录已有动作在处理，并发审核只推进一次'
    return
  }
  errorMessage.value = ''
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
    errorMessage.value = error instanceof Error ? error.message : '流量监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.tag { display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; }
.tag-pass { background: #e7f6ec; color: #1a7f37; }
.tag-warn { background: #fdf0d5; color: #b45309; }
.tag-fail { background: #fbe7e5; color: #b42318; }
.tag-info { background: #e8eefc; color: #1f6feb; }
.verdict { font-weight: 600; }
.verdict-pass { color: #1a7f37; }
.verdict-review { color: #b45309; }
.verdict-fail { color: #b42318; }
.muted-text { color: var(--muted); font-size: 12px; }
.drawer-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; justify-content: flex-end; z-index: 20; }
.drawer { width: 640px; max-width: 92vw; background: #fff; height: 100%; padding: 18px 20px; overflow-y: auto; }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.drawer-head h3 { margin: 0; font-size: 16px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin: 14px 0; }
.detail-grid dt { color: var(--muted); font-size: 12px; }
.detail-grid dd { margin: 2px 0 0; font-size: 13px; }
.verdict-line { font-size: 13px; margin: 6px 0 12px; }
.check-table { width: 100%; border-collapse: collapse; }
.check-table th, .check-table td { border: 1px solid var(--border); padding: 6px 8px; font-size: 12px; text-align: left; vertical-align: top; }
.drawer-foot { margin-top: 14px; display: flex; justify-content: flex-end; }
button.link:disabled { color: #9aa6b2; cursor: not-allowed; }
</style>
