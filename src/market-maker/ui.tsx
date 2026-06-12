import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, Newline, Spacer, useApp, useInput } from 'ink';
import type { MarketState, Fill } from './types.js';

export interface UIErrorEntry {
    time: Date;
    marketId: number | null;
    message: string;
}

export interface UIGlobalStats {
    totalMarkets: number;
    runningMarkets: number;
    totalFills: number;
    totalVolume: number;
    totalRealizedPnL: number;
    startTime: Date | null;
}

export interface UISnapshot {
    timestamp: number;
    globalStats: UIGlobalStats;
    markets: MarketState[];
    fills: Fill[];
    errors: UIErrorEntry[];
    logFile: string;
}

interface Props {
    emitter: NodeJS.EventEmitter;
    initialSnapshot: UISnapshot;
}

function formatPnL(pnl: number): string {
    const value = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const color = pnl >= 0 ? 'green' : 'red';
    return `{${color}}${value}{/${color}}`;
}

function formatTime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);
    if (hrs > 0) return `${hrs}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}

function statusColor(status: MarketState['status']): string {
    switch (status) {
        case 'running': return 'green';
        case 'range_paused':
        case 'paused': return 'yellow';
        case 'error': return 'red';
        case 'initializing': return 'cyan';
        default: return 'gray';
    }
}

interface UIMarket extends MarketState {
    outcome: 'YES' | 'NO';
    maxShares: number;
}

function formatOrder(order: MarketState['activeBuyOrder'] | MarketState['activeSellOrder'], outcome: UIMarket['outcome']): string {
    if (!order) return '-';
    const remaining = order.quantity - order.filledQuantity;
    const price = `${(order.price * 100).toFixed(1)}¢`;
    const label = (outcome || 'YES').toLowerCase();
    return `${label} ${remaining}@${price}`;
}

function MarketRow({ market, index }: { market: UIMarket; index: number }): JSX.Element {
    const buyRemain = market.activeBuyOrder ? market.activeBuyOrder.quantity - market.activeBuyOrder.filledQuantity : null;
    const sellRemain = market.activeSellOrder ? market.activeSellOrder.quantity - market.activeSellOrder.filledQuantity : null;

    return (
        <Box flexDirection="row" gap={1}>
            <Text color="cyan">{String(index).padStart(2, ' ')}</Text>
            <Text> </Text>
            <Box width={70}>
                <Text>{market.title}</Text>
            </Box>
            <Box width={8}>
                <Text color={statusColor(market.status)}>{market.status}</Text>
            </Box>
            <Box width={6}><Text>{market.outcome}</Text></Box>
            <Box width={8}><Text>{market.maxShares}</Text></Box>
            <Box width={12}><Text>{buyRemain === null ? '-' : formatOrder(market.activeBuyOrder, market.outcome)}</Text></Box>
            <Box width={12}><Text>{sellRemain === null ? '-' : formatOrder(market.activeSellOrder, market.outcome)}</Text></Box>
            <Box width={8}><Text>{market.lastBestBid > 0 ? `${(market.lastBestBid * 100).toFixed(1)}¢` : '-'}</Text></Box>
            <Box width={8}><Text>{market.lastBestAsk > 0 ? `${(market.lastBestAsk * 100).toFixed(1)}¢` : '-'}</Text></Box>
        </Box>
    );
}

function Header({ snapshot }: { snapshot: UISnapshot & { markets: UIMarket[] } }): JSX.Element {
    const now = new Date(snapshot.timestamp);
    const runtime = snapshot.globalStats.startTime
        ? formatTime(now.getTime() - snapshot.globalStats.startTime.getTime())
        : '--';

    return (
        <Box flexDirection="column">
            <Box>
                <Text color="blue">●</Text><Text> </Text><Text color="cyan" bold>Predict 做市监控</Text>
                <Spacer />
                <Text>
                    {now.toLocaleTimeString()} | 运行: {runtime}
                </Text>
            </Box>
            <Box>
                <Text>
                    市场: {snapshot.globalStats.runningMarkets}/{snapshot.globalStats.totalMarkets}
                    {'  '}成交: {snapshot.globalStats.totalFills}
                    {'  '}Vol: ${snapshot.globalStats.totalVolume.toFixed(2)}
                </Text>
                <Spacer />
                <Text>
                    利润: <Text color={snapshot.globalStats.totalRealizedPnL >= 0 ? 'green' : 'red'}>
                        {snapshot.globalStats.totalRealizedPnL >= 0 ? '+' : '-'}
                        ${Math.abs(snapshot.globalStats.totalRealizedPnL).toFixed(2)}
                    </Text>
                </Text>
            </Box>
        </Box>
    );
}

function SectionTitle({ title }: { title: string }): JSX.Element {
    return (
        <Box marginTop={1} marginBottom={0}>
            <Text color="blue" bold>{title}</Text>
        </Box>
    );
}

function PausedList({ markets }: { markets: MarketState[] }): JSX.Element {
    const paused = markets.filter(m =>
        (m.status === 'paused' || m.status === 'range_paused' || m.status === 'error') &&
        m.errorMessage
    );
    if (paused.length === 0) {
        return <Text>无</Text>;
    }
    return (
        <Box flexDirection="column" gap={0}>
            {paused.map(m => (
                <Text key={m.marketId}>
                    #{m.marketId} {m.title} - <Text color="yellow">{m.errorMessage}</Text>
                </Text>
            ))}
        </Box>
    );
}

function Trades({ fills, markets }: { fills: Fill[]; markets: UIMarket[] }): JSX.Element {
    if (fills.length === 0) return <Text>暂无成交</Text>;
    const titleMap = new Map(markets.map(m => [m.marketId, m.title]));
    const latest = fills.slice(-8).reverse();
    return (
        <Box flexDirection="column" gap={0}>
            {latest.map((f, idx) => (
                <Text key={idx}>
                    {f.filledAt.toLocaleTimeString()} #{f.marketId} {titleMap.get(f.marketId) ?? ''}
                    {' '}{f.side} {f.quantity} @ {(f.price * 100).toFixed(1)}¢ ${(f.price * f.quantity).toFixed(2)}
                </Text>
            ))}
        </Box>
    );
}

function Errors({ errors }: { errors: UIErrorEntry[] }): JSX.Element {
    if (errors.length === 0) return <Text>暂无错误</Text>;
    const latest = errors.slice(-8).reverse();
    return (
        <Box flexDirection="column" gap={0}>
            {latest.map((e, idx) => (
                <Text key={idx} color="red">
                    {e.time.toLocaleTimeString()} {e.marketId ? `[${e.marketId}] ` : ''}{e.message}
                </Text>
            ))}
        </Box>
    );
}

function MarketsTable({ markets }: { markets: UIMarket[] }): JSX.Element {
    return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
            <Box flexDirection="row" gap={1}>
                <Box width={3}><Text color="cyan" bold>#</Text></Box>
                <Box width={70}><Text color="cyan" bold>市场</Text></Box>
                <Box width={8}><Text color="cyan" bold>状态</Text></Box>
                <Box width={6}><Text color="cyan" bold>方向</Text></Box>
                <Box width={8}><Text color="cyan" bold>MaxPos</Text></Box>
                <Box width={12}><Text color="cyan" bold>买单</Text></Box>
                <Box width={12}><Text color="cyan" bold>卖单</Text></Box>
                <Box width={8}><Text color="cyan" bold>买一</Text></Box>
                <Box width={8}><Text color="cyan" bold>卖一</Text></Box>
            </Box>
            {markets.length === 0
                ? <Text color="gray">暂无活跃市场</Text>
                : markets.map((m, i) => (
                    <MarketRow key={m.marketId} market={m} index={i + 1} />
                ))
            }
        </Box>
    );
}

export function MarketMakerUI({ emitter, initialSnapshot }: Props): JSX.Element {
    const { exit } = useApp();
    const [snapshot, setSnapshot] = useState<UISnapshot & { markets: UIMarket[] }>(initialSnapshot as UISnapshot & { markets: UIMarket[] });

    useEffect(() => {
        const handler = (next: UISnapshot) => setSnapshot(next as UISnapshot & { markets: UIMarket[] });
        emitter.on('update', handler);
        return () => {
            emitter.off('update', handler);
        };
    }, [emitter]);

    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            exit();
        }
    });

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header snapshot={snapshot} />
            <Newline />
            <MarketsTable markets={snapshot.markets} />

            <SectionTitle title="暂停原因" />
            <PausedList markets={snapshot.markets} />

            <SectionTitle title="最近成交" />
            <Trades fills={snapshot.fills} markets={snapshot.markets} />

            <SectionTitle title="最近错误" />
            <Errors errors={snapshot.errors} />

            <Box marginTop={1}>
                <Text dimColor>日志: {snapshot.logFile} | Ctrl+C 退出</Text>
            </Box>
        </Box>
    );
}
