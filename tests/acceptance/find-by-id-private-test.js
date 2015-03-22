/* jshint expr:true */
import {
  describe,
  it,
  beforeEach,
  afterEach
} from 'mocha';
import { expect } from 'chai';
import Ember from 'ember';
import startApp from '../helpers/start-app';

var App;

describe('Acceptance: Find By Id(Private)', function() {
  beforeEach(function() {
    App = startApp();
  });

  afterEach(function() {
    Ember.run(App, 'destroy');
  });

  it('works when offline', function(done) {
    visit('/fetch-all');

    click('button:contains("Offline")');

    visit('/');
    visit('/find-by-id-private');

    click('button:contains("Online")');

    andThen(function() {
      expect(currentPath()).to.equal('find-by-id-private');
      expect(find('#name').text().length).to.be.above(0);
      done();
    });
  });
});
