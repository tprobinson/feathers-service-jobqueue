'use strict';
const debug = require('debug')('test-jobs');
module.exports = {
  concurrency: 5,
  ttl: 1 * 60 * 1000,
  jobFunction: function (job, ctx, done) {
    let myNum;
    if( 'timeout' in job.data && job.data.timeout ) {
      myNum = job.data.timeout;
    } else {
      myNum = Math.floor(Math.random() * 10) + 1;
    }

    const iterate = (num) => {
      if( num ) {
        debug(num + 's left!');
        setTimeout(() => iterate(num - 1), 1000);
      } else {
        done();
      }
    };

    iterate(myNum);
  }
};
