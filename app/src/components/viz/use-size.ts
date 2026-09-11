import { type RefObject, useLayoutEffect, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * The rendered size of an element, kept current through a ResizeObserver.
 * Charts draw into whatever box the layout gives them; nothing here has a
 * fixed pixel width. jsdom reports 0×0, so `fallback` is what tests see.
 *
 * The drawn element must sit `absolute inset-0` inside the measured wrapper.
 * A canvas or svg in normal flow with an explicit pixel width becomes the
 * wrapper's minimum content width, so the wrapper can grow with the window
 * but never shrink back, and the page ratchets off screen when it narrows.
 */
export function useSize(ref: RefObject<HTMLElement | null>, fallback: Size = { width: 640, height: 240 }): Size {
  const [size, setSize] = useState<Size>(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
