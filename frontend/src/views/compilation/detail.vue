<template>
  <section v-if="view" class="page detail-page" data-module="compilation-detail">
    <header class="page-head">
      <div>
        <h2>整编成果 {{ view.row.成果编号 }}</h2>
        <p class="page-desc">
          {{ view.row.整编年份 }} 年 · {{ view.row.站点编号 }} · {{ view.row.整编类型 }} · 当前状态
          <span class="tag" :class="statusTone(String(view.row.status))">{{ view.row.status }}</span>
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" :to="{ name: 'compilation' }">返回列表</RouterLink>
      </div>
    </header>

    <div class="detail-grid">
      <article class="detail-card">
        <h3>成果信息</h3>
        <dl class="detail-list">
          <template v-for="field in rawFields" :key="field.name">
            <dt>{{ field.name }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>
      </article>

      <article class="detail-card">
        <h3>整编范围（{{ view.evaluations.length }} 条流量记录）</h3>
        <p class="page-desc">结论全部来自流量统一判定，与流量列表、记录详情完全一致；历史已通过记录沿用旧结论。</p>
        <table class="data-table">
          <thead>
            <tr><th>记录编号</th><th>测量方法（归一）</th><th>断面流量</th><th>最大流速</th><th>过水面积</th><th>结论</th></tr>
          </thead>
          <tbody>
            <tr v-for="evaluation in view.evaluations" :key="evaluation.id">
              <td>
                <RouterLink class="link" :to="{ name: 'discharge-detail', params: { id: evaluation.id } }">
                  {{ evaluation.recordNo }}
                </RouterLink>
              </td>
              <td>{{ evaluation.method ?? '未识别' }}<span v-if="evaluation.legacy" class="tag warning">旧</span></td>
              <td>{{ formatMeasure(evaluation, '断面流量') }}</td>
              <td>{{ formatMeasure(evaluation, '最大流速') }}</td>
              <td>{{ formatMeasure(evaluation, '过水面积') }}</td>
              <td><span class="tag" :class="evaluation.conclusion">{{ levelText(evaluation.conclusion) }}</span></td>
            </tr>
            <tr v-if="!view.evaluations.length">
              <td colspan="6" class="empty-state">该成果范围内没有流量记录（年份/站点不匹配）</td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>

    <article class="detail-card">
      <h3>整编动作</h3>
      <p class="page-desc">
        提交审核：先跑统一核对，任一记录不通过即拒绝；通过后成果状态、三量补算回写、清单快照原子提交，失败不留半份状态。
      </p>
      <div class="detail-actions">
        <ReviewActionBar :actions="view.availableActions" :busy="busy" @action="runAction" />
        <button class="btn" type="button" @click="exportChecklist">导出该成果核对清单</button>
      </div>
      <span v-if="message" class="error-text">{{ message }}</span>
    </article>

    <ChecklistPanel :checklist="view.checklist" />
  </section>

  <section v-else class="page">
    <p class="empty-state">没有找到这条整编成果。</p>
    <RouterLink class="btn" :to="{ name: 'compilation' }">返回列表</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import ChecklistPanel from '@/components/ChecklistPanel.vue'
import ReviewActionBar from '@/components/ReviewActionBar.vue'
import {
  downloadCompilationChecklist,
  getCompilation,
  levelText,
  transitionCompilation,
} from '@/api/compilation-service'
import type { DischargeEvaluation, MeasureField } from '@/domain/discharge/types'

const route = useRoute()
const id = Number(route.params.id)

const tick = ref(0)
const busy = ref(false)
const message = ref('')

const view = computed(() => {
  void tick.value
  return getCompilation(id)
})

const rawFields = computed(() =>
  ['整编年份', '站点编号', '整编类型', '整编人', '审核人', '关联记录数', '核对结论'].map((name) => ({
    name,
    value: view.value && view.value.row[name] !== undefined && view.value.row[name] !== '' ? String(view.value.row[name]) : '—',
  })),
)

const UNIT: Record<MeasureField, string> = {
  断面流量: 'm³/s',
  最大流速: 'm/s',
  过水面积: 'm²',
}

function formatMeasure(evaluation: DischargeEvaluation, field: MeasureField): string {
  const value = evaluation.backfill.values[field]
  if (value === null) {
    return '—'
  }
  const suffix = evaluation.backfill.computed.includes(field) ? '（补算）' : ''
  return `${value} ${UNIT[field]}${suffix}`
}

function statusTone(status: string): 'pass' | 'warning' | 'fail' {
  if (status === '已刊印') {
    return 'pass'
  }
  if (status === '已驳回') {
    return 'fail'
  }
  return 'warning'
}

async function runAction(action: string) {
  message.value = ''
  busy.value = true
  const result = await transitionCompilation(id, action)
  busy.value = false
  if (!result.ok) {
    message.value = result.message
    return
  }
  tick.value += 1
}

function exportChecklist() {
  const result = downloadCompilationChecklist(id)
  if (!result.ok) {
    message.value = result.message
  }
}
</script>
