// Is the Brev operator reachable right now? Break it live only shows when it is, so a box
// that drops mid-demo simply takes the button away and the recorded runs carry on.
// ?live=0 hides it by hand.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const OFF = new URLSearchParams(location.search).get('live') === '0';

export function useLiveStatus(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (OFF) return;
    let alive = true;
    const check = () => api.liveStatus().then((s) => alive && setOn(s.operator)).catch(() => alive && setOn(false));
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return on;
}
