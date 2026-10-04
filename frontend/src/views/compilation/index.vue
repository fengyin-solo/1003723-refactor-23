<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">整编动作复用流量统一核对：提交审核时先跑核对清单，不通过直接拒绝；成果状态、补算回写、清单快照原子提交。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
        <button class="btn" type="button" @click="exportMasterChecklist">导出整编核对清单</button>
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
          <th>范围核对结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in views" :key="String(view.row.id)" class="clickable-row" @click="openDetail(Number(view.row.id))">
          <td>{{ view.row.成果编号 }}</td>
          <td>{{ view.row.整编年份 }}</td>
          <td>{{ view.row.站点编号 }}</td>
          <td>{{ view.row.整编类型 }}</td>
          <td>{{ view.evaluations.length }}</td>
          <td>{{ view.row.整编人 }}</td>
          <td>{{ view.row.审核人 || '—' }}</td>
          <td>{{ view.row.整编状态 }}</td>
          <td>
            <span v-for="tone in tonesOf(view)" :key="tone.level" class="tag" :class="tone.level">{{ tone.text }}</span>
            <span v-if="!view.evaluations.length" class="tag fail">范围内无记录</span>
          </td>
          <td @click.stop>
            <ReviewActionBar :actions="view.availableActions" :busy="busyId === Number(view.row.id)" @action="(action) => runAction(action, view.row)" />
          </td>
        </tr>
        <tr v-if="!views.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import ReviewActionBar from '@/components/ReviewActionBar.vue'
import { downloadEntries } from '@/api/local-service'
import { listCompilation, transitionCompilation } from '@/api/compilation-service'
import { buildChecklist } from '@/domain/discharge/evaluate'
import { checklistToCsv } from '@/domain/discharge/checklist-csv'
import { listRows } from '@/data/local-store'
import { downloadTextFile } from '@/api/download'
import type { ConclusionLevel } from '@/domain/discharge/types'
import type { CompilationRowView } from '@/api/compilation-service'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const columns = ['成果编号', '整编年份', '站点编号', '整编类型', '原始记录数', '整编人', '审核人', '整编状态']
const filterFields = ['成果编号', '整编年份', '站点编号']

const views = ref<CompilationRowView[]>([])
const total = computed(() => views.value.length)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const busyId = ref<number | null>(null)

const statusSummary = computed(() =>
  ['待整编', '整编中', '待审核', '已刊印', '已驳回'].map((status) => ({
    status,
    count: views.value.filter((view) => String(view.row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '整编成果', value: views.value.length },
  {
    label: '整编中',
    value: views.value.filter((view) => String(view.row.status) === '整编中').length,
  },
  {
    label: '范围有不通过项',
    value: views.value.filter((view) => view.evaluations.some((item) => item.conclusion === 'fail')).length,
  },
])

function tonesOf(view: CompilationRowView): { level: ConclusionLevel; text: string }[] {
  const counts = { pass: 0, warning: 0, fail: 0 }
  for (const item of view.evaluations) {
    counts[item.conclusion] += 1
  }
  return (Object.entries(counts) as [ConclusionLevel, number][])
    .filter(([, count]) => count > 0)
    .map(([level, count]) => ({ level, text: `${level === 'pass' ? '通过' : level === 'warning' ? '预警' : '不通过'} ${count}` }))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('compilation')
}

/** 整编清单结论：不分成果，把全部流量记录按统一判定汇总一份。 */
function exportMasterChecklist() {
  const checklist = buildChecklist(listRows('discharge'), '数据整编·全部流量记录核对清单')
  downloadTextFile(`数据整编-核对清单-${checklist.generatedAt.slice(0, 10)}.csv`, checklistToCsv(checklist))
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function openDetail(id: number) {
  void router.push({ name: 'compilation-detail', params: { id } })
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  busyId.value = Number(row.id)
  const result = await transitionCompilation(Number(row.id), action)
  busyId.value = null
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  views.value = listCompilation(filters.value)
}

onMounted(reload)
</script>
