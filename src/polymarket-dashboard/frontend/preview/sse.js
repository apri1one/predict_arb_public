var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback } = Preview.ReactHooks;

// --- SSE Configuration ---
const isFileOrigin = window.location.protocol === 'file:' || !window.location.hostname;
const API_BASE_URL = isFileOrigin ? 'http://localhost:4020' : '';

// --- Sports Data Hook ---
const useSportsStream = (addToast) => {
    const [markets, setMarkets] = useState([]);
    const [stats, setStats] = useState({ total: 0, bySport: {} });
    const [balance, setBalance] = useState(0);
    const [isConnected, setIsConnected] = useState(false);
    const [tradeEnabled, setTradeEnabled] = useState(false);
    const eventSourceRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const marketsRef = useRef(new Map()); // conditionId -> market

    const connectSSE = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }
        marketsRef.current.clear();

        const es = new EventSource(`${API_BASE_URL}/api/stream`);
        eventSourceRef.current = es;

        es.onopen = () => {
            setIsConnected(true);
        };

        es.onerror = () => {
            setIsConnected(false);
            es.close();
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = setTimeout(connectSSE, 3000);
        };

        es.addEventListener('sports', (e) => {
            try {
                const data = JSON.parse(e.data);
                const cache = marketsRef.current;

                if (data.snapshot) {
                    cache.clear();
                    for (const m of data.updated) {
                        cache.set(m.conditionId, m);
                    }
                } else {
                    for (const m of (data.updated || [])) {
                        cache.set(m.conditionId, m);
                    }
                    for (const id of (data.removed || [])) {
                        cache.delete(id);
                    }
                }

                setMarkets(Array.from(cache.values()));
                if (data.stats) setStats(data.stats);
                if (data.balance !== undefined) setBalance(data.balance);
            } catch (err) {
                console.error('SSE sports parse error:', err);
            }
        });

        es.addEventListener('balance', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.balance !== undefined) setBalance(data.balance);
            } catch {}
        });
    }, []);

    // 获取账户信息
    useEffect(() => {
        fetch(`${API_BASE_URL}/api/account`)
            .then(r => r.json())
            .then(d => {
                setBalance(d.balance || 0);
                setTradeEnabled(d.tradeEnabled || false);
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        connectSSE();
        return () => {
            if (eventSourceRef.current) eventSourceRef.current.close();
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        };
    }, [connectSSE]);

    // 下单函数
    const placeOrder = useCallback(async (orderParams) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderParams),
            });
            const data = await res.json();
            if (data.success) {
                addToast('success', `下单成功: ${data.orderId?.slice(0, 8)}...`);
            } else {
                addToast('error', `下单失败: ${data.error}`);
            }
            return data;
        } catch (err) {
            addToast('error', `下单异常: ${err.message}`);
            return { success: false, error: err.message };
        }
    }, [addToast]);

    const cancelOrder = useCallback(async (orderId) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/order/${orderId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                addToast('success', '撤单成功');
            } else {
                addToast('error', '撤单失败');
            }
            return data.success;
        } catch {
            addToast('error', '撤单异常');
            return false;
        }
    }, [addToast]);

    return { markets, stats, balance, isConnected, tradeEnabled, placeOrder, cancelOrder };
};

Preview.useSportsStream = useSportsStream;
Preview.API_BASE_URL = API_BASE_URL;
