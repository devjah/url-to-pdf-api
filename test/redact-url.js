/* eslint-env mocha */

const chai = require('chai');
const redactUrl = require('../src/util/redact-url');

describe('redactUrl', () => {
  it('drops the query string that carries the api_token', () => {
    chai.expect(redactUrl('https://app.example.com/evaluations/1/pdf?api_token=secret&layout=pdf'))
      .to.equal('https://app.example.com/evaluations/1/pdf');
  });

  it('never echoes a value it cannot parse', () => {
    chai.expect(redactUrl('not a url?api_token=secret')).to.equal('<unparseable url>');
  });
});
