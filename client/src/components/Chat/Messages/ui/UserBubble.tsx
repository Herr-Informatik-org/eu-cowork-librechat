import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLocalize } from '~/hooks';
import './user-bubble.css';

export default function UserBubble({ active, children }: { active: boolean; children: ReactNode }) {
  const localize = useLocalize();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    const measure = () => setLong(node.scrollHeight > 330);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [active, children]);
  if (!active) return <>{children}</>;
  return (
    <div className="user-message-bubble" data-expanded={expanded}>
      <div
        ref={ref}
        className="user-message-body"
        data-collapsed={long && !expanded}
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          className="user-message-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {localize(expanded ? 'com_ui_show_less' : 'com_ui_show_more')}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
    </div>
  );
}
