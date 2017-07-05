'use strict';
module.exports = {
  concurrency: 1,
  ttl: 1 * 60 * 1000,
  jobFunction: function (job, ctx, done) {
    done(null, true);
  }
};
