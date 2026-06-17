import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSingleStatement, classifySql, sqlErrorResult, SqlValidationError } from '../../src/sql-validator.js';

test('allows single SQL without semicolon', () => {
  assert.equal(ensureSingleStatement('select 1'), 'select 1');
});

test('allows one trailing semicolon', () => {
  assert.equal(ensureSingleStatement('select 1;'), 'select 1');
});

test('allows semicolon inside single quoted string', () => {
  assert.equal(ensureSingleStatement("select ';' as semi"), "select ';' as semi");
});

test('allows semicolon inside double quoted identifier or string', () => {
  assert.equal(ensureSingleStatement('select ";" as semi'), 'select ";" as semi');
});

test('rejects multiple statements', () => {
  assert.throws(() => ensureSingleStatement('select 1; select 2'), /Only one SQL statement is allowed/);
});

test('classifies query SQL', () => {
  assert.equal(classifySql('select 1'), 'query');
  assert.equal(classifySql('with x as (select 1) select * from x'), 'query');
  assert.equal(classifySql('show tables'), 'query');
  assert.equal(classifySql('desc user_table'), 'query');
  assert.equal(classifySql('explain select 1'), 'query');
});

test('classifies update SQL', () => {
  assert.equal(classifySql('insert into t values (1)'), 'update');
  assert.equal(classifySql('update t set a = 1'), 'update');
  assert.equal(classifySql('delete from t'), 'update');
  assert.equal(classifySql('merge into t using s on (t.id=s.id) when matched then update set t.a=s.a'), 'update');
  assert.equal(classifySql('create table t (id int)'), 'update');
});

test('classifies query SQL with leading comments', () => {
  assert.equal(classifySql('/* comment */ select 1'), 'query');
  assert.equal(classifySql('-- comment\nselect 1'), 'query');
  assert.equal(classifySql('-- comment\n-- another\nselect 1'), 'query');
  assert.equal(classifySql('/* multi\nline */ select 1'), 'query');
  assert.equal(classifySql('  /* comment */  with x as (select 1) select * from x'), 'query');
});

test('classifies update SQL with leading comments', () => {
  assert.equal(classifySql('/* comment */ insert into t values (1)'), 'update');
  assert.equal(classifySql('-- comment\nupdate t set a = 1'), 'update');
  assert.equal(classifySql('/* hint */ delete from t'), 'update');
});

test('sqlErrorResult returns error result without alias', () => {
  const error = new SqlValidationError('test error');
  const result = sqlErrorResult(error);
  assert.deepEqual(result, {
    success: false,
    error: {
      type: 'SqlValidationError',
      message: 'test error'
    }
  });
});

test('sqlErrorResult returns error result with alias', () => {
  const error = new SqlValidationError('test error');
  const result = sqlErrorResult(error, 'myAlias');
  assert.deepEqual(result, {
    success: false,
    error: {
      type: 'SqlValidationError',
      message: 'test error'
    },
    alias: 'myAlias'
  });
});
