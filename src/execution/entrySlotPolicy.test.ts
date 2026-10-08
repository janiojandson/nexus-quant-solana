import test from 'node:test';
import assert from 'node:assert/strict';
import { EntrySlotPolicy } from './entrySlotPolicy.js';
test('two DEX slots and two reserved Sentinel slots cannot borrow from each other',()=>{
  const slots=new EntrySlotPolicy();
  assert.equal(slots.reserve('a','DEX',[]),true);
  assert.equal(slots.reserve('b','DEX',[]),true);
  assert.equal(slots.reserve('c','DEX',[]),false);
  assert.equal(slots.reserve('c','SENTINEL',[]),true);
  assert.equal(slots.reserve('d','SENTINEL',[]),true);
  assert.equal(slots.reserve('e','SENTINEL',[]),false);
});
test('reservation prevents simultaneous entry of the same mint across scanners',()=>{
  const slots=new EntrySlotPolicy();
  slots.reserve('a','DEX',[]);
  assert.equal(slots.reserve('a','SENTINEL',[]),false);
  slots.release('a');
  assert.equal(slots.reserve('a','SENTINEL',[]),true);
  assert.equal(slots.reserve('a','DEX',[{mint:'a',entrySource:'SENTINEL'}]),false);
});

test('capital reservations exclude the current candidate and do not double count an opened position',()=>{
  const slots=new EntrySlotPolicy();slots.reserve('dex','DEX',[]);slots.reserve('sentinel','SENTINEL',[]);
  assert.deepEqual(slots.unfilledReservations([],'dex'),['sentinel']);
  assert.deepEqual(slots.unfilledReservations([{mint:'sentinel',entrySource:'SENTINEL'}],'dex'),[]);
  assert.equal(slots.count('SENTINEL',[{mint:'sentinel',entrySource:'SENTINEL'}]),1);
});
