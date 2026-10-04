<template>
  <span class="row-actions">
    <button
      v-for="action in actions"
      :key="action"
      class="link"
      type="button"
      :disabled="busy"
      @click="$emit('action', action)"
    >
      {{ action }}
    </button>
    <span v-if="!actions.length" class="muted-text">无可用动作</span>
  </span>
</template>

<script setup lang="ts">
// 可用动作由领域状态机算好再传进来：越级、重复的动作按钮不渲染，拒绝逻辑前后端同一份。
defineProps<{
  actions: string[]
  busy?: boolean
}>()

defineEmits<{
  (event: 'action', action: string): void
}>()
</script>
