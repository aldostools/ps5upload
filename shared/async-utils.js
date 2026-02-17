'use strict';

async function mapWithConcurrency(items, limit, iterator) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  let active = 0;
  const concurrency = Math.max(1, Number(limit) || 1);

  return new Promise((resolve, reject) => {
    const launch = () => {
      if (nextIndex >= list.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && nextIndex < list.length) {
        const idx = nextIndex++;
        active += 1;
        Promise.resolve(iterator(list[idx], idx))
          .then((result) => {
            results[idx] = result;
            active -= 1;
            launch();
          })
          .catch(reject);
      }
    };
    launch();
  });
}

module.exports = {
  mapWithConcurrency,
};
