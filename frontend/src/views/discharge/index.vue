<template>
  <section class="page" data-module="discharge">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">测量方法归一、断面流量/最大流速/过水面积补算与核对结论统一判定，动作、详情与整编链路共用同一套结论。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记流量记录</button>
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
        <button class="btn" type="button" @click="exportChecklist">导出核对清单</button>
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
          <th>核对结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in views" :key="String(view.row.id)" class="clickable-row" @click="openDetail(view.row.id)">
          <td>{{ view.row.记录编号 }}</td>
          <td>{{ view.row.站点编号 }}</td>
          <td>{{ methodText(view.row) }}</td>
          <td>{{ fieldText(view.row, '断面流量') }}</td>
          <td>{{ fieldText(view.row, '最大流速') }}</td>
          <td>{{ fieldText(view.row, '过水面积') }}</td>
          <td>{{ view.row.测量时间 }}</td>
          <td>{{ view.row.记录状态 }}</td>
          <td><span class="tag" :class="view.evaluation.conclusion">{{ levelText(view.evaluation.conclusion) }}</span></td>
          <td @click.stop>
            <ReviewActionBar :actions="view.availableActions" :busy="busyId === Number(view.row.id)" @action="(action) => runAction(action, view.row)" />
          </td>
        </tr>
        <tr v-if="!views.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无流量监测数据，可先登记流量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import ReviewActionBar from '@/components/ReviewActionBar.vue'
import { downloadEntries } from '@/api/local-service'
import {
  downloadDischargeChecklist,
  fieldText,
  levelText,
  listDischarge,
  methodText,
  transitionDischarge,
} from '@/api/discharge-service'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const columns = ['记录编号', '站点编号', '测量方法', '断面流量', '最大流速', '过水面积', '测量时间', '记录状态']
const filterFields = ['记录编号', '站点编号', '测量方法']

const views = ref(listDischarge())
const total = computed(() => views.value.length)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const busyId = ref<number | null>(null)

const statusSummary = computed(() =>
  ['已采集', '待审核', '已通过', '异常值'].map((status) => ({
    status,
    count: views.value.filter((view) => String(view.row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '今日测量次数', value: views.value.length },
  {
    label: '待审核记录',
    value: views.value.filter((view) => String(view.row.status) === '待审核').length,
  },
  {
    label: '核对不通过',
    value: views.value.filter((view) => view.evaluation.conclusion === 'fail').length,
  },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('discharge')
}

function exportChecklist() {
  downloadDischargeChecklist()
}

function openCreate() {
  errorMessage.value = '流量记录登记入口尚未接入审批流'
}

function openDetail(id: number) {
  void router.push({ name: 'discharge-detail', params: { id } })
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  busyId.value = Number(row.id)
  const result = await transitionDischarge(Number(row.id), action)
  busyId.value = null
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  views.value = listDischarge(filters.value)
}

onMounted(reload)
</script>
