import { useEffect } from 'react';

let lockCount = 0;
let releasePageScroll: (() => void) | null = null;

/** Keeps the document fixed while one or more dialogs are open. */
export function useModalScrollLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;

    if (lockCount === 0) {
      const scrollY = window.scrollY;
      const { body, documentElement } = document;
      const bodyStyle = {
        height: body.style.height, overflow: body.style.overflow, paddingRight: body.style.paddingRight,
        position: body.style.position, top: body.style.top, width: body.style.width,
      };
      const documentStyle = {
        height: documentElement.style.height, overflow: documentElement.style.overflow,
        overscrollBehavior: documentElement.style.overscrollBehavior,
      };
      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      documentElement.style.height = '100%';
      documentElement.style.overflow = 'hidden';
      documentElement.style.overscrollBehavior = 'none';
      body.style.height = '100%';
      body.style.overflow = 'hidden';
      body.style.position = 'fixed';
      body.style.top = `-${scrollY}px`;
      body.style.width = '100%';
      if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
      releasePageScroll = () => {
        documentElement.style.height = documentStyle.height;
        documentElement.style.overflow = documentStyle.overflow;
        documentElement.style.overscrollBehavior = documentStyle.overscrollBehavior;
        body.style.height = bodyStyle.height;
        body.style.overflow = bodyStyle.overflow;
        body.style.paddingRight = bodyStyle.paddingRight;
        body.style.position = bodyStyle.position;
        body.style.top = bodyStyle.top;
        body.style.width = bodyStyle.width;
        window.scrollTo(0, scrollY);
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
