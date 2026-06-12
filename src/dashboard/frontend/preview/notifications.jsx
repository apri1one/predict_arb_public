var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback } = Preview.ReactHooks;

// --- Notification System ---
const NOTIFICATION_TTL_MS = 5000;
const useNotifications = () => {
    const [notifications, setNotifications] = useState([]);
    const [settings, setSettings] = useState({
        enabled: true,
        sound: false,  // 声音功能已禁用
        desktop: false, // Default OFF - user must explicitly enable in Settings
        minProfit: 1.5,
        strategies: ['PREDICT_MAKER', 'TAKER']
    });

    // 声音功能已完全移除 - 不再创建 Audio 对象或播放声音
    const playSound = useCallback(() => {
        // 声音提醒已禁用，此函数为空实现
    }, []);

    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            setNotifications(prev => prev.filter(n => now - n.timestamp < NOTIFICATION_TTL_MS));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const showDesktopNotification = useCallback((title, body) => {
        // Only show notification if permission is already granted
        // Permission request is handled in Settings panel
        if (settings.desktop && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body, icon: '??' });
        }
    }, [settings.desktop]);

    const addNotification = useCallback((opp) => {
        if (!settings.enabled) return;
        if (opp.profitPercent < settings.minProfit) return;
        if (!settings.strategies.includes(opp.strategy)) return;

        const notification = {
            id: Date.now(),
            title: `${opp.profitPercent}% ${opp.strategy} Opportunity!`,
            message: opp.title,
            profit: opp.estimatedProfit,
            timestamp: Date.now()
        };

        setNotifications(prev => [notification, ...prev.slice(0, 9)]);
        playSound();
        showDesktopNotification(notification.title, notification.message);

        // Auto-dismiss after 5 seconds
        setTimeout(() => {
            setNotifications(prev => prev.filter(n => n.id !== notification.id));
        }, NOTIFICATION_TTL_MS);
    }, [settings, playSound, showDesktopNotification]);

    const dismissNotification = useCallback((id) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, []);

    return { notifications, settings, setSettings, addNotification, dismissNotification };
};

Preview.useNotifications = useNotifications;
