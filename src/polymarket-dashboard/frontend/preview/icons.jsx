var Preview = window.Preview || (window.Preview = {});
const { useRef, useEffect } = Preview.ReactHooks;

// --- Lucide Icons ---
const Icon = ({ name, size = 18, className = "", strokeWidth = 1.5 }) => {
    const ref = useRef(null);
    useEffect(() => {
        if (ref.current && lucide.icons[name]) {
            ref.current.innerHTML = '';
            const svg = lucide.createElement(lucide.icons[name]);
            svg.setAttribute('width', size);
            svg.setAttribute('height', size);
            svg.setAttribute('stroke-width', strokeWidth);
            if (className) svg.setAttribute('class', className);
            ref.current.appendChild(svg);
        }
    }, [name, size, className, strokeWidth]);
    return <span ref={ref} className={`inline-flex items-center justify-center ${className}`}></span>;
};

Preview.Icon = Icon;
