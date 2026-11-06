/** The parts of DSH's own client components used here. The module is provided by the web shell, not bundled. */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { FC, ReactNode } from 'react';

  export const DisclosureRow: FC<{
    icon: ReactNode; title: string; open: boolean; expandable: boolean; onToggle(): void;
    running?: boolean; expandOnRowClick?: boolean; keepContentWhenOpen?: boolean;
    collapsedContent?: ReactNode; headerAccessory?: ReactNode; children?: ReactNode;
    leadingClassName?: string; titleClassName?: string;
  }>;
  export const IconApiOutlineRegular: FC<{ size?: number }>;
  export const TextShimmer: FC<{ children?: ReactNode }>;
  export const MarkdownText: FC<{ text: string; labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string }; variant?: string }>;
}
