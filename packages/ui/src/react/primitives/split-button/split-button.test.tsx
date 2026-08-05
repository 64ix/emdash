import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SplitButton, type SplitButtonOptionTone } from '.';

describe('SplitButton option tone', () => {
  it.each([
    ['neutral', 'circle'],
    ['accept', 'check'],
    ['reject', 'x'],
  ] as const)('renders the %s tone with its own non-colour shape', (tone, shape) => {
    const html = renderToStaticMarkup(
      <SplitButton
        options={[{ id: tone, label: tone, tone: tone satisfies SplitButtonOptionTone }]}
        selectedId={tone}
        onAction={vi.fn()}
      />
    );

    expect(html).toContain('data-slot="split-button-tone"');
    expect(html).toContain(`data-tone="${tone}"`);
    expect(html).toContain(`data-shape="${shape}"`);
  });
});
