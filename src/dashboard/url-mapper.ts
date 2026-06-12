/**
 * URL Mapper - 建立市场 ID 到 URL slug 的映射
 *
 * Predict URL 格式: https://predict.fun/market/{slug}
 * Polymarket URL 格式: https://polymarket.com/event/{event_slug}/{market_slug}
 *
 * 策略:
 * 1. Polymarket: 使用 Gamma API 返回的 slug (准确)
 * 2. Predict: 生成 slug -> 验证 -> 缓存
 */

import fs from 'fs';
import path from 'path';

export interface UrlMapping {
    predictMarketId: number;
    predictSlug: string;
    predictSlugVerified: boolean;  // 是否验证过
    polymarketConditionId: string;
    polymarketEventSlug: string;
    polymarketMarketSlug: string;
    title: string;
    lastUpdated: number;
}

// 缓存映射表
const predictSlugCache = new Map<number, { slug: string; verified: boolean }>();
const polySlugCache = new Map<string, { eventSlug: string; marketSlug: string; groupItemTitle?: string }>();
const predictTitleSlugCache = new Map<string, string>();  // 标题 -> slug (浏览器抓取)
const predictNormalizedTitleCache = new Map<string, string>();  // 规范化标题 -> slug (模糊匹配)

/**
 * 规范化标题用于模糊匹配
 * 去掉日期、数字、特殊字符，只保留核心词汇
 */
function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        // 去掉日期占位符
        .replace(/___/g, '')
        // 去掉具体日期 (January 15, 2026 等)
        .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b\s*\d{0,2},?\s*/gi, '')
        // 去掉年份前的 "in" 或 "by" 后面的日期部分
        .replace(/\b(by|in|on|before|after)\s+\d{1,2}(st|nd|rd|th)?\s*(,\s*)?/gi, '$1 ')
        // 去掉独立的年份 (2024, 2025, 2026 等) - 但保留在词中间的
        .replace(/\b20\d{2}\b/g, '')
        // 去掉问号和其他标点
        .replace(/[?!.,;:'"()[\]{}]/g, '')
        // 合并多余空格
        .replace(/\s+/g, ' ')
        .trim();
}

// 缓存文件路径
const CACHE_DIR = path.join(process.cwd(), 'data');
const PREDICT_CACHE_FILE = path.join(CACHE_DIR, 'predict-slugs.json');
const POLY_CACHE_FILE = path.join(CACHE_DIR, 'poly-slugs.json');
const BROWSER_SLUGS_FILE = path.join(CACHE_DIR, 'browser-slugs.json');

/**
 * 从标题生成 Predict slug
 */
export function generatePredictSlug(title: string): string {
    return title
        .toLowerCase()
        .replace(/@/g, 'at')
        .replace(/[^a-z0-9 -]/g, '')
        .replace(/ +/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * 验证 Predict slug 是否有效
 * @returns true 如果 slug 对应的页面存在
 */
export async function verifyPredictSlug(slug: string): Promise<boolean> {
    try {
        const url = `https://predict.fun/market/${slug}`;
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',  // 不自动跟随重定向
        });
        // 200 = 页面存在, 3xx = 重定向到其他页面
        return res.status === 200;
    } catch {
        return false;
    }
}

/**
 * 尝试多种 slug 变体，找到有效的 slug
 */
export async function discoverPredictSlug(title: string, marketId: number): Promise<string | null> {
    // 生成可能的 slug 变体
    const baseSlug = generatePredictSlug(title);
    const variants = [
        baseSlug,
        // 带 ID 后缀
        `${baseSlug}-${marketId}`,
        // 去掉常见词
        baseSlug.replace(/-the-/g, '-').replace(/^the-/, ''),
        // 缩写月份
        baseSlug
            .replace(/january/g, 'jan')
            .replace(/february/g, 'feb')
            .replace(/march/g, 'mar')
            .replace(/april/g, 'apr')
            .replace(/june/g, 'jun')
            .replace(/july/g, 'jul')
            .replace(/august/g, 'aug')
            .replace(/september/g, 'sep')
            .replace(/october/g, 'oct')
            .replace(/november/g, 'nov')
            .replace(/december/g, 'dec'),
    ];

    // 去重
    const uniqueVariants = [...new Set(variants)];

    // 依次测试
    for (const slug of uniqueVariants) {
        const valid = await verifyPredictSlug(slug);
        if (valid) {
            return slug;
        }
        // 避免请求过快
        await new Promise(r => setTimeout(r, 100));
    }

    return null;
}

/**
 * 获取 Predict 市场的 URL
 */
export function getPredictUrl(marketId: number, title: string): string {
    const cached = predictSlugCache.get(marketId);
    if (cached?.verified && cached.slug) {
        return `https://predict.fun/market/${cached.slug}`;
    }

    // 未验证，使用生成的 slug
    const slug = generatePredictSlug(title);
    return `https://predict.fun/market/${slug}`;
}

/**
 * 获取已验证的 Predict slug
 */
export function getVerifiedPredictSlug(marketId: number): string | null {
    const cached = predictSlugCache.get(marketId);
    return cached?.verified ? cached.slug : null;
}

/**
 * 设置 Predict slug 缓存
 */
export function setPredictSlug(marketId: number, slug: string, verified: boolean): void {
    predictSlugCache.set(marketId, { slug, verified });
}

/**
 * 获取 Polymarket 市场的 URL
 * 格式: https://polymarket.com/event/{event_slug}/{market_slug}
 *
 * 注意：同一个 event 下可能有多个 market（例如不同日期/不同选项），
 * 只用 eventSlug 会落到事件页或错误的默认市场。
 */
export function getPolymarketUrl(conditionId: string, title: string): string {
    const cached = polySlugCache.get(conditionId);
    if (cached?.eventSlug && cached.marketSlug) {
        return `https://polymarket.com/event/${cached.eventSlug}/${cached.marketSlug}`;
    }
    if (cached?.eventSlug) {
        return `https://polymarket.com/event/${cached.eventSlug}`;
    }
    // Fallback: 使用搜索
    return `https://polymarket.com/markets?_q=${encodeURIComponent(title.substring(0, 50))}`;
}

/**
 * 获取 Polymarket 完整 slug 路径 (用于 URL 导航)
 * 返回格式: eventSlug/marketSlug 或仅 eventSlug
 * 前端拼接: https://polymarket.com/event/${slug}
 */
export function getPolymarketSlug(conditionId: string): string | undefined {
    const cached = polySlugCache.get(conditionId);
    if (!cached?.eventSlug) return undefined;
    // 返回完整路径: eventSlug/marketSlug (如果 marketSlug 存在且与 eventSlug 不同)
    if (cached.marketSlug && cached.marketSlug !== cached.eventSlug) {
        return `${cached.eventSlug}/${cached.marketSlug}`;
    }
    return cached.eventSlug;
}

/**
 * 获取 Polymarket event slug（需要拼接 event/market URL 时使用）
 */
export function getPolymarketEventSlug(conditionId: string): string | undefined {
    return polySlugCache.get(conditionId)?.eventSlug;
}

/**
 * 从 Polymarket Gamma API 获取并缓存 slug 映射
 */
export async function fetchPolymarketSlugs(): Promise<number> {
    try {
        const res = await fetch('https://gamma-api.polymarket.com/events?closed=false&limit=500');
        if (!res.ok) {
            console.error(`[UrlMapper] Polymarket fetch failed: ${res.status}`);
            return 0;
        }

        const events = await res.json() as Array<{ slug: string; markets?: Array<{ conditionId: string; slug?: string; groupItemTitle?: string }> }>;
        let count = 0;

        for (const event of events) {
            const eventSlug = event.slug;
            for (const market of (event.markets || [])) {
                if (market.conditionId && eventSlug) {
                    polySlugCache.set(market.conditionId, {
                        eventSlug,
                        marketSlug: market.slug || '',
                        groupItemTitle: market.groupItemTitle || undefined,
                    });
                    count++;
                }
            }
        }

        console.log(`[UrlMapper] Loaded ${count} Polymarket slugs`);
        return count;
    } catch (error) {
        console.error('[UrlMapper] Polymarket fetch error:', error);
        return 0;
    }
}

/**
 * 加载持久化的缓存
 */
export function loadCache(): void {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }

        // 加载 Predict 缓存
        if (fs.existsSync(PREDICT_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PREDICT_CACHE_FILE, 'utf-8'));
            for (const [id, entry] of Object.entries(data)) {
                const e = entry as { slug: string; verified: boolean };
                predictSlugCache.set(parseInt(id), e);
            }
            console.log(`[UrlMapper] Loaded ${predictSlugCache.size} Predict slugs from cache`);
        }

        // 加载 Polymarket 缓存
        if (fs.existsSync(POLY_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(POLY_CACHE_FILE, 'utf-8'));
            for (const [id, entry] of Object.entries(data)) {
                const e = entry as { eventSlug: string; marketSlug: string; groupItemTitle?: string };
                polySlugCache.set(id, e);
            }
            console.log(`[UrlMapper] Loaded ${polySlugCache.size} Polymarket slugs from cache`);
        }

        // 加载浏览器抓取的标题->slug 映射
        if (fs.existsSync(BROWSER_SLUGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(BROWSER_SLUGS_FILE, 'utf-8')) as Array<{ title: string; slug: string }>;
            for (const entry of data) {
                if (entry.title && entry.slug) {
                    // 原始标题 (精确匹配)
                    predictTitleSlugCache.set(entry.title, entry.slug);

                    // 规范化标题 (模糊匹配)
                    const normalized = normalizeTitle(entry.title);
                    if (normalized.length > 10) {  // 避免过短的规范化标题导致误匹配
                        predictNormalizedTitleCache.set(normalized, entry.slug);
                    }

                    // 生成变体: "LoL: A vs B (BO3)" -> "A @ B"
                    const vsMatch = entry.title.match(/^(?:LoL:\s*)?(.+?)\s+vs\s+(.+?)(?:\s+\(BO\d\))?$/i);
                    if (vsMatch) {
                        const variant = `${vsMatch[1].trim()} @ ${vsMatch[2].trim()}`;
                        predictTitleSlugCache.set(variant, entry.slug);
                    }
                }
            }
            console.log(`[UrlMapper] Loaded ${predictTitleSlugCache.size} exact + ${predictNormalizedTitleCache.size} normalized title->slug mappings`);
        }
    } catch (error) {
        console.error('[UrlMapper] Load cache error:', error);
    }
}

/**
 * 保存缓存到文件
 */
export function saveCache(): void {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }

        // 保存 Predict 缓存
        const predictData: Record<string, { slug: string; verified: boolean }> = {};
        for (const [id, entry] of predictSlugCache) {
            predictData[id.toString()] = entry;
        }
        fs.writeFileSync(PREDICT_CACHE_FILE, JSON.stringify(predictData, null, 2));

        // 保存 Polymarket 缓存
        const polyData: Record<string, { eventSlug: string; marketSlug: string; groupItemTitle?: string }> = {};
        for (const [id, entry] of polySlugCache) {
            polyData[id] = entry;
        }
        fs.writeFileSync(POLY_CACHE_FILE, JSON.stringify(polyData, null, 2));

        console.log(`[UrlMapper] Saved cache: ${predictSlugCache.size} Predict, ${polySlugCache.size} Polymarket`);
    } catch (error) {
        console.error('[UrlMapper] Save cache error:', error);
    }
}

/**
 * 初始化 URL 映射器
 */
export async function initUrlMapper(): Promise<void> {
    console.log('[UrlMapper] Initializing...');

    // 加载本地缓存
    loadCache();

    // 获取 Polymarket 最新 slug
    await fetchPolymarketSlugs();

    // 保存缓存
    saveCache();

    console.log('[UrlMapper] Initialized');
}

/**
 * 批量验证 Predict slugs
 * @param markets 市场列表 [{id, title}]
 * @param maxConcurrent 最大并发数
 */
export async function batchVerifyPredictSlugs(
    markets: { id: number; title: string }[],
    maxConcurrent: number = 5
): Promise<number> {
    let verified = 0;
    const queue = [...markets];

    const worker = async () => {
        while (queue.length > 0) {
            const market = queue.shift();
            if (!market) break;

            // 跳过已验证的
            const cached = predictSlugCache.get(market.id);
            if (cached?.verified) continue;

            // 尝试发现有效 slug
            const slug = await discoverPredictSlug(market.title, market.id);
            if (slug) {
                predictSlugCache.set(market.id, { slug, verified: true });
                verified++;
                console.log(`[UrlMapper] Verified: ${market.id} -> ${slug}`);
            } else {
                // 使用生成的 slug (未验证)
                const generated = generatePredictSlug(market.title);
                predictSlugCache.set(market.id, { slug: generated, verified: false });
            }
        }
    };

    // 启动并发 workers
    const workers = Array(maxConcurrent).fill(null).map(() => worker());
    await Promise.all(workers);

    // 保存缓存
    saveCache();

    return verified;
}

/**
 * 批量缓存 Predict slugs (自动生成，不验证)
 * 在市场数据加载时调用，确保所有市场都有 slug
 */
export function cachePredictSlugs(markets: { id: number; title: string }[]): number {
    let newCount = 0;
    let exactMatch = 0;
    let normalizedMatch = 0;
    let generated = 0;

    for (const market of markets) {
        // 跳过已缓存的
        if (predictSlugCache.has(market.id)) continue;

        // 1. 优先精确匹配浏览器抓取的 slug
        const exactSlug = predictTitleSlugCache.get(market.title);
        if (exactSlug) {
            predictSlugCache.set(market.id, { slug: exactSlug, verified: true });
            newCount++;
            exactMatch++;
            continue;
        }

        // 2. 尝试规范化标题匹配 (模糊匹配)
        const normalized = normalizeTitle(market.title);
        const normalizedSlug = predictNormalizedTitleCache.get(normalized);
        if (normalizedSlug) {
            predictSlugCache.set(market.id, { slug: normalizedSlug, verified: true });
            newCount++;
            normalizedMatch++;
            continue;
        }

        // 3. 生成 slug (未验证)
        const slug = generatePredictSlug(market.title);
        predictSlugCache.set(market.id, { slug, verified: false });
        newCount++;
        generated++;
    }

    if (newCount > 0) {
        saveCache();
        console.log(`[UrlMapper] Auto-cached ${newCount} Predict slugs (exact: ${exactMatch}, normalized: ${normalizedMatch}, generated: ${generated})`);
    }

    return newCount;
}

// 导出缓存访问方法 (兼容旧代码)
export function getPredictSlug(marketId: number): string | undefined {
    return predictSlugCache.get(marketId)?.slug;
}

export function getPolymarketSlugs(conditionId: string): { eventSlug: string; marketSlug: string; groupItemTitle?: string } | undefined {
    return polySlugCache.get(conditionId);
}

/**
 * 获取 Polymarket negRisk 子市场的 outcome 名称 (来自 Gamma API groupItemTitle)
 */
export function getPolymarketOutcome(conditionId: string): string | undefined {
    return polySlugCache.get(conditionId)?.groupItemTitle || undefined;
}

/**
 * 按标题查找 Predict slug (用于体育市场等无法通过 ID 匹配的场景)
 */
export function getPredictSlugByTitle(title: string): string | undefined {
    return predictTitleSlugCache.get(title);
}
