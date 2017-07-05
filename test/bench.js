const JobQueueService = require('../lib/index.js');
const Promise = require('bluebird');
const path = require('path');

const feathers = require('feathers');
import BenchmarkRunner from 'simple-benchmarkjs-runner';

let app;

// Create a job, then wait for it to be done.
const runJob = (service, config) => {
  if( !service ) { return Promise.reject('Service not ready'); }
  return service.create(config)
    .then(id => new Promise((resolve, reject) => {
      service.on('failed', job => { if( id === job.id ) {
        service.get(id).then(stuff => reject(stuff));
      }});

      service.on('complete', job => { if( id === job.id ) {
        resolve(job);
      }});
    }));
};

const zonesEndpoint = 'zones';
const plainEndpoint = 'jobs';

app = feathers();

const zonesSvc = new JobQueueService({jobDefinitionPath: path.join(__dirname, 'definitions'), zone: true});
const plainSvc = new JobQueueService({jobDefinitionPath: path.join(__dirname, 'definitions'), zone: false});

app.use('/' + zonesEndpoint, zonesSvc);
app.use('/' + plainEndpoint, plainSvc);

const testRun = service => deferred => {
  runJob(service, {type: 'test.basic'}).then(() => deferred.resolve()).catch(() => deferred.reject());
};

app.listen(9001).on('listening', () => {
  new BenchmarkRunner({ // eslint-disable-line no-new
    title: 'zone vs alone',
    tests: [{
      title: 'Using Zone.js',
      fn: () => testRun(zonesSvc)
    }, {
      title: 'Without Zone protection',
      fn: () => testRun(plainSvc)
    }]
  });
  process.exit();
});
