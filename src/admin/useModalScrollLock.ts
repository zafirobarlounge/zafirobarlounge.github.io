import { useLayoutEffect } from 'react';

let lockCount = 0;
let releasePageScroll: (() => void) | null = null;

/** Keeps the page still and fits overlays to the visible viewport, including when the keyboard opens. */
export function useModalScrollLock(isOpen: boolean) {
  useLayoutEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;

    if (lockCount === 0) {
      const { scrollX, scrollY, visualViewport } = window;
      const { body, documentElement } = document;
      const viewportHeightProperty = '--zafiro-modal-viewport-height';
      const viewportOffsetProperty = '--zafiro-modal-viewport-offset';
      const bodyStyle = {
        overflow: body.style.overflow,
        paddingRight: body.style.paddingRight,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
      };
      const documentStyle = {
        overflow: documentElement.style.overflow,
        overscrollBehavior: documentElement.style.overscrollBehavior,
      };
      const syncViewport = () => {
        documentElement.style.setProperty(viewportHeightProperty, `${visualViewport?.height || window.innerHeight}px`);
        documentElement.style.setProperty(viewportOffsetProperty, `${Math.max(0, visualViewport?.offsetTop ?? 0)}px`);
      };

      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      documentElement.style.overflow = 'hidden';
      documentElement.style.overscrollBehavior = 'none';
      body.style.overflow = 'hidden';
      body.style.position = 'fixed';
      body.style.top = `-${scrollY}px`;
      body.style.width = '100%';
      if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

      syncViewport();
      window.addEventListener('resize', syncViewport);
      visualViewport?.addEventListener('resize', syncViewport);
      visualViewport?.addEventListener('scroll', syncViewport);

      releasePageScroll = () => {
        window.removeEventListener('resize', syncViewport);
        visualViewport?.removeEventListener('resize', syncViewport);
        visualViewport?.removeEventListener('scroll', syncViewport);
        documentElement.style.removeProperty(viewportHeightProperty);
        documentElement.style.removeProperty(viewportOffsetProperty);
        documentElement.style.overflow = documentStyle.overflow;
        documentElement.style.overscrollBehavior = documentStyle.overscrollBehavior;
        body.style.overflow = bodyStyle.overflow;
        body.style.paddingRight = bodyStyle.paddingRight;
        body.style.position = bodyStyle.position;
        body.style.top = bodyStyle.top;
        body.style.width = bodyStyle.width;
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      };
    }
    lockCount += 1;
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) {
        releasePageScroll?.();
        releasePageScroll = null;
      }
    };
  }, [isOpen]);
}
