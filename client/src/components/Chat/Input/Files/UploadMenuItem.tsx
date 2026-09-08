import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';

/** Preserve Ariakit's menu semantics, events, focus handling, and existing label. */
const UploadMenuItem = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { description: string }
>(({ description, children, ...props }, ref) => (
  <div {...props} ref={ref}>
    <span className="flex min-w-0 flex-col gap-1 text-left">
      <span className="flex items-center gap-2">{children}</span>
      <span className="max-w-[16rem] whitespace-normal pl-6 text-xs font-normal leading-relaxed text-text-secondary">
        {description}
      </span>
    </span>
  </div>
));

UploadMenuItem.displayName = 'UploadMenuItem';

export default UploadMenuItem;
