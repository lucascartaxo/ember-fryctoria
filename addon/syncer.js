import Ember from 'ember';
import generateUniqueId           from './utils/generate-unique-id';
import reloadLocalRecords         from './utils/reload-local-records';
import isModelInstance            from './utils/is-model-instance';

var RSVP = Ember.RSVP;

/**
  We save offline jobs to localforage and run them one at a time when online

  Job schema:
  ```
  {
    id:        { String },
    operation: { 'createRecord'|'updateRecord'|'deleteRecord' },
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
  db: null,
  // initialize jobs since jobs may be used before we fetch from localforage
  jobs: [],
  remoteIdRecords: [],

  /**
   * Initialize db.
   *
   * Initialize jobs, remoteIdRecords.
   *
   * @method init
   * @private
   */
  init: function() {
    var syncer = this;

    var localStore   = syncer.get('container').lookup('store:local');
    var localAdapter = localStore.get('adapter');

    syncer.set('db',           window.localforage);
    syncer.set('localStore',   localStore);
    syncer.set('localAdapter', localAdapter);

    // NOTE: get remoteIdRecords first then get jobs,
    // since jobs depend on remoteIdRecords
    syncer.getAll('remoteIdRecord').then(
      syncer.getAll.bind(syncer, 'job')
    );
  },

  /**
   * Save an offline job to localforage, this is used in DS.Model.save
   *
   * @method createJob
   * @public
   * @param {String} operation
   * @param {DS.Snapshot} snapshot
   * @return {Promise} jobs
   */
  createJob: function(operation, snapshot) {
    var typeName = snapshot.typeKey;
    var serializer = this.get('mainStore').serializerFor(typeName);
    snapshot.fryctoria = true;

    return this.create('job', {
      id:        generateUniqueId('job'),
      operation: operation,
      typeName:  typeName,
      record:    serializer.serialize(snapshot, {includeId: true}),
      createdAt: (new Date()).getTime(),
    });
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
    return this.runAllJobs();
  },

  /**
   * TODO:
   * Save all records in the store into localforage.
   *
   * @method syncDown
   * @public
   * @param {String|DS.Model|Array} typeName, record, records
   * @return {Promie}
   */
  syncDown: function(descriptor) {
    var syncer = this;

    if(typeof descriptor === 'string') {
      return reloadLocalRecords(syncer.get('container'), descriptor);

    } else if(isModelInstance(descriptor)) {
      return syncer.syncDownRecord(descriptor);

    } else if(Ember.isArray(descriptor)) {
      var updatedRecords = descriptor.map(function(record) {
        return syncer.syncDownRecord(record);
      });
      return RSVP.all(updatedRecords);

    } else {
      throw new Error('Input can only be a string, a DS.Model or an array of DS.Model, but is ' + descriptor);
    }
  },

  /**
   * Reset syncer and localforage records.
   * Remove all jobs and remoteIdRecords.
   * Remove all records in localforage.
   *
   * @method
   * @public
   */
  reset: function() {
    return RSVP.all([
      this.deleteAll('job'),
      this.deleteAll('remoteIdRecord'),
      this.get('localAdapter').clear()
    ]);
  },

  /**
   * Decide if the error indicates offline
   *
   * @method
   * @public
   */
  isOffline: function(error) {
    return error && error.status === 0;
  },

  /**
   * This method does not talk to remote store, it only need to get serializer
   * from a store.
   *
   * @method
   * @private
   */
  syncDownRecord: function(record) {
    var localStore   = this.get('localStore');
    var localAdapter = this.get('localAdapter');
    var snapshot     = record._createSnapshot();

    if(record.get('isDeleted')) {
      return localAdapter.deleteRecord(localStore, snapshot.type, snapshot);
    } else {
      return localAdapter.createRecord(localStore, snapshot.type, snapshot);
    }
  },

  /**
   * Attampt to run all the jobs one by one. Deal with syncing failure.
   *
   * @method runAllJobs
   * @private
   * @return {Promise}
   */
  runAllJobs: function() {
    var syncer = this;
    var jobs = this.get('jobs');

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
      syncer.deleteAll('remoteIdRecord');
      Ember.Logger.info('Syncing succeed.');
    })

    .catch(function(error) {
      if(syncer.isOffline(error)) {
        Ember.Logger.info('Can not connect to server, stop syncing');
      } else if(syncer.handleSyncUpError){
        return syncer.handleSyncUpError(error);
      } else {
        return RSVP.reject(error);
      }
    });
  },

  runJob: function(job) {
    var syncer     = this;

    var store      = syncer.get('mainStore');

    var typeName   = job.typeName;
    var type       = store.modelFor(typeName);

    var adapter    = store.adapterFor(typeName);
    var remoteCRUD = adapter.get('fryctoria');

    var record     = createRecordFromJob(syncer, job, type);
    var snapshot   = record._createSnapshot();

    var operation  = job.operation;

    var syncedRecord;

    if(operation === 'deleteRecord') {
      syncedRecord = remoteCRUD.deleteRecord.call(adapter, store, type, snapshot);

    } else if(operation === 'updateRecord') {
      // TODO: make reverse update possible
      // for now, we do not accept 'reverse update' i.e. update from the server
      // will not be reflected in the store
      syncedRecord = remoteCRUD.updateRecord.call(adapter, store, type, snapshot);

    } else if(operation === 'createRecord') {
      // TODO: make reverse update possible
      // for now, we do not accept 'reverse update' i.e. update from the server
      // will not be reflected in the store
      var recordIdBeforeCreate = record.get('id');
      record.set('id', null);
      snapshot = record._createSnapshot();

      // adapter -> store -> syncer(remoteId) -> localforage
      syncedRecord = remoteCRUD.createRecord.call(adapter, store, type, snapshot)
        .then(updateIdInStore)
        .then(createRemoteIdRecord)
        .then(refreshLocalRecord);
    }

    // delete from db after syncing success
    return syncedRecord.then(function() {
      return syncer.deleteById('job', job.id);
    });

    function updateIdInStore(payload) {
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
      return syncer.create('remoteIdRecord', {
        typeName: typeName,
        localId:  recordIdBeforeCreate,
        remoteId: recordExtracted.id
      }).then(function() {
        return recordExtracted;
      });
    }

    // This method does not talk to store, only to adapter
    function refreshLocalRecord(recordExtracted) {
      // NOTE: we should pass snapshot instead of rawRecord to deleteRecord,
      // in deleteRecord, we only call snapshot.id, we can just pass the
      // rawRecord to it.

      // delete existing record with localId
      var localStore   = syncer.get('localStore');
      var localAdapter = syncer.get('localAdapter');

      return localAdapter.deleteRecord(
        localStore, type, {id: recordIdBeforeCreate}
      ).then(function() {

        // create new record with remoteId
        record.set('id', recordExtracted.id);
        var snapshot = record._createSnapshot();
        return localAdapter.createRecord(localStore, type, snapshot);
      });
    }
  },

  // lazy evaluate main store, since main store is initialized after syncer
  mainStore: Ember.computed(function() {
    return this.get('container').lookup('store:main');
  }),

  getRemoteId: function(typeName, id) {
    Ember.assert('Id can not be blank.', !Ember.isNone(id));

    if(isRemoteId(id)) {
      return id;
    }

    // Try to find a remote id from local id
    // NOTE: it is possible we are trying to create one record in local
    // and does not have a remote id yet.
    var remoteIdRecord = this.get('remoteIdRecords').find(function(record) {
      return record.typeName === typeName && record.localId === id;
    });

    return remoteIdRecord ? remoteIdRecord.remoteId : id;
  },

  // CRUD for jobs and remoteIdRecords
  getAll: function(typeName) {
    var syncer = this;
    var namespace = getNamespace(typeName);

    return syncer.get('db').getItem(namespace).then(function(records) {
      records = records || [];
      syncer.set(pluralize(typeName), records);
      return records;
    });
  },

  deleteAll: function(typeName) {
    return this.saveAll(typeName, []);
  },

  deleteById: function(typeName, id) {
    var records = this.get(pluralize(typeName)).filter(function(record) {
      return id !== record.id;
    });

    return this.saveAll(typeName, records);
  },

  create: function(typeName, record) {
    var records = this.get(pluralize(typeName));
    records.push(record);

    return this.saveAll(typeName, records);
  },

  saveAll: function(typeName, records) {
    this.set(pluralize(typeName), records);

    var namespace = getNamespace(typeName);
    return this.get('db').setItem(namespace, records);
  },
});

function pluralize(typeName) {
  return typeName + 's';
}

function getNamespace(typeName) {
  var LocalForageKeyHash = {
    'job':            'EmberFryctoriaJobs',
    'remoteIdRecord': 'EmberFryctoriaRemoteIdRecords',
  };
  return LocalForageKeyHash[typeName];
}

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
  var mainStore = syncer.get('mainStore');

  return mainStore.getById(type.typeKey, id) ||
         createRecordInLocalStore(syncer, type, id);
}


function createRecordInLocalStore(syncer, type, id) {
  // after create, the state becomes "root.empty"
  var record = type._create({
    id:        id,
    store:     syncer.get('localStore'),
    container: syncer.get('container'),
  });

  // after setupData, the state becomes "root.loaded.saved"
  record.setupData({});
  return record;
}
