import Ember from 'ember';
import Application from '../../app';
import Router from '../../router';
import config from '../../config/environment';

// register helper;

Ember.Test.registerAsyncHelper('andLater',
  function(app, callback, timeout) {
    Ember.run(function() {
      Ember.run.later(function() {
        callback();
      }, timeout || 500);
    });
  }
);

var setOnlineStatusFn = function() {
  var mockId;

  return function(app, status) {
    if(status) {
      Ember.$.mockjax.clear(mockId);
    } else {
      mockId = Ember.$.mockjax({
        status:       0,
        url:          /.*/,
        responseTime: 0,
      });
    }
  };
}();

Ember.Test.registerHelper('setOnlineStatus', setOnlineStatusFn);

export default function startApp(attrs) {
  var application;

  var attributes = Ember.merge({}, config.APP);
  attributes = Ember.merge(attributes, attrs); // use defaults, but you can override;

  Ember.run(function() {
    application = Application.create(attributes);
    application.setupForTesting();
    application.injectTestHelpers();
  });

  return application;
}
