/* global describe:false it:false */
const JobQueueService = require('../lib/index.js');
const Promise = require('bluebird');
const path = require('path');
const debug = require('debug')('test');

const feathers = require('feathers');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const assert = chai.assert;

/* eslint-disable max-nested-callbacks */

let app;
let service;

const activeJobs = {};

// Create a job, then wait for it to be done.
const registerJob = (config, validator) => {
  if( !service ) { return Promise.reject('Service not ready'); }
  return service.create(config)
    .then(id => new Promise((resolve, reject) => {
      activeJobs[id] = config;
      service.on('failed', job => { if( id === job.id ) {
        delete activeJobs[id];
        service.get(id).then(stuff => reject(stuff));
      }});

      service.on('complete', job => { if( id === job.id ) {
        delete activeJobs[id];
        if( validator ) {
          const ret = validator(job);
          if( !ret ) {
            debug('Validator failed, returned:', ret, 'for job:', job);
            reject(ret);
            return;
          }
          resolve(ret);
          return;
        }
        resolve(job);
      }});
    }));
};

const endpoint = 'jobs';
describe('Service Initialization', function () {
  it('should not throw', function (done) {
    assert.doesNotThrow(function () {
      app = feathers();
      const svc = new JobQueueService({jobDefinitionPath: path.join(__dirname, 'definitions')});
      app.use('/' + endpoint, svc);
      app.listen(9001).on('listening', () => done());
    }, Error);
  });

  it('should produce a valid service', function () {
    service = app.service(endpoint);
    assert.isNotNull(service);
    assert.isDefined(service);
    assert.isObject(service);
    assert.property(service, 'find');
    assert.property(service, 'get');
    assert.property(service, 'create');
  });
});

describe('Job Creation', function () {
  let promise;
  it('can create a job', function () {
    promise = registerJob({type: 'test.basic'});
    assert.isNotNull(promise);
    assert.isDefined(promise);
  });

  it('can finish a test job', function () {
    return Promise.all([
      assert.isFulfilled(promise),
      assert.eventually.propertyVal(promise, 'results', true)
    ]);
  });
});

describe('Job Attributes', function () {
  describe('Concurrency', function () {
    it('can run concurrent jobs', function () {
      let promises = [];
      let num = 5;
      while( num ) {
        promises.push(registerJob({type: 'test.basic'}));
        num--;
      }

      return Promise.all(promises.map(x => Promise.all([
        assert.isFulfilled(x),
        assert.eventually.propertyVal(x, 'results', true)
      ])));
    });

    // will not run more than concurrency property allows at once

    // will run multiple jobs at once
    // -- here, subscribe to progress, and keep an integer of how many jobs have reported in before others have finished
  });

  // ttl

  // allowedCheck

  // runNow -- check for a job of a distinct type that has already finished.

  // schedule -- not sure how to test this...
});

// test ideas -- that jobs can trigger other jobs
// that failing jobs fail properly and can return an object
// that zones work, when they're implemented.
// that data of all types is passed in and out of a job.
// Needs some kind of throw... as a fail with a specific code and data type.
// test find and get

// TODO
// Make redis come up when Mocha does.
