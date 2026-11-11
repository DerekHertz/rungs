/** Where a tooltip of `size` goes for a pointer at `at` in a window of `view`: below and right of the pointer, kept inside the window. */
export function tooltipPosition(
  at: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): { left: number; top: number } {
  return { left: Math.min(at.x + 16, view.width - size.width - 4), top: Math.min(at.y + 16, view.height - size.height - 4) };
}
