import DS        from 'ember-data';
import LFAdapter from 'ember-localforage-adapter/adapters/localforage';
import Ember     from 'ember';
import isOffline from './is-offline';

var Promise = Ember.RSVP.Promise;

export default DS.Store.extend({
  fryctoria: {
    useLocalAdapter: false,
    localAdapter:    null,
    trashStore:      null,
  },

  init: function() {
    var localAdapter = LFAdapter.create({ container: this.get('container') });
    var trashStore   = DS.Store.extend({ container: this.get('container') }).create();

    this.set('fryctoria.localAdapter', localAdapter);
    this.set('fryctoria.trashStore',   trashStore);

    this._super.apply(this, arguments);
  },

  fetchAll: function(type) {
    // this._super can not be called twice, we save the REAL super here
    var store          = this;
    var _superFetchAll = this.__nextSuper;
    var _arguments     = arguments;


    return store.get('syncer').syncUp(store)
      .then(function() {
        return _superFetchAll.call(store, type);
      })
      .then(function(records) {
        reloadLocalRecords(store, type, records);
        return records;
      })
      .catch(function(error) {
        return useLocalIfOffline(error, store, _superFetchAll, _arguments);
      });
  },

  fetchById: function(type /* , id, preload */ ) {
    var store           = this;
    var _superFetchById = this.__nextSuper;
    var _arguments      = arguments;

    return store.get('syncer').syncUp(store)
      .then(function() {
        return _superFetchById.apply(store, _arguments);
      })
      .then(function(record) {
        createLocalRecord(store, type, record);
        return record;
      })
      .catch(function(error) {
        return useLocalIfOffline(error, store, _superFetchById, _arguments);
      });
  },

  /**
   * Overwrite adapterFor so that we can use localAdapter when necessary
   *
   * TODO:
   * Do not relay on this, instead manully fetching and extracting records from
   * localforage!
   */
  adapterFor: function(type) {
    // console.log(
    //   'fryctoria.useLocalAdapter',
    //   this.get('fryctoria.useLocalAdapter')
    // );
    if(this.get('fryctoria.useLocalAdapter')) {
      return this.get('fryctoria.localAdapter');
    } else {
      return this._super.call(this, type);
    }
  }
});

function useLocalIfOffline(error, store, _superFn, _arguments) {
  if(isOffline(error && error.status)) {
    store.set('fryctoria.useLocalAdapter', true);
    return _superFn.apply(store, _arguments).then(
      function(result) {
        return result;
      },
      function(error) {
        return Promise.reject(error);
      }
    );
  } else {
    return Promise.reject(error);
  }
}

function reloadLocalRecords(store, type, records) {
  var localAdapter = store.get('fryctoria.localAdapter');
  var trashStore   = store.get('fryctoria.trashStore');
  var modelType    = store.modelFor(type);

  localAdapter.findAll(trashStore, modelType)
    .then(deleteAll)
    .then(createAll);

  return records;

  function deleteAll(previousRecords) {
    return previousRecords.map(function(rawRecord) {
      var record = Ember.Object.create(rawRecord);
      return localAdapter.deleteRecord(trashStore, modelType, record);
    });
  }

  function createAll(previousRecords) {
    Promise.all(previousRecords).then(function() {
      records.forEach(function(record) {
        if(record.get('id')) {
          localAdapter.createRecord(trashStore, modelType, record);
        } else {
          var recordName = record.constructor && record.constructor.typeKey;
          var recordData = record.toJSON && record.toJSON();
          Ember.Logger.warn(
            'Record ' + recordName + ' does not have an id: ',
            recordData
          );
        }
      });
    });
  }
}

function createLocalRecord(store, type, record) {
  var localAdapter = store.get('fryctoria.localAdapter');
  var trashStore   = store.get('fryctoria.trashStore');
  var modelType    = store.modelFor(type);
  localAdapter.createRecord(trashStore, modelType, record);
}
