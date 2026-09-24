import { useEffect } from 'react';

export function useScrollReveal() {
  useEffect(() => {
    const observerCallback: IntersectionObserverCallback = (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const element = entry.target as HTMLElement;
          // Apply staggered delay if provided via data-delay attribute
          const delay = element.getAttribute('data-delay');
          if (delay) {
            element.style.transitionDelay = `${delay}s`;
          }
          element.classList.add('is-visible');
          // Optional: Stop observing once revealed
          // observer.unobserve(element);
        }
      });
    };

    const observerOptions = {
      root: null,
      rootMargin: '0px',
      threshold: 0.15,
    };

    const observer = new IntersectionObserver(observerCallback, observerOptions);
    const revealElements = document.querySelectorAll('.reveal');
    
    revealElements.forEach((el) => observer.observe(el));

    return () => {
      revealElements.forEach((el) => observer.unobserve(el));
      observer.disconnect();
    };
  }, []);
}
