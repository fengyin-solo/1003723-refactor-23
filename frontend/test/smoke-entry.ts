// 冒烟测试统一入口：给纯前端存储打一个内存版 localStorage，再转出被测 API。
const memory = new Map<string, string>()

const storageLike = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
  clear: () => memory.clear(),
}

Object.defineProperty(globalThis, 'window', {
  value: { localStorage: storageLike },
  configurable: true,
  writable: true,
})
Object.defineProperty(globalThis, 'localStorage', {
  value: storageLike,
  configurable: true,
  writable: true,
})

export { evaluateDischarge, buildChecklist } from '@/domain/discharge/evaluate'
export { DISCHARGE_RULES, COMPILATION_RULES, guardTransition, runOnce, ConflictError } from '@/domain/discharge/workflow'
export { transitionDischarge, getDischarge } from '@/api/discharge-service'
export { transitionCompilation, getCompilation } from '@/api/compilation-service'
import { commitRows, listRows, storageKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

/** 用指定的 discharge 播种数据重置存储（其他模块先放空，保证测试彼此隔离）。 */
export function resetStorage(dischargeRows: EntryRow[]): void {
  commitRows({ discharge: dischargeRows, compilation: [] })
}

/** 测试里单独补播整编成果（会覆盖整组 compilation 数据）。 */
export function seedCompilation(rows: EntryRow[]): void {
  commitRows({ compilation: rows })
}

export function currentDischargeRows(): EntryRow[] {
  return listRows('discharge')
}

export { storageKey }
