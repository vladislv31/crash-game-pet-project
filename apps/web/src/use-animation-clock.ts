import { useEffect, useState } from 'react';

/** Re-renders on every animation frame while `active`, returning the current local time. */
export function useAnimationClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    let frame = requestAnimationFrame(function update() {
      setNow(Date.now());
      frame = requestAnimationFrame(update);
    });

    return () => cancelAnimationFrame(frame);
  }, [active]);

  return now;
}
