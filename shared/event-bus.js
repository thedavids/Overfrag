export const EventBus = (() => {
  const events = {};

  function on(event, handler) {
    if (!events[event]) events[event] = [];
    events[event].push(handler);
  }

  function off(event, handler) {
    if (!events[event]) return;
    events[event] = events[event].filter(h => h !== handler);
  }

  function emit(event, data) {
    if (events[event]) {
      for (const handler of events[event]) {
        handler(data);
      }
    }
  }

  return { on, off, emit };
})();