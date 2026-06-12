var Preview = window.Preview || (window.Preview = {});
const { useRef, useEffect } = Preview.ReactHooks;

// --- Lucide Icons ---
// lucide UMD 的 icons 对象 key 是 PascalCase；本项目调用习惯用 kebab-case，做一次本地映射
// 注意：lucide 把数字直接拼接（如 "gamepad-2" → "Gamepad2"），所以连字符后是字母或数字都要去掉连字符并大写紧随其后的字母
const toPascal = (n) => n
    .replace(/(^|-)([a-z0-9])/g, (_, _s, c) => c.toUpperCase())
    .replace(/-/g, '');
const Icon = ({ name, size = 18, className = "", strokeWidth = 1.5 }) => {
    const ref = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        const def = lucide.icons[name] || lucide.icons[toPascal(name)];
        if (!def) return;
        ref.current.innerHTML = '';
        const svg = lucide.createElement(def);
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setAttribute('stroke-width', strokeWidth);
        if (className) svg.setAttribute('class', className);
        ref.current.appendChild(svg);
    }, [name, size, className, strokeWidth]);
    return <span ref={ref} className={`inline-flex items-center justify-center ${className}`}></span>;
};

Preview.Icon = Icon;
