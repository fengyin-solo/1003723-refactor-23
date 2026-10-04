import type { MethodSpec } from './types'

// 标准测流方法目录（《河流流量测验规范》常用测速法）。
// 旧方法名一律归一到这份目录；命中 aliases 视为旧方法，按 legacy 留痕，值照常换算。
export const DISCHARGE_METHODS: MethodSpec[] = [
  {
    key: 'velocity-area',
    standard: '流速面积法',
    aliases: ['流速仪法', '多点法', '五点法', '三点法'],
    vmax: 8,
  },
  {
    key: 'one-point',
    standard: '一点法',
    aliases: ['0.6一点法', '相对水深0.6法'],
    vmax: 6,
    legacy: true,
  },
  {
    key: 'integrating',
    standard: '积深法',
    aliases: ['积点法', '积深测速'],
    vmax: 8,
    legacy: true,
  },
  {
    key: 'float',
    standard: '浮标法',
    aliases: ['水面浮标法', '浮标测流'],
    vmax: 5,
    legacy: true,
  },
  {
    key: 'adcp',
    standard: '声学多普勒法',
    aliases: ['ADCP', '多普勒剖面法'],
    vmax: 10,
  },
  {
    key: 'weir',
    standard: '量水堰槽法',
    aliases: ['量水堰', '堰板法', '薄壁堰'],
    vmax: 4,
    legacy: true,
  },
  {
    key: 'slope-area',
    standard: '比降面积法',
    aliases: ['比降法', '水面比降法'],
    vmax: 8,
    legacy: true,
  },
]

export interface ResolvedMethod {
  spec: MethodSpec | null
  /** 命中的是不是旧方法名（含标准方法但目录本身标 legacy 的历史用法）。 */
  legacy: boolean
}

/** 方法名归一：先完全相等匹配，再按包含关系兜底；匹配不到交给核对项判 fail。 */
export function resolveMethod(raw: string): ResolvedMethod {
  const name = raw.trim()
  if (!name) {
    return { spec: null, legacy: false }
  }
  for (const spec of DISCHARGE_METHODS) {
    if (spec.standard === name) {
      return { spec, legacy: Boolean(spec.legacy) }
    }
  }
  for (const spec of DISCHARGE_METHODS) {
    if ([...spec.aliases, spec.standard].some((alias) => name.includes(alias))) {
      return { spec, legacy: true }
    }
  }
  return { spec: null, legacy: false }
}
