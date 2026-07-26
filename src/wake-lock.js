export function createScreenWakeLock(onStatusChange = () => {}) {
  const supported = 'wakeLock' in navigator;
  let desired = false;
  let sentinel = null;
  let requestPromise = null;
  let disposed = false;

  function notify(status, error = null) {
    onStatusChange({ status, supported, desired, active: Boolean(sentinel), error });
  }

  async function request() {
    if (disposed || !desired) return false;
    if (!supported) {
      notify('unsupported');
      return false;
    }
    if (document.visibilityState !== 'visible') {
      notify('waiting');
      return false;
    }
    if (sentinel) return true;
    if (requestPromise) return requestPromise;

    requestPromise = (async () => {
      try {
        const newSentinel = await navigator.wakeLock.request('screen');
        if (disposed || !desired) {
          await newSentinel.release();
          return false;
        }

        sentinel = newSentinel;
        newSentinel.addEventListener('release', () => {
          if (sentinel === newSentinel) sentinel = null;
          if (!disposed) notify(desired ? 'released' : 'inactive');
        }, { once: true });
        notify('active');
        return true;
      } catch (error) {
        notify('blocked', error);
        return false;
      } finally {
        requestPromise = null;
      }
    })();

    return requestPromise;
  }

  async function setEnabled(enabled) {
    desired = enabled;
    if (!desired) {
      const currentSentinel = sentinel;
      sentinel = null;
      notify('inactive');
      if (currentSentinel) await currentSentinel.release().catch(() => {});
      return false;
    }
    return request();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && desired) request();
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    isActive: () => Boolean(sentinel),
    isDesired: () => desired,
    isSupported: () => supported,
    request,
    setEnabled,
    async dispose() {
      disposed = true;
      desired = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      const currentSentinel = sentinel;
      sentinel = null;
      if (currentSentinel) await currentSentinel.release().catch(() => {});
    }
  };
}
