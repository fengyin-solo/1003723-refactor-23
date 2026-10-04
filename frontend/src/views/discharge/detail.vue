<template>
  <section v-if="view" class="page detail-page" data-module="discharge-detail">
    <header class="page-head">
      <div>
        <h2>流量记录 {{ view.evaluation.recordNo }}</h2>
        <p class="page-desc">
          站点 {{ view.row.站点编号 }} · 测量时间 {{ view.row.测量时间 }} · 当前状态
          <span class="tag" :class="statusTone(String(view.row.status))">{{ view.row.status }}</span>
          <span class="tag" :class="view.evaluation.conclusion">{{ levelText(view.evaluation.conclusion) }}</span>
          <span v-if="view.evaluation.historical" class="tag">历史审核结论沿用</span>
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" :to="{ name: 'discharge' }">返回列表</RouterLink>
      </div>
    </header>

    <div class="detail-grid">
      <article class="detail-card">
        <h3>登记信息</h3>
        <dl class="detail-list">
          <template v-for="field in rawFields" :key="field.name">
            <dt>{{ field.name }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>
      </article>

      <article class="detail-card">
        <h3>统一判定：三量补算（SI）</h3>
        <p class="page-desc">断面流量 = 最大流速 × 过水面积；旧单位先换算，缺一项时按其余两项补算。</p>
        <table class="data-table">
          <thead>
            <tr><th>字段</th><th>原始登记</th><th>归一值（SI）</th><th>来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="field in measureFields" :key="field">
              <td>{{ field }}</td>
              <td>{{ view.evaluation.backfill.parsed[field].raw || '—' }}</td>
              <td>{{ formatValue(field) }}</td>
              <td>
                <span v-if="view.evaluation.backfill.computed.includes(field)" class="tag warning">补算</span>
                <span v-else-if="view.evaluation.backfill.parsed[field].converted" class="tag warning">旧单位换算</span>
                <span v-else class="tag pass">原值</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="page-desc">
          测量方法：{{ view.evaluation.method ?? '未识别' }}
          <span v-if="view.evaluation.legacy" class="tag warning">旧方法已归一</span>
        </p>
      </article>
    </div>

    <article class="detail-card">
      <h3>核对项</h3>
      <table class="data-table checklist-table">
        <thead>
          <tr><th>核对项</th><th>结论</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="check in view.evaluation.checks" :key="check.code">
            <td>{{ check.label }}</td>
            <td><span class="tag" :class="check.level">{{ levelText(check.level) }}</span></td>
            <td>{{ check.detail }}</td>
          </tr>
        </tbody>
      </table>
    </article>

    <article class="detail-card">
      <h3>审核动作</h3>
      <p class="page-desc">越级动作由统一状态机拒绝；同一记录并发审核只推进一次，失败不会改动状态。</p>
      <div class="detail-actions">
        <ReviewActionBar :actions="view.availableActions" :busy="busy" @action="runAction" />
        <button class="btn" type="button" @click="exportChecklist">导出本记录核对清单</button>
      </div>
      <p v-if="snapshot" class="page-desc">
        已留存提交审核清单：生成于 {{ snapshot.generatedAt }}，结论
        {{ snapshot.items[0]?.conclusion === 'pass' ? '通过' : '非通过' }}
      </p>
      <span v-if="message" class="error-text">{{ message }}</span>
    </article>

    <ChecklistPanel :checklist="snapshot" />
  </section>

  <section v-else class="page">
    <p class="empty-state">没有找到这条流量记录。</p>
    <RouterLink class="btn" :to="{ name: 'discharge' }">返回列表</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import ChecklistPanel from '@/components/ChecklistPanel.vue'
import ReviewActionBar from '@/components/ReviewActionBar.vue'
import { checklistToCsv } from '@/domain/discharge/checklist-csv'
import { buildChecklist } from '@/domain/discharge/evaluate'
import type { Checklist, MeasureField } from '@/domain/discharge/types'
import { downloadTextFile } from '@/api/download'
import { getDischarge, levelText, readSnapshot, transitionDischarge } from '@/api/discharge-service'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const id = Number(route.params.id)

const tick = ref(0)
const busy = ref(false)
const message = ref('')

const view = computed(() => {
  void tick.value
  return getDischarge(id)
})

const measureFields: MeasureField[] = ['断面流量', '最大流速', '过水面积']

const rawFields = computed(() =>
  ['记录编号', '站点编号', '测量时间', '记录状态']
    .map((name) => ({ name, value: view.value ? String(view.value.row[name] ?? '—') : '—' })),
)

const snapshot = computed<Checklist | null>(() => (view.value ? readSnapshot(view.value.row) : null))

function formatValue(field: MeasureField): string {
  if (!view.value) {
    return '—'
  }
  const value = view.value.evaluation.backfill.values[field]
  if (value === null) {
    return '无法补算'
  }
  const unit = field === '断面流量' ? 'm³/s' : field === '最大流速' ? 'm/s' : 'm²'
  return `${value} ${unit}`
}

function statusTone(status: string): 'pass' | 'warning' | 'fail' {
  if (status === '已通过') {
    return 'pass'
  }
  if (status === '异常值') {
    return 'fail'
  }
  return 'warning'
}

async function runAction(action: string) {
  message.value = ''
  busy.value = true
  const result = await transitionDischarge(id, action)
  busy.value = false
  if (!result.ok) {
    message.value = result.message
    return
  }
  tick.value += 1
}

function exportChecklist() {
  if (!view.value) {
    return
  }
  const row: EntryRow = view.value.row
  const checklist = buildChecklist([row], `流量记录 ${String(row.记录编号 ?? id)} 详情核对`)
  downloadTextFile(`流量记录-${String(row.记录编号 ?? id)}-核对清单.csv`, checklistToCsv(checklist))
}
</script>
