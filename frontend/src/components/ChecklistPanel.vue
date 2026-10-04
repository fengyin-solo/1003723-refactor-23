<template>
  <div v-if="checklist" class="checklist-panel">
    <header class="checklist-head">
      <div>
        <h4>核对清单</h4>
        <p class="page-desc">{{ checklist.scope }} · 生成于 {{ formatTime(checklist.generatedAt) }}</p>
      </div>
      <div class="checklist-counts">
        <span class="tag pass">通过 {{ checklist.pass }}</span>
        <span class="tag warning">预警 {{ checklist.warning }}</span>
        <span class="tag fail">不通过 {{ checklist.fail }}</span>
        <span class="tag">合计 {{ checklist.total }}</span>
      </div>
    </header>
    <table class="data-table checklist-table">
      <thead>
        <tr>
          <th>记录编号</th>
          <th>站点</th>
          <th>测量方法（归一）</th>
          <th>补算</th>
          <th>结论</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in checklist.items" :key="item.id">
          <td>{{ item.recordNo }}</td>
          <td>{{ item.station }}</td>
          <td>
            {{ item.method ?? '未识别' }}
            <span v-if="item.legacy" class="tag warning">旧方法</span>
          </td>
          <td>{{ item.computedFields.join('、') || '—' }}</td>
          <td><span class="tag" :class="item.conclusion">{{ levelText(item.conclusion) }}</span></td>
          <td class="checklist-detail">
            <div v-if="item.historical" class="muted-text">历史审核结论沿用</div>
            <ul class="check-list">
              <li
                v-for="note in item.conversionNotes"
                :key="note"
                class="muted-text"
              >{{ note }}</li>
              <li
                v-for="check in item.checks.filter((entry) => entry.level !== 'pass')"
                :key="check.code"
                :class="check.level"
              >{{ check.label }}：{{ check.detail }}</li>
            </ul>
          </td>
        </tr>
      </tbody>
    </table>
    <slot />
  </div>
  <p v-else class="muted-text">暂无核对清单快照：该记录尚未提交审核，可在列表入口导出实时核对清单。</p>
</template>

<script setup lang="ts">
import type { Checklist, ConclusionLevel } from '@/domain/discharge/types'

defineProps<{
  checklist: Checklist | null
}>()

const LEVEL_TEXT: Record<ConclusionLevel, string> = { pass: '通过', warning: '预警', fail: '不通过' }

function levelText(level: ConclusionLevel): string {
  return LEVEL_TEXT[level]
}

function formatTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString()
}
</script>
