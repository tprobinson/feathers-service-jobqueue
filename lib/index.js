'use strict';
const Promise = require('bluebird');
const debugGen = require('debug');
const errors = require('feathers-errors');
const kue = require('kue');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');

/**
 * Generic class to provide a deferred worker system by interfacing with Kue.
 * @see https://www.npmjs.com/package/kue
 */
class JobQueueService {
  /**
   * Sets all options and initializes some variables.
   * @constructor
   * @param {Object} [options={}] Turn on/off event emission, exception handling, or provide more context to jobs.
   * @param {boolean} [options.shutdownOnException=true] If true, when a job drops an exception, shutdown the whole app.
   * @param {boolean} [options.emitStart=true] If true, proxy Kue's start event.
   * @param {boolean} [options.emitProgress=true] If true, proxy Kue's progress event.
   * @param {boolean} [options.emitFailed=true] If true, proxy Kue's failed event.
   * @param {boolean} [options.emitFailedAttempt=true] If true, proxy Kue's failed attempt event.
   * @param {boolean} [options.emitComplete=true] If true, proxy Kue's complete event.
   * @param {Object} [options.jobContext=null] Additional context that can be provided for a job's this context.
   * @param {number} [options.watchStuckJobs=6000] If truthy, provided to Kue's watchStuckJobs.
   * @param {string} [options.jobDefinitionPath=./definitions] A path where definitions can be loaded from. By default, the same directory as the calling class.
   * @param {string} [options.debugName=jobs] A namespace for the debug module.
   * @param {string} [options.debugEventsName=jobEvents] A namespace for debugging job event emission.
   *
   * @listens jobs start
   * @listens jobs progress
   * @listens jobs failed attempt
   * @listens jobs failed
   * @listens jobs complete
   *
   * @emits start
   * @emits progress
   * @emits failed attempt
   * @emits failed
   * @emits complete
   */
  constructor(options) {
    /**
     * The result of applying user options over defaults.
     * @type {Object}
     */
    this.options = Object.assign({}, {
      jobDefinitionPath: path.join(__dirname, 'definitions'),
      shutdownOnException: true,
      emitStart: true,
      emitProgress: true,
      emitFailed: true,
      emitFailedAttempt: true,
      emitComplete: true,
      jobContext: null,
      watchStuckJobs: 6000,
      debugName: 'jobs',
      debugEventsName: 'jobEvents'
    }, options);

    /**
     * Used to associate metadata about jobs once they're loaded.
     * Jobs are loaded in {@link setup}
     * @type {Object}
     */
    this.jobDefs = {};

    /**
     * This tells Feathers what events can be sent.
     * @type {Array}
     */
    this.events = [];

    if( this.options.emitStart ) { this.events.push('start'); }
    if( this.options.emitProgress ) { this.events.push('progress'); }
    if( this.options.emitFailed ) { this.events.push('failed'); }
    if( this.options.emitFailedAttempt ) { this.events.push('failed attempt'); }
    if( this.options.emitComplete ) { this.events.push('complete'); }

    /**
     * The debug instance used for most logging.
     * @type {function}
     */
    this.debug = debugGen(this.options.debugName);

    /**
     * The debug instance used for emission of service events.
     * @type {function}
     */
    this.debugJobEvents = debugGen(this.options.debugEventsName);
  }

  /**
   * Configures and creates the Kue instance.
   * Also loads all job definitions, under definitions.
   * @param {Object} app The Feathers instance.
   */
  setup(app) {
    /**
     * The Feathers instance.
     * @type {Object}
     */
    this.app = app;

    // Create the queue instance, with config provided by Feathers if applicable.
    const serviceConfig = app.get('services');
    if( !serviceConfig || !('jobQueue' in serviceConfig) ) {
      this.config = {};
      this.queue = kue.createQueue();
    } else {
      /**
       * The section of Feathers' config that pertains to this service.
       * @type {Object}
       */
      this.config = serviceConfig.jobQueue;

      /**
       * A Kue instance.
       * @type {Object}
       */
      this.queue = kue.createQueue(serviceConfig.jobQueue);
    }

    /**
     * An alias to access the Kue jobs api.
     * @type {Object}
     */
    this.jobs = kue.Job;

    if( this.options.watchStuckJobs ) {
      this.queue.watchStuckJobs(this.options.watchStuckJobs);
    }

    this.queue.on('job complete', (id, result) => {
      this.jobs.get(id, (err, job) => {
        if( err ) {
          this.debug(`While attempting to remove job #${id}, an error was encountered:`, err); return;
        }
        this.debug(`Job #${id} of type ${job.type} ended as ${job.state()}.`);
        if( this.config.debugging >= 1 ) {
          this.debug('Results:', result);
        }

        if( this.config.debugging >= 2 ) {
          this.debug('Full stats:', 'Duration:', job.duration, 'Called with:', job.data);
        }

        job.remove(err2 => err2 ? this.debug(`While attempting to remove job #${id}, an error was encountered:`, err2) : this.debug(`removed job #${id}`));
      });
    });

    this.queue.on('error', err => {
      this.debug('Queue returned an error: ', err);
    });

    // Emit realtime events on jobs -- this will not show its prefix when received by the client.
    if( this.options.emitStart ) {
      this.queue.on('job start', (id, type) => { this.debugJobEvents('emitting start', id, type); this.emit('start', {id, type}); });
    }

    if( this.options.emitProgress ) {
      this.queue.on('job progress', (id, pct, text) => { this.debugJobEvents('emitting progress', id, pct, text); this.emit('progress', {id, pct, text}); });
    }

    if( this.options.emitFailedAttempt ) {
      this.queue.on('job failed attempt', (id, err, num) => { this.debugJobEvents('emitting failed attempt', id, err, num); this.emit('failed attempt', {id, err, num}); });
    }

    if( this.options.emitFailed ) {
      this.queue.on('job failed', (id, err) => { this.debugJobEvents('emitting failed', id, err); this.emit('failed', {id, err}); });
    }

    if( this.options.emitComplete ) {
      this.queue.on('job complete', (id, results) => { this.debugJobEvents('emitting complete', id, results); this.emit('complete', {id, results}); });
    }

    process.once('SIGTERM', () => {
      console.log('Shutting down worker queue...');
      this.queue.shutdown(5000, err => {
        console.log('Kue shutdown: ', err ? err : 'OK');
        process.exit(0);
      });
    });

    // Shutdown the process if the queue blows up. Thrown errors aren't safe in Javascript, so we have to do this.
    // We may be able to use zone.js to provide execution contexts for this later.
    if( this.options.shutdownOnException ) {
      process.once('uncaughtException', ex => {
        console.error('Shutting down from uncaught exception:', ex);
        this.queue.shutdown(1000, err => {
          console.error( 'Kue shutdown: ', err ? err : 'OK');
          process.exit(0);
        });
      });
    }

    this.loadJobDefinitions();
  }

  /**
   * Load job definitions as module from definitions/.
   * A job's type is its name, without the '.js'
   *
   * Job metadata supported:
   *
   * concurrency:
   *   a number representing how many instances of a job can run at once.
   *   If not specified, this is 1.
   *
   * schedule:
   *   A string or object supported by node-schedule to run a job regularly.
   *
   * runNow:
   *   If truthy, will run the job as soon as possible without requiring user prompting.
   *   If it's a function, your runNow function will be invoked with the typical jobContext, and the return value will be used instead.
   *   If it's not just a boolean, this value will be provided as data to the runNow instance.
   *
   * allowedCheck:
   *   If this exists, it should be a function that returns a Promise.
   *   It will be run with the job's jobContext.
   *   It will be run every time the job is invoked, and can reject the job ever being run.
   *
   * @see https://www.npmjs.com/package/node-schedule
   */
  loadJobDefinitions() {
    this.debug('Loading job definitions:');
    const runNow = [];

    fs.readdirSync(this.options.jobDefinitionPath).forEach(file => {
      const jobName = path.basename(file, '.js');
      const jobExports = require(path.format({dir: this.options.jobDefinitionPath, base: file}));
      this.jobDefs[jobName] = jobExports;
      const jobProcessArgs = [jobName];

      const jobDebug = [jobName];

      // Create a context for the job to run in.
      this.jobDefs[jobName].jobContext = Object.assign({
        jobDefs: this.jobDefs,
        app: this.app,
        config: this.config
      }, this.jobContext);

      // How many copies of the job are allowed to run at once.
      if( 'concurrency' in jobExports && jobExports.concurrency ) {
        jobDebug.push('Threads: ', jobExports.concurrency);
        jobProcessArgs.push(jobExports.concurrency);
      }

      // Using node-schedule, when to run the job.
      if( 'schedule' in jobExports && jobExports.schedule ) {
        const args = jobExports.scheduleArgs || [];
        const scheduleId = schedule.scheduleJob(jobExports.schedule, () => {
          this.create({type: jobName, data: args});
        });
        this.debug(`${jobName} scheduled for:`, jobExports.schedule);
        jobDebug.push('Schedule: ', jobExports.schedule);
        this.jobDefs[jobName].scheduleId = scheduleId;
      }

      // Should the job be run immediately as well as on-demand?
      if( 'runNow' in jobExports ) {
        let shouldRunNow = false;
        let jobData = {type: jobName};

        // Should standardize this to require a Promise later.
        if( typeof jobExports.runNow === 'function' ) {
          shouldRunNow = jobExports.runNow.bind(this.jobDefs[jobName].jobContext)();
          if( shouldRunNow !== false && shouldRunNow !== true ) {
            jobData.data = shouldRunNow;
          }
        } else if( jobExports.runNow ) {
          shouldRunNow = true;
        }

        if( shouldRunNow ) {
          jobDebug.push('Run Now: ', jobData);
          runNow.push(jobData);
        }
      }

      jobProcessArgs.push(jobExports.jobFunction.bind(this.jobDefs[jobName].jobContext));

      this.queue.process(...jobProcessArgs);

      this.debug(...jobDebug);
    });

    runNow.forEach(x => this.create(x));
  }


  /**
   * A convenience function to wrap Kue's weird functions into more API-compatible ones.
   * @param {string} type A job type.
   * @param {Object} query A query that sort of resembles Feathers' query object syntax.
   * @returns {Promise<Array>}
   */
  findByType(type, query) {
    return Promise.props( query.state.reduce((memo, stateType) => {
      memo[stateType] = new Promise((resolve, reject) =>
        this.jobs.rangeByType(type, stateType, query.$skip, query.$limit, query.sort, (err, jobs) => err ? reject(err) : resolve(jobs))
      );
      return memo;
    }, {}) );
  }

  /**
   * A convenience function to wrap Kue's weird functions into more API-compatible ones.
   * @param {string} state One of Kue's possible job states.
   * @param {Object} query A query that sort of resembles Feathers' query object syntax.
   * @returns {Promise<Array>}
   */
  findByState(state, query) {
    return new Promise((resolve, reject) =>
      this.jobs.rangeByState(state, query.$skip, query.$limit, query.sort, (err, jobs) => err ? reject(err) : resolve(jobs))
    );
  }

  /**
   * find - ask Kue for jobs matching these descriptions
   * Returns data as an array of objects, as described on Kue's page.
   * @param {Object} params property query is the useful one
   * @param {Object} params.query
   * @param {boolean|Array} params.query.type [false] If this is an array, find all jobs of these types
   * @param {Array} params.query.state [['active', 'inactive', 'complete', 'failed', 'delayed']] If type was not present, search for these states.
   * @param {number} params.query.$skip [0] Pagination parameter
   * @param {number} params.query.$limit [0] Pagination parameter
   * @param {string} params.query.sort [asc] Pagination parameter
   * @param {string} params.query.userId [false] Filterable parameter
   * @returns {Promise<Array>}
   */
  find(params) {
    let query = {
      type: false,
      state: ['active', 'inactive', 'complete', 'failed', 'delayed'],
      $skip: 0,
      $limit: 100,
      sort: 'asc',
      userId: false
    };
    Object.assign(query, params.query);

    if( !Array.isArray(query.state) ) {
      query.state = [query.state];
    }

    if(!('type' in query) && !('state' in query)) {
      return Promise.reject(new errors.BadRequest('No state or type in query'));
    }

    let promise;

    if( query.type ) {
      if( Array.isArray(query.type) ) {
        promise = Promise.props(query.type.reduce((memo, type) => {
          memo[type] = this.findByType(type, query);
          return memo;
        }, {}));
      } else {
        promise = this.findByType(query.type, query);
      }
    } else if( query.state ) {
      if( Array.isArray(query.state) ) {
        promise = Promise.props(query.state.reduce((memo, state) => {
          memo[state] = this.findByState(state, query);
          return memo;
        }, {}));
      } else {
        promise = this.findByState(query.state, query);
      }
    }

    promise = promise.then(_r => {
      let r = _r;
      if( query.userId !== false ) {
        r = r.filter(r.userId === query.userId);
      }

      // The total could easily screw this up. It's not given by Kue, so I have no way of knowing without querying over and over.
      // Patch Kue for this?
      if( !('paginate' in params) || params.paginate ) {
        r = {$limit: query.$limit, total: Object.keys(r).reduce((acc, key) => acc + r[key].length, 0), data: r};
      }

      console.log(r);

      return Promise.resolve(r);
    });

    return promise.catch(err => Promise.reject(new errors.GeneralError(err)));
  }

  /**
   * Ask Kue for a job with a specific ID
   * Returns an object of the job's data, as described on Kue's page.
   * @param {string} id The ID of the job
   * @returns {Promise<Object>}
   */
  get(id) {
    return new Promise( (resolve, reject) => this.jobs.get(id, (err, job) => err ? reject(err) : resolve(job)) );
  }

  /**
   * Make a new job
   * @param {Object|Array} data Either a job to make, or an array of them.
   * @param {string} data.type The type of job
   * @param {Object} data.data Will be passed to the job as its job.data
   * @returns {Promise<number>} The ID of the job.
   */
  create(data) {
    if(Array.isArray(data)) {
      return Promise.all(data.map(current => this.create(current)));
    }

    // the default associateCurrentUser doesn't quite get into those hard to reach spaces.
    if( data.userId != null && data.userId ) {
      if( data.data == null ) { data.data = {}; }
      data.data.userId = data.userId;
    }

    if( this.jobDefs[data.type] == null ) {
      return new errors.GeneralError('Error in loading job definition, jobDefs was not updated');
    }

    this.debug(`Creating ${data.type} job via: `, data);
    let promise = Promise.resolve();

    // If we're not allowed to queue up, check if there's already enough jobs of this type before tryng to queue another.
    if( 'allowedQueue' in this.jobDefs[data.type] && !this.jobDefs[data.type].allowedQueue ) {
      let limit = 1;
      if( 'concurrency' in this.jobDefs[data.type] && this.jobDefs[data.type].concurrency ) {
        limit = this.jobDefs[data.type].concurrency;
      }

      promise = promise
        .then(() => this.findByType(data.type))
        .then(r => r.length >= limit ? Promise.reject(new errors.Unavailable()) : Promise.resolve())
      ;
    }

    // Run any permissions checks first.
    if( 'allowedCheck' in this.jobDefs[data.type] && this.jobDefs[data.type].allowedCheck ) {
      promise = promise.then(() => this.jobDefs[data.type].allowedCheck.bind(this.jobDefs[data.type].jobContext)(data));
    }

    promise = promise.then(() => {
      const job = this.queue.create(data.type, data.data);

      if( 'ttl' in this.jobDefs[data.type] ) {
        job.ttl(this.jobDefs[data.type]);
      }

      job.save(err => {
        if( err ) { this.debug('Job creation: Error when saving job!', err); return Promise.reject(err); }
        this.debug(`Job creation: success, with id ${job.id}!`); return Promise.resolve(job.id);
      });
    });

    return promise;
  }

  /**
   * do nothing!
   * @ignore
   */
  update(id, data) {
    return Promise.resolve(data);
  }

  /**
   * do nothing!
   * @ignore
   */
  patch(id, data) {
    return Promise.resolve(data);
  }

  /**
   * do nothing! Well not really nothing, but this is basically useless.
   * @ignore
   */
  remove(id) {
    return new Promise((resolve, reject) => {
      this.jobs.remove(id, (err) => {
        if( err ) { return reject(err); }
        return resolve();
      });
    });
  }
}

module.exports = JobQueueService;
