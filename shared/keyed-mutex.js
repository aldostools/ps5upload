'use strict';

function createKeyedMutex() {
  const state = new Map(); // key -> { locked: boolean, waiters: Array<() => void> }

  const acquire = async (key) => {
    const k = String(key || '');
    if (!k) return () => {};
    let slot = state.get(k);
    if (!slot) {
      slot = { locked: false, waiters: [] };
      state.set(k, slot);
    }
    while (slot.locked) {
      await new Promise((resolve) => slot.waiters.push(resolve));
    }
    slot.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot.locked = false;
      const next = slot.waiters.shift();
      if (next) next();
      else state.delete(k);
    };
  };

  return { acquire };
}

module.exports = {
  createKeyedMutex,
};
