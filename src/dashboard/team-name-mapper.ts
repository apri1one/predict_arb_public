/**
 * 球队名称归一化与别名映射
 *
 * 目标：
 * 1. 统一不同平台/不同字段中的队名写法
 * 2. 支持足球对阵三项盘分组时的队名判等
 */

const TRAILING_GENERIC_TOKENS = new Set([
    'fc', 'cf', 'club', 'sc', 'afc', 'ac', 'calcio'
]);

/**
 * 先做文本层标准化（小写、去重音、去符号、压缩空白）
 */
function normalizeText(input: string): string {
    if (!input) return '';

    return input
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // 去重音符号
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 通用归一化：移除尾部通用后缀（如 FC/CF/Club）
 */
export function normalizeTeamName(input: string): string {
    const normalized = normalizeText(input);
    if (!normalized) return '';

    const tokens = normalized.split(' ').filter(Boolean);
    while (tokens.length > 1 && TRAILING_GENERIC_TOKENS.has(tokens[tokens.length - 1])) {
        tokens.pop();
    }

    return tokens.join(' ');
}

/**
 * 别名映射表（key/value 均使用 normalizeTeamName 结果）
 * value 表示标准化后的 canonical 名
 */
export const TEAM_ALIAS_MAP: Record<string, string> = {
    // 用户反馈场景
    'oviedo': 'real oviedo',
    'real oviedo': 'real oviedo',
    'athletic bilbao': 'athletic club',
    'ath bilbao': 'athletic club',
    'athletic club': 'athletic club',

    // 常见英超/西甲简称
    'man utd': 'manchester united',
    'man united': 'manchester united',
    'manchester utd': 'manchester united',
    'manchester united': 'manchester united',
    'tottenham': 'tottenham hotspur',
    'spurs': 'tottenham hotspur',
    'tottenham hotspur': 'tottenham hotspur',
};

/**
 * 输出 canonical 形式（用于分组/比较）
 */
export function toCanonicalTeam(input: string): string {
    const normalized = normalizeTeamName(input);
    if (!normalized) return '';
    return TEAM_ALIAS_MAP[normalized] || normalized;
}

/**
 * 判定两队名是否等价
 */
export function isSameTeam(a: string, b: string): boolean {
    const left = toCanonicalTeam(a);
    const right = toCanonicalTeam(b);
    return !!left && !!right && left === right;
}
