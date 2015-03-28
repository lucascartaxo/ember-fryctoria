import Ember             from 'ember';
import isOffline         from './is-offline';
import generateUniqueId  from './generate-unique-id';
import createRecordInLocalAdapter from './create-record-in-local-adapter';
import reloadLocalRecords from './reload-local-records';

var RSVP = Ember.RSVP;

/**
  We save offline jobs to localforage and run them one at a time when online

  Job schema:
  ```
  {
    id:        { String },
    operation: { 'create'|'update'|'delete' },
    typeName:  { String },
    record:    { Object },
    createdAt: { Date },
  }
  ```

  We save remoteIdRecords to localforage. They are used to lookup remoteIds
  from localIds.

  RecordId schema:
  ```
  {
    typeName: { String },
    localId:  { String },
    remoteId: { String }
  }
 ```

 @class Syncer
 @extends Ember.Object
 */
export default Ember.Object.extend({
  /**
   * @property db
   * @type Localforage
   * @private
   */
  db: null,

  /**
   * @property jobs
   * @type Array
   * @private
   */
  jobs: null,

  /**
   * @property remoteIdRecords
   * @type Array
   * @private
   */
  remoteIdRecords: null,

  /**
   * Initialize db.
   *
   * Initialize jobs, remoteIdRecords. Either from localforage or emmpty array.
   *
   * @method init
   * @private
   */
  init: function() {
    var syncer = this;

    syncer.set('db', window.localforage);

    // initialize jobs cache in syncer
    // jobs may be used before we fetch jobs from localforage
    syncer.set('jobs', []);
    syncer.set('remoteIdRecords', []);

    // NOTE: get remoteIdRecords first then get jobs,
    // since jobs depend on remoteIdRecords
    syncer.fetchRemoteIdRecords()
      .then(function(records)  { syncer.set('remoteIdRecords', records); })
      .then(function()     { return syncer.fetchJobs();      })
      .then(function(jobs) { syncer.set('jobs', jobs);       });
  },

  /**
   * Save an offline job to localforage, this is used in DS.Model.save
   *
   * @method createJob
   * @public
   * @param {String} operation 'create'|'update'|'delete'
   * @param {String} typeName
   * @param {DS.Model} record
   * @return {Promise} jobs
   */
  createJob: function(operation, typeName, record) {
    var syncer = this;
    var jobs = this.get('jobs');

    jobs.pushObject({
      id:        generateUniqueId(),
      operation: operation,
      typeName:  typeName,
      record:    record,
      createdAt: (new Date()).getTime(),
    });

    return syncer.persistJobs(jobs);
  },

  /**
   * Run all the jobs to sync up. If there is an error while syncing, it will
   * only log the error instead of return a rejected promise. This is called in
   * all the methods in DS.Store and DS.Model that talk to the server.
   *
   * @method syncUp
   * @public
   * @return {Promise} this promise will always resolve.
   */
  syncUp: function() {
    return this.runAllJobs().catch(function(error) {
      Ember.Logger.warn('Syncing Error:');
      Ember.Logger.error(error && error.stack);
    });
  },

  /**
   * TODO: test this.
   * Save all records in the store into localforage.
   *
   * @method syncDown
   * @public
   * @param {String} typeName
   * @return {Promie}
   */
  syncDown: function(typeName) {
    var syncer = this;

    if(typeName) {
      return reloadLocalRecords(syncer.get('container'), typeName);
    } else {
      // TODO: get all types and loop through them.
      return RSVP.resolve();
    }
  },

  /**
   * Attampt to run all the jobs one by one. It will stop when all jobs are
   * processed or one of the three errors:
   * 1. offline: resolve
   * 2. 'clear': clear all the jobs and resolve
   * 3. other error: reject
   *
   * @method runAllJobs
   * @private
   * @return {Promise}
   */
  runAllJobs: function() {
    var syncer = this;
    var jobs = this.get('jobs');

    // use online adapter
    syncer.lookupStore('main').set('fryctoria.isOffline', false);

    if(jobs.length === 0) {
      Ember.Logger.info('Syncing jobs are empty.');
      return RSVP.resolve();
    }

    Ember.Logger.info('Syncing started.');
    jobs = jobs.sortBy('createdAt');

    // run jobs one at a time
    return jobs.reduce(function(acc, job) {
      return acc.then(function() {
        return syncer.runJob(job);
      });
    }, RSVP.resolve())

    .then(function() {
      syncer.deleteAllRemoteIdRecords();
    })

    .then(function() {
      Ember.Logger.info('Syncing succeed.');
    })

    .catch(function(error) {
      if(isOffline(error && error.status)) {
        Ember.Logger.info('Can not connect to server, stop syncing');
      } else if(error === 'clear'){
        return syncer.deleteAllJobs();
      } else {
        return RSVP.reject(error);
      }
    });
  },

  runJob: function(job) {
    var syncer     = this;

    var store      = syncer.lookupStore('main');

    var typeName   = job.typeName;
    var type       = store.modelFor(typeName);

    var adapter    = store.adapterFor(typeName);

    var record     = createRecordFromJob(syncer, job, type);
    var snapshot   = record._createSnapshot();

    var operation  = job.operation;

    var syncedRecord;

    if(operation === 'delete') {
      syncedRecord = adapter.deleteRecord(store, type, snapshot);

    } else if(operation === 'update') {
      // TODO: make reverse update possible
      // for now, we do not accept 'reverse update' i.e. update from the server
      // will not be reflected in the store
      syncedRecord = adapter.updateRecord(store, type, snapshot);

    } else if(operation === 'create') {
      // TODO: make reverse update possible
      // for now, we do not accept 'reverse update' i.e. update from the server
      // will not be reflected in the store
      var recordIdBeforeCreate = record.get('id');
      record.set('id', null);
      snapshot = record._createSnapshot();

      syncedRecord = adapter.createRecord(store, type, snapshot)
        .then(updateIdInStore)
        .then(createRemoteIdRecord)
        .then(refreshLocalRecord)
        .catch(function(error) {
          if(isOffline(error && error.status)) {
            return RSVP.reject(error);
          } else if(syncer.syncErrorHandler) {
            return syncer.syncErrorHandler(error);
          } else {
            return RSVP.reject(error);
          }
        });
    }

    // delete from db after syncing success
    return syncedRecord.then(
      syncer.deleteJobById.bind(this, job.id)
    );

    function updateIdInStore(payload) {
      // NOTE: We should be in online mode now
      var recordExtracted = store.serializerFor(type).extract(
        store, type, payload, record.get('id'), 'single'
      );

      var recordInStore = store.getById(typeName, recordIdBeforeCreate);

      // INFO: recordInStore may be null because it may be deleted
      if(recordInStore) {
        recordInStore.set('id', null);
        store.updateId(recordInStore, recordExtracted);
      }

      return recordExtracted;
    }

    function createRemoteIdRecord(recordExtracted) {
      return syncer.createRemoteIdRecord({
        typeName: typeName,
        localId:  recordIdBeforeCreate,
        remoteId: recordExtracted.id
      }).then(function() {
        return recordExtracted;
      });
    }

    function refreshLocalRecord(recordExtracted) {
      // NOTE: we should pass snapshot instead of rawRecord to deleteRecord,
      // in deleteRecord, we only call snapshot.id, we can just pass the
      // rawRecord to it.

      // delete existing record with localId
      var localStore   = syncer.lookupStore('local');
      var localAdapter = localStore.get('adapter');
      return localAdapter.deleteRecord(
        localStore, type, {id: recordIdBeforeCreate}

      ).then(function() {
        // create new record with remoteId
        record.set('id', recordExtracted.id);
        return createRecordInLocalAdapter(store, type, record);

      });
    }
  },

  lookupStore: function(storeName) {
    return this.get('container').lookup('store:' + storeName);
  },

  getRemoteId: function(typeName, id) {
    if(!id) {
      Ember.Logger.error('id can not be blank.');
    }

    if(isRemoteId(id)) {
      // id is remote already
      return id;

    } else {
      // try to find a remote id
      var remoteIdRecord = this.get('remoteIdRecords').find(function(record) {
        return record.typeName === typeName && record.localId === id;
      });

      // NOTE: it is possible we are trying to create one record
      // and does not have a remote id.
      return remoteIdRecord ? remoteIdRecord.remoteId : id;
    }
  },

  // database crud
  remoteIdRecordsNamespace: 'EmberFryctoriaRemoteIdRecords',

  fetchRemoteIdRecords: function() {
    return this.get('db')
               .getItem(this.get('remoteIdRecordsNamespace'))
               .then(function(records) { return records || []; });
  },

  createRemoteIdRecord: function(record) {
    var remoteIdRecords = this.get('remoteIdRecords');
    remoteIdRecords.push(record);
    return this.persistRemoteIdRecords(remoteIdRecords);
  },

  deleteAllRemoteIdRecords: function() {
    this.set('remoteIdRecords', []);
    return this.persistRemoteIdRecords([]);
  },

  persistRemoteIdRecords: function(records) {
    return this.persistNamespace(this.get('remoteIdRecordsNamespace'), records);
  },

  jobsNamespace: 'EmberFryctoriaJobs',

  deleteJobById: function(id) {
    var syncer = this;
    var jobs = this.get('jobs');

    jobs = jobs.filter(function(job) {
      return id !== job.id;
    });

    // TODO: use popObject which is more performant
    syncer.set('jobs', jobs);
    return syncer.persistJobs(jobs);
  },

  deleteAllJobs: function() {
    this.set('jobs', []);
    return this.persistJobs([]);
  },

  fetchJobs: function() {
    return this.get('db')
               .getItem(this.get('jobsNamespace'))
               .then(function(jobs) { return jobs || []; });
  },

  persistJobs: function(jobs) {
    return this.persistNamespace(this.get('jobsNamespace'), jobs);
  },

  persistNamespace: function(namespace, data) {
    return this.get('db').setItem(namespace, data);
  },
});

function isRemoteId(id) {
  return id.indexOf('fryctoria') !== 0;
}

function createRecordFromJob(syncer, job, type) {
  var remoteId = syncer.getRemoteId(job.typeName, job.record.id);
  var record   = createRecordInLocalStore(syncer, type, remoteId);

  record.setupData(job.record);
  record.eachRelationship(function(name, descriptor) {
    addRelationshipToRecord(name, descriptor, job.record, record, syncer);
  }); // load relationships

  return record;
}

function addRelationshipToRecord(name, descriptor, jobRecord, record, syncer) {
  var relationship = jobRecord[name];
  var relationshipId, relationshipIds;
  var relationshipTypeName = descriptor.type.typeKey;

  if(!relationship) { return; }

  if(descriptor.kind === 'belongsTo') {
    var belongsToRecord;
    // belongsTo
    relationshipId = relationship;
    relationshipId = syncer.getRemoteId(relationshipTypeName, relationshipId);
    // NOTE: It is possible that the association is deleted in the store
    // and getById is null, so we create a fake record with the right id
    belongsToRecord = getOrCreateRecord(syncer, descriptor.type, relationshipId);
    record.set(name, belongsToRecord);

  } else if(descriptor.kind === 'hasMany') {
    var hasManyRecords;
    // hasMany
    relationshipIds = relationship || [];
    hasManyRecords = relationshipIds.map(function(id) {
      var remoteId = syncer.getRemoteId(relationshipTypeName, id);
      return getOrCreateRecord(syncer, descriptor.type, remoteId);
    });
    record.get(descriptor.key).pushObjects(hasManyRecords);
  }
}

function getOrCreateRecord(syncer, type, id) {
  var store = syncer.lookupStore('main');

  return store.getById(type.typeKey, id) ||
         createRecordInLocalStore(syncer, type, id);
}


function createRecordInLocalStore(syncer, type, id) {
  // after create, the state becomes "root.empty"
  var record = type._create({
    id:        id,
    store:     syncer.lookupStore('local'),
    container: syncer.get('container'),
  });

  // after setupData, the state becomes "root.loaded.saved"
  record.setupData({});
  return record;
}
