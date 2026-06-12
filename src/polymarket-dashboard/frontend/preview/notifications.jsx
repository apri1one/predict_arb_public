var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback } = Preview.ReactHooks;

// --- Toast Notification System ---
const TOAST_TTL_MS = 4000;

const useToasts = () => {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((type, message) => {
        const id = Date.now() + Math.random();
        const toast = { id, type, message, timestamp: Date.now() };
        setToasts(prev => [toast, ...prev.slice(0, 9)]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, TOAST_TTL_MS);
    }, []);

    const dismissToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    return { toasts, addToast, dismissToast };
};

const ToastContainer = ({ toasts, onDismiss }) => {
    if (toasts.length === 0) return null;

    const typeStyles = {
        success: 'border-green-500/30 bg-green-500/10 text-green-400',
        error: 'border-red-500/30 bg-red-500/10 text-red-400',
        info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    };

    return (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`px-4 py-3 rounded-lg border backdrop-blur-sm cursor-pointer transition-all duration-300 animate-slide-in ${typeStyles[toast.type] || typeStyles.info}`}
                    onClick={() => onDismiss(toast.id)}
                >
                    <p className="text-sm font-medium">{toast.message}</p>
                </div>
            ))}
        </div>
    );
};

Preview.useToasts = useToasts;
Preview.ToastContainer = ToastContainer;
