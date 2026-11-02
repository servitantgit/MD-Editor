// latest-only.js
// Lets only the newest of overlapping async calls win. loadTree() is called
// from many places (refresh, every save/move/delete/upload); without this an
// older, slower tree response landing after a newer one overwrote the tree and
// state.allFiles with stale data. Pure, unit-tested in test/latest-only.test.js.

/**
 * @returns {(fn: () => Promise<any>) => Promise<{stale: true} | {stale: false, value: any}>}
 *   Result of the newest call: { stale: false, value }. A call overtaken by a
 *   newer one resolves { stale: true }, also when it failed. An error of the
 *   newest call is thrown as usual.
 */
export function createLatestOnly() {
  let seq = 0;
  return async function run(fn) {
    const mine = ++seq;
    try {
      const value = await fn();
      return mine === seq ? { stale: false, value } : { stale: true };
    } catch (err) {
      if (mine !== seq) return { stale: true };
      throw err;
    }
  };
}
