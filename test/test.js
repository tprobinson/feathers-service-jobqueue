/* global describe:false it:false */
const assert = require('chai').assert;
const JobQueueService = require('../lib/index.js');
const path = require('path');

const feathers = require('feathers');

/* eslint-disable max-nested-callbacks */

let app;
let service;
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
  it('can create a job', function () {

  });
});
